// Indian identifiers beyond Aadhaar/PAN/IFSC: UPI IDs, GSTIN, voter ID (EPIC),
// driving licence and passport numbers. Shared by the worker's text detectors,
// the content script's region finder and the offscreen OCR classifier.

import { isValidGstin } from "./checksums";

/** Common UPI payment-service handles. A bare `name@handle` with no TLD. */
const UPI_HANDLES = [
  "upi", "ybl", "ibl", "axl", "apl", "yapl", "rapl", "paytm", "okaxis", "okhdfcbank", "okicici", "oksbi",
  "axisbank", "icici", "sbi", "hdfcbank", "kotak", "kmbl", "pthdfc", "ptsbi", "ptaxis", "ptyes", "fbl",
  "idfcbank", "jupiteraxis", "waaxis", "wahdfcbank", "wasbi", "abfspay", "airtel", "jio", "barodampay",
  "aubank", "federal", "indus", "pnb", "boi", "cnrb", "unionbank", "yesbank", "freecharge", "slice", "naviaxis",
];

export interface IndianIdPattern {
  pattern: RegExp;
  label: string;
  validate?: (match: string) => boolean;
}

export const UPI_ID = new RegExp(`\\b[a-zA-Z0-9._-]{2,64}@(?:${UPI_HANDLES.join("|")})\\b(?![.@\\w])`, "i");
export const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;
export const VOTER_ID = /\b[A-Z]{3}\d{7}\b/;
export const DRIVING_LICENCE = /\b[A-Z]{2}\d{2}[ -]?(?:19|20)\d{2}\d{7}\b/;
/** Indian passport: a letter (not Q, X or Z), then 7 digits, first and last non-zero. */
export const PASSPORT = /\b[A-PR-WY][1-9]\d\s?\d{4}[1-9]\b/;

/** Identifiers added after the legacy bundle. Order is the reporting order. */
export const EXTRA_INDIAN_IDS: IndianIdPattern[] = [
  { pattern: GSTIN, label: "GSTIN (checksum ✓)", validate: isValidGstin },
  { pattern: UPI_ID, label: "UPI ID" },
  { pattern: VOTER_ID, label: "Voter ID (EPIC)" },
  { pattern: DRIVING_LICENCE, label: "Driving licence number" },
];

/** First extra Indian identifier found in `text`, or null. */
export function findExtraIndianId(text: string): { label: string; value: string } | null {
  for (const { pattern, label, validate } of EXTRA_INDIAN_IDS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    for (const match of text.matchAll(global)) {
      if (!validate || validate(match[0])) return { label, value: match[0] };
    }
  }
  return null;
}
