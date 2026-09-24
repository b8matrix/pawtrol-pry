// The token vault: sensitive values are swapped for opaque tokens such as
// <CRED_1> before any text leaves the device, and swapped back only at the
// moment a tool call executes locally. The vault lives in worker memory and is
// cleared at the end of every run.

import { EXTRA_INDIAN_IDS } from "../../shared/indian-ids";
import type { Detection, PageElement, PageSnapshot } from "../../shared/types";

export type VaultKind = "face" | "credential" | "id_number" | "api_key" | "pii_text";

export interface VaultEntry {
  token: string;
  original: string;
  kind: VaultKind;
  createdAt: number;
}

export interface TokenSummary {
  token: string;
  kind: VaultKind;
  sample: string;
}

const TOKEN_PREFIX: Record<VaultKind, string> = {
  face: "FACE",
  credential: "CRED",
  id_number: "ID",
  api_key: "KEY",
  pii_text: "PII",
};

const TOKEN_ANYWHERE = /<[A-Z]+_\d+>/;
const TOKEN_GLOBAL = /<[A-Z]+_\d+>/g;
const TOKEN_EXACT = /^<[A-Z]+_\d+>$/;

/** Only vault values at least this long are redacted back out of free text. */
const MIN_REDACT_LENGTH = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every occurrence of `value` in `text` with `token`. Purely alphabetic
 * values are word-bounded so "Ann" does not match inside "Annual".
 *
 * The legacy bundle used `(match, lead) => lead + token` for both regex shapes;
 * without a capture group `lead` is the match offset, which glued digits onto
 * the token ("Card 5<CRED_1>"). Only a string capture is treated as a prefix.
 */
export function replaceValue(text: string, value: string, token: string): string {
  const escaped = escapeRegExp(value);
  if (/^[A-Za-z ]+$/.test(value)) {
    const bounded = new RegExp(`(^|[^A-Za-z])${escaped}(?=$|[^A-Za-z])`, "g");
    return text.replace(bounded, (_m, lead: string) => `${lead}${token}`);
  }
  return text.replace(new RegExp(escaped, "g"), () => token);
}

export class TokenVault {
  private vault = new Map<string, VaultEntry>();
  private counters: Partial<Record<string, number>> = {};

  tokenize(original: string, kind: VaultKind): string {
    const existing = this.findToken(original);
    if (existing) return existing.token;
    const prefix = TOKEN_PREFIX[kind] ?? "PII";
    const next = (this.counters[prefix] ?? 0) + 1;
    this.counters[prefix] = next;
    const token = `<${prefix}_${next}>`;
    this.vault.set(token, { token, original, kind, createdAt: Date.now() });
    return token;
  }

  resolve(token: string): string | undefined {
    return this.vault.get(token)?.original;
  }

  containsTokens(text: string): boolean {
    return TOKEN_ANYWHERE.test(text);
  }

  resolveAll(text: string): string {
    return text.replace(TOKEN_GLOBAL, (token) => this.resolve(token) ?? token);
  }

  findToken(original: string): VaultEntry | undefined {
    for (const entry of this.vault.values()) if (entry.original === original) return entry;
    return undefined;
  }

  getEntries(): VaultEntry[] {
    return Array.from(this.vault.values());
  }

