// Regex + checksum PII detection over a page snapshot, and the final
// "[REDACTED]" pass for anything that could not be tokenized.

import { isLuhnValid, isValidAadhaar } from "../../shared/checksums";
import { EXTRA_INDIAN_IDS, PASSPORT } from "../../shared/indian-ids";
import type { Detection, DetectionKind, PageElement, PageSnapshot } from "../../shared/types";

interface LabeledPattern {
  pattern: RegExp;
  label: string;
}

/** Element text (name/role/value/attrs) that marks an element as a credential field. */
const CREDENTIAL_FIELD_PATTERNS: LabeledPattern[] = [
  { pattern: /\bpassword\b/i, label: "Password field" },
  { pattern: /\bpasscode\b/i, label: "Passcode field" },
  { pattern: /\bcvv\b/i, label: "CVV field" },
  { pattern: /\bcvc\b/i, label: "CVC field" },
  { pattern: /\bcard\s*number\b/i, label: "Card number field" },
  { pattern: /\bcredit\s*card\b/i, label: "Credit card field" },
  { pattern: /\bdebit\s*card\b/i, label: "Debit card field" },
  { pattern: /\bexpiry\b/i, label: "Expiry field" },
  { pattern: /\botp\b/i, label: "OTP field" },
  { pattern: /\bone[-\s]?time\s*(code|password)\b/i, label: "One-time code field" },
  { pattern: /\bsecret\b/i, label: "Secret field" },
  { pattern: /\bapi[-\s]?key\b/i, label: "API key field" },
];

/** Values that look like API keys / tokens. */
const API_KEY_VALUE_PATTERNS: LabeledPattern[] = [
  { pattern: /^sk-ant-[a-zA-Z0-9_-]{20,}/, label: "Anthropic API key" },
  { pattern: /^sk-[a-zA-Z0-9]{20,}/, label: "OpenAI API key" },
  { pattern: /^ghp_[a-zA-Z0-9]{36}/, label: "GitHub personal access token" },
  { pattern: /^gho_[a-zA-Z0-9]{36}/, label: "GitHub OAuth token" },
  { pattern: /^ghs_[a-zA-Z0-9]{36}/, label: "GitHub server-to-server token" },
  { pattern: /^xox[baprs]-[a-zA-Z0-9-]+/, label: "Slack token" },
  { pattern: /^AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  { pattern: /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\./, label: "JWT token" },
];

const AADHAAR_LABEL = "Possible Aadhaar number";

const INDIAN_ID_TEXT_PATTERNS: LabeledPattern[] = [
  { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/, label: AADHAAR_LABEL },
  { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/, label: "PAN card number" },
  { pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/, label: "IFSC code" },
];

const OTHER_ID_TEXT_PATTERNS: LabeledPattern[] = [
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: "SSN" },
  { pattern: PASSPORT, label: "Possible passport number" },
];

const CARD_NUMBER = /\b(?:\d{4}[\s-]?){3}\d{4}\b/;
const EMAIL = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;
const INDIAN_PHONE = /\b(\+91[\s-]?)?[6-9]\d{9}\b/;

export const TOKEN_EXACT = /^<[A-Z]+_\d+>$/;

export function elementSelector(id: number): string {
  return `[data-pry-id="${id}"]`;
}

export function elementIdFromSelector(selector: string | undefined): number {
  const match = selector?.match(/data-pry-id="(\d+)"/);
  return match ? parseInt(match[1], 10) : -1;
}

/** Credential fields, API-key values and card numbers found on elements. */
export function detectElementPII(snapshot: Pick<PageSnapshot, "elements">): Detection[] {
  const detections: Detection[] = [];
  for (const element of snapshot.elements) {
    const haystack = elementHaystack(element);

    for (const { pattern, label } of CREDENTIAL_FIELD_PATTERNS) {
      if (pattern.test(haystack)) {
        detections.push({
          kind: "credential",
          value: element.value,
          elementSelector: elementSelector(element.id),
          confidence: 0.9,
          label,
        });
        break;
      }
    }

    if (!element.value) continue;

    for (const { pattern, label } of API_KEY_VALUE_PATTERNS) {
      if (pattern.test(element.value)) {
        detections.push({
          kind: "api_key",
          value: element.value,
          elementSelector: elementSelector(element.id),
          confidence: 0.95,
          label,
        });
        break;
      }
    }

    if (CARD_NUMBER.test(element.value)) {
      const inCardField = /card|credit|debit|cc[-_\s]|card_/i.test(haystack);
      if (inCardField || isLuhnValid(element.value)) {
        detections.push({
          kind: "credential",
          value: element.value,
          elementSelector: elementSelector(element.id),
          confidence: inCardField ? 0.9 : 0.85,
          label: inCardField ? "Card number in card field" : "Card number (Luhn valid)",
        });
      }
    }
  }
  return detections;
}

