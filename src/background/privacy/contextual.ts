// Context-aware PII detection: a value is only flagged when the field's label
// says what it is AND the value has the right shape (e.g. a name field holding
// something that looks like a person's name).

import type { Detection, PageSnapshot } from "../../shared/types";
import { elementSelector } from "./detectors";

export type ContextualKind = "person" | "organization" | "address" | "phone" | "email" | "financial";

export interface ContextualDetection {
  kind: ContextualKind;
  value: string;
  confidence: number;
  label: string;
  elementId?: number;
}

const NAME_FIELDS: { pattern: RegExp; label: string; kind: "person" | "organization" }[] = [
  {
    pattern: /\b(name|full\s*name|your\s*name|first\s*name|last\s*name|sender|from|recipient|to)\b/i,
    label: "Name field",
    kind: "person",
  },
  {
    pattern: /\b(company|organization|business|firm|vendor|supplier|client|employer)\b/i,
    label: "Organization field",
    kind: "organization",
  },
  { pattern: /\b(card\s*holder|account\s*holder|beneficiary)\b/i, label: "Account holder field", kind: "person" },
  { pattern: /\b(МЕСТО|Имя|ФИО)\b/, label: "Russian name field", kind: "person" },
];

const ADDRESS_FIELDS = [
  { pattern: /\b(address|street|city|state|zip|postal|country|billing|shipping|location)\b/i, label: "Address field" },
  { pattern: /\b(landmark|area|district|pin\s*code)\b/i, label: "Indian address field" },
];

const CONTACT_FIELDS: { pattern: RegExp; label: string; kind: "phone" | "email" }[] = [
  { pattern: /\b(phone|mobile|tel|contact|cell|fax)\b/i, label: "Phone field", kind: "phone" },
  { pattern: /\b(email|e-mail|mail)\b/i, label: "Email field", kind: "email" },
];

const FINANCIAL_FIELDS = [
  { pattern: /\b(account|iban|routing|sort\s*code|bic|swift)\b/i, label: "Bank account field" },
  { pattern: /\b(card|credit|debit|visa|mastercard|amex)\b/i, label: "Card field" },
  { pattern: /\b(expiry|exp|valid\s*thru|cvc|cvv|cvv2)\b/i, label: "Card detail field" },
];

export function looksLikePersonName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  const capitalized = /^([A-Z][a-z]+|[A-Z]\.?)$/;
  const honorific = /^(Mr|Mrs|Ms|Dr|Prof|Shri|Smt|Kumari|Sir|Madam)\.?$/i;
  let nameLike = 0;
  for (const word of words) if (honorific.test(word) || capitalized.test(word)) nameLike++;
  return nameLike / words.length >= 0.7;
}

export function looksLikeOrganization(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 100) return false;
  if (
    /\b(Inc|LLC|Ltd|Pvt|Corp|Co|Company|Solutions|Technologies|Tech|Services|Group|Associates|Partners|Enterprises|Stores|Traders|Trading)\b/i.test(
      trimmed,
    )
  )
    return true;
  const words = trimmed.split(/\s+/);
  if (words.length >= 2 && words.length <= 6) {
    const noDigits = !/\d/.test(trimmed);
    const allCapitalized = words.every((w) => /^[A-Z]/.test(w));
    if (noDigits && allCapitalized) return true;
  }
  return false;
}

export function looksLikeAddress(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 10 || trimmed.length > 200) return false;
  const streetWord =
    /\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|circle|way|nagar|colony|sector|block|floor|flat|apt|suite|building|house|no\.|number)\b/i;
  return streetWord.test(trimmed) && /\d/.test(trimmed) && /,/.test(trimmed);
}

export function looksLikePhone(value: string): boolean {
  const compact = value.replace(/[\s\-().]/g, "");
  if (!/^\+?\d{7,15}$/.test(compact)) return false;
  return /^(\+?91)?[6-9]\d{9}$/.test(compact) || /^1?\d{10}$/.test(compact) || /^\d{8,12}$/.test(compact);
}

export function detectContextualPII(snapshot: Pick<PageSnapshot, "elements" | "text">): ContextualDetection[] {
  const found: ContextualDetection[] = [];

  for (const element of snapshot.elements) {
    if (!element.value || element.value.length < 2) continue;
    const context = `${element.name} ${element.role} ${JSON.stringify(element.attrs ?? {})}`.toLowerCase();
    const value = element.value;

    for (const { pattern, label, kind } of NAME_FIELDS) {
      if (!pattern.test(context)) continue;
      if (kind === "person" && looksLikePersonName(value)) {
        found.push({ kind: "person", value, confidence: 0.85, label, elementId: element.id });
        break;
      }
      if (kind === "organization" && looksLikeOrganization(value)) {
        found.push({ kind: "organization", value, confidence: 0.8, label, elementId: element.id });
        break;
      }
    }

    for (const { pattern, label } of ADDRESS_FIELDS) {
      if (pattern.test(context) && looksLikeAddress(value)) {
        found.push({ kind: "address", value, confidence: 0.8, label, elementId: element.id });
        break;
      }
    }

    for (const { pattern, label, kind } of CONTACT_FIELDS) {
      if (!pattern.test(context)) continue;
      if (kind === "phone" && looksLikePhone(value)) {
        found.push({ kind: "phone", value, confidence: 0.85, label, elementId: element.id });
        break;
      }
      if (kind === "email" && value.includes("@") && value.includes(".")) {
        found.push({ kind: "email", value, confidence: 0.9, label, elementId: element.id });
        break;
      }
    }

    for (const { pattern, label } of FINANCIAL_FIELDS) {
      if (pattern.test(context) && /\d/.test(value) && value.replace(/\D/g, "").length >= 8) {
        found.push({ kind: "financial", value, confidence: 0.85, label, elementId: element.id });
        break;
      }
    }
  }

  const nameInText =
    /\b((?:from|to|sender|recipient|name|company): *|addressed to |sent by )([A-Z][a-z]+(?: +[A-Z][a-z]+){1,3})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = nameInText.exec(snapshot.text)) !== null) {
    const name = match[2];
    if (looksLikePersonName(name) && !found.some((d) => d.value === name)) {
      found.push({ kind: "person", value: name, confidence: 0.7, label: "Name in page text" });
    }
  }
  return found;
}

/** Map contextual findings onto the vault's detection kinds. */
export function toDetections(found: ContextualDetection[]): Detection[] {
  return found.map((d) => ({
    kind:
      d.kind === "person" || d.kind === "organization" || d.kind === "address"
        ? "pii_text"
        : "credential",
    value: d.value,
    elementSelector: d.elementId !== undefined ? elementSelector(d.elementId) : undefined,
    confidence: d.confidence,
    label: d.label,
  }));
}