  /** Tokenize obvious secrets in free text typed by the user. */
  tokenizePrompt(text: string): { sanitized: string; tokenCount: number } {
    let sanitized = text;
    let tokenCount = 0;
    sanitized = sanitized.replace(/\b(?:\d[ -]*?){13,19}\b/g, (m) => (tokenCount++, this.tokenize(m.trim(), "credential")));
    sanitized = sanitized.replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, (m) => (tokenCount++, this.tokenize(m.trim(), "id_number")));
    sanitized = sanitized.replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, (m) => (tokenCount++, this.tokenize(m, "id_number")));
    for (const { pattern, validate } of EXTRA_INDIAN_IDS) {
      sanitized = sanitized.replace(new RegExp(pattern.source, pattern.flags + "g"), (m) =>
        validate && !validate(m) ? m : (tokenCount++, this.tokenize(m, "id_number")),
      );
    }
    sanitized = sanitized.replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      (m) => (tokenCount++, this.tokenize(m, "credential")),
    );
    sanitized = sanitized.replace(
      /(?:password|pwd|secret|key|token)[:=]\s*(?:["']([^"']+)["']|(\S+))/gi,
      (whole, quoted: string | undefined, bare: string | undefined) => {
        const secret = quoted ?? bare;
        if (!secret) return whole;
        tokenCount++;
        return whole.replace(secret, this.tokenize(secret, "credential"));
      },
    );
    return { sanitized, tokenCount };
  }

  tokenizeSnapshot<T extends Pick<PageSnapshot, "elements" | "text">>(snapshot: T): T & { tokenCount: number } {
    let tokenCount = 0;
    const elements = snapshot.elements.map((element) => {
      const copy = { ...element };
      if (copy.value && this.shouldTokenizeValue(copy)) {
        copy.value = this.tokenize(copy.value, "credential");
        tokenCount++;
      }
      return copy;
    });
    let text = snapshot.text;
    const patterns: { pattern: RegExp; kind: VaultKind }[] = [
      { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, kind: "id_number" },
      { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g, kind: "id_number" },
      { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, kind: "id_number" },
    ];
    for (const { pattern, kind } of patterns) text = text.replace(pattern, (m) => (tokenCount++, this.tokenize(m, kind)));
    return { ...snapshot, elements, text, tokenCount };
  }

  /** Replace every detected value (in element values and page text) with its token. */
  tokenizeDetections<T extends Pick<PageSnapshot, "elements" | "text">>(
    snapshot: T,
    detections: Detection[],
  ): T & { tokenCount: number } {
    const elements = snapshot.elements.map((element) => ({ ...element }));
    const byId = new Map(elements.map((element) => [element.id, element]));
    let text = snapshot.text;
    let tokenCount = 0;

    for (const detection of detections) {
      if (!detection.value || detection.kind === "face") continue;
      const value = detection.value;
      if (TOKEN_EXACT.test(value)) continue;

      const kind: VaultKind =
        detection.kind === "pii_text" || detection.kind === "person" || detection.kind === "organization"
          ? "pii_text"
          : detection.kind === "id_number" || detection.kind === "api_key" || detection.kind === "credential"
            ? detection.kind
            : "credential";
      const token = this.tokenize(value, kind);
      let replaced = false;

      const idMatch = detection.elementSelector?.match(/data-pry-id="(\d+)"/);
      if (idMatch) {
        const element = byId.get(parseInt(idMatch[1], 10));
        if (element && element.value && element.value.includes(value) && !TOKEN_EXACT.test(element.value)) {
          element.value = element.value.split(value).join(token);
          replaced = true;
        }
      }

      if (value.length >= MIN_REDACT_LENGTH && text.includes(value)) {
        const next = replaceValue(text, value, token);
        if (next !== text) {
          text = next;
          replaced = true;
        }
      }
      if (replaced) tokenCount++;
    }
    return { ...snapshot, elements, text, tokenCount };
  }

  /** Tokenize secrets in the user's task, including names after "from"/"to"/"company:". */
  tokenizeTask(task: string): { task: string; tokenCount: number } {
    const prompt = this.tokenizePrompt(task);
    let text = prompt.sanitized;
    let tokenCount = prompt.tokenCount;
    const patterns: RegExp[] = [
      /\b(from|to|sender|recipient|addressed to|sent by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
      /\b(name|company|business|firm|organization|vendor|supplier|client)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
    ];
    for (const pattern of patterns) {
      text = text.replace(pattern, (_m, lead: string, name: string) => {
        tokenCount++;
        return `${lead} ${this.tokenize(name, "pii_text")}`;
      });
    }
    return { task: text, tokenCount };
  }

  shouldTokenizeValue(element: PageElement): boolean {
    if (element.role === "password" || element.attrs?.inputType === "password") return true;
    if (element.attrs?.inputType === "hidden") return false;
    const context = `${element.role} ${Object.values(element.attrs ?? {}).join(" ")}`;
    return /\b(password|secret|key|token|cvv|otp)\b/i.test(context);
  }

  /** Swap any vault value that appears in `text` back to its token. */
  redactValues(text: unknown): string {
    let out = String(text);
    for (const entry of this.redactableEntries()) {
      if (!out.includes(entry.original)) continue;
      out = replaceValue(out, entry.original, entry.token);
    }
    return out;
  }

  redactVaultValuesInSnapshot(snapshot: Pick<PageSnapshot, "elements" | "text">): Pick<PageSnapshot, "elements" | "text"> {
    const entries = this.redactableEntries();
    if (entries.length === 0) return { elements: snapshot.elements, text: snapshot.text };

    const redact = (value: string): string => {
      let out = String(value);
      for (const entry of entries) {
        if (!out.includes(entry.original)) continue;
        out = replaceValue(out, entry.original, entry.token);
      }
      return out;
    };

    const elements = snapshot.elements.map((element) => {
      let changed = false;
      const copy = { ...element };
      if (copy.value && this.vaultHasValue(copy.value)) {
        const next = redact(copy.value);
        if (next !== copy.value) {
          copy.value = next;
          changed = true;
        }
      }
      if (copy.name && this.vaultHasValue(copy.name)) {
        const next = redact(copy.name);
        if (next !== copy.name) {
          copy.name = next;
          changed = true;
        }
      }
      return changed ? copy : element;
    });
    const text = this.vaultHasValue(snapshot.text) ? redact(snapshot.text) : snapshot.text;
    return { elements, text };
  }

  vaultHasValue(text: string | undefined): boolean {
    if (!text) return false;
    for (const entry of this.vault.values()) {
      if (entry.original.length >= MIN_REDACT_LENGTH && text.includes(entry.original)) return true;
    }
    return false;
  }

  getTokenSummary(): TokenSummary[] {
    return Array.from(this.vault.values()).map((entry) => ({
      token: entry.token,
      kind: entry.kind,
      sample: maskSample(entry.original),
    }));
  }

  clear(): void {
    this.vault.clear();
    this.counters = {};
  }

  get size(): number {
    return this.vault.size;
  }

  /** Longest first, so "4111 1111 1111 1111" wins over a 4-digit substring. */
  private redactableEntries(): VaultEntry[] {
    return Array.from(this.vault.values())
      .filter((entry) => entry.original.length >= MIN_REDACT_LENGTH)
      .sort((a, b) => b.original.length - a.original.length);
  }
}