function elementHaystack(element: PageElement): string {
  return `${element.name} ${element.role} ${element.value ?? ""} ${Object.values(element.attrs ?? {}).join(" ")}`;
}

interface TextPattern {
  pattern: RegExp;
  kind: DetectionKind;
  label: string;
  validate?: (match: string) => boolean;
}

export interface TextDetectionResult {
  detections: Detection[];
  /** Matches that failed a checksum — reported as learning signals, never redacted. */
  rejected: Detection[];
}

/** Identifiers, emails and phone numbers in free page text. */
export function detectTextPII(text: string): TextDetectionResult {
  const detections: Detection[] = [];
  const rejected: Detection[] = [];
  const patterns: TextPattern[] = [
    ...INDIAN_ID_TEXT_PATTERNS.map((p): TextPattern => {
      const isAadhaar = p.label === AADHAAR_LABEL;
      return {
        pattern: p.pattern,
        kind: "id_number",
        label: isAadhaar ? "Aadhaar number (Verhoeff ✓)" : p.label,
        validate: isAadhaar ? (match) => isValidAadhaar(match) : undefined,
      };
    }),
    ...OTHER_ID_TEXT_PATTERNS.map((p): TextPattern => ({ pattern: p.pattern, kind: "id_number", label: p.label })),
    ...EXTRA_INDIAN_IDS.map((p): TextPattern => ({ ...p, kind: "id_number" })),
    { pattern: EMAIL, kind: "credential", label: "Email address" },
    { pattern: INDIAN_PHONE, kind: "credential", label: "Phone number" },
  ];

  for (const { pattern, kind, label, validate } of patterns) {
    const global = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g");
    for (const match of text.matchAll(global)) {
      if (match.index === undefined) continue;
      if (validate && !validate(match[0])) {
        rejected.push({ kind, value: match[0], confidence: 0.15, label: `${label} lookalike (checksum failed)` });
        continue;
      }
      detections.push({ kind, value: match[0], confidence: kind === "credential" ? 0.9 : 0.7, label });
    }
  }
  return { detections, rejected };
}

export function detectSnapshotPII(snapshot: PageSnapshot, extra: Detection[] = []): TextDetectionResult {
  const text = detectTextPII(snapshot.text);
  return {
    detections: [...extra, ...detectElementPII(snapshot), ...text.detections],
    rejected: text.rejected,
  };
}

export interface RedactionResult {
  elements: PageElement[];
  text: string;
  redactedCount: number;
}

/**
 * Last-resort redaction: credential/api-key elements that still hold a raw value
 * get "[REDACTED]" (and their href), and ID numbers left in the text are replaced.
 */
export function redactDetections(
  snapshot: Pick<PageSnapshot, "elements" | "text">,
  detections: Detection[],
): RedactionResult {
  let redactedCount = 0;
  const sensitiveIds = new Set(
    detections
      .filter((d) => d.kind === "credential" || d.kind === "api_key")
      .map((d) => elementIdFromSelector(d.elementSelector))
      .filter((id) => id >= 0),
  );

  const elements = snapshot.elements.map((element) => {
    if (!sensitiveIds.has(element.id)) return element;
    if (element.value && TOKEN_EXACT.test(element.value)) return element;
    redactedCount++;
    return {
      ...element,
      value: element.value ? "[REDACTED]" : undefined,
      attrs: element.attrs
        ? Object.fromEntries(
            Object.entries(element.attrs).map(([key, val]) => (key === "href" ? [key, "[REDACTED]"] : [key, val])),
          )
        : undefined,
    };
  });

  let text = snapshot.text;
  for (const detection of detections.filter((d) => d.kind === "id_number" && d.value)) {
    text = text.replaceAll(detection.value!, "[ID_REDACTED]");
    redactedCount++;
  }
  return { elements, text, redactedCount };
}