/** Models sometimes glue digits onto a token ("7<CRED_1>"); strip them before resolving. */
export function stripDigitsGluedToTokens(text: unknown): string {
  return String(text)
    .replace(/(?<![A-Za-z0-9])\d+<([A-Z]+_\d+)>/g, "<$1>")
    .replace(/<([A-Z]+_\d+)>\d+(?![A-Za-z0-9])/g, "<$1>");
}

/** A display-safe hint of a secret, e.g. "jo•••@example.com" or "•••• ••••". */
export function maskSample(value: string): string {
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return "••";
  if (trimmed.length <= 2) return "•".repeat(Math.max(2, trimmed.length));

  const at = trimmed.indexOf("@");
  if (at > 0 && trimmed.includes(".") && trimmed.length > at + 2) {
    return `${trimmed.slice(0, at).slice(0, 2)}•••@${trimmed.slice(at + 1)}`;
  }

  const hasLetters = /[A-Za-z]/.test(trimmed);
  const digitCount = (trimmed.match(/\d/g) ?? []).length;
  const alnumCount = (trimmed.match(/[A-Za-z0-9]/g) ?? []).length;
  if (hasLetters && digitCount > 0 && alnumCount >= 6 && !/\s/.test(trimmed.trim())) {
    return maskChars(trimmed, /[A-Za-z0-9]/);
  }
  if (digitCount >= 4) return maskChars(trimmed, /\d/);
  return `${trimmed.slice(0, 2)}${"•".repeat(Math.min(10, Math.max(6, trimmed.length - 2)))}`;
}

function maskChars(value: string, which: RegExp): string {
  let out = "";
  for (const ch of value) out += which.test(ch) ? "•" : ch;
  return out;
}

/** The single vault instance for the service worker. */
export const vault = new TokenVault();
