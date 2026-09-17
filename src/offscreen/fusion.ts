import { isValidAadhaar, isLuhnValid } from "../shared/checksums";
import { normalizeOcrDigits, stripInvisible } from "../shared/text";
import type { SensitiveRegion } from "../shared/types";
import { boxesIntersect, clampBox } from "./blur";
import { recognizeText } from "./ocr";
import type { BoundingBox } from "./types";

const PAN_REGEX = /\b[A-Z]{5}\d{4}[A-Z]\b/;
const API_KEY_REGEX = /\b(sk-ant-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|AKIA[0-9A-Z]{16})\b/;
const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;
const PHONE_REGEX = /\b(\+?91[\s-]?)?[6-9]\d{9}\b/;
/** Eight or more digits, allowing the separators OCR keeps between groups. */
const LONG_NUMBER = /\d(?:[\s\-.]?\d){7,}/;
/** Labels that make even a short number sensitive (card CVV/expiry, PINs, OTPs, dates of birth). */
const SENSITIVE_NUMBER_LABEL = /\b(cvv|cvc|exp(iry)?|valid\s*(thru|till)|pin|otp|dob|date\s*of\s*birth|a\/c|account|ifsc|passport|aadhaar|pan)\b/i;

/** OCR candidates per screenshot; boxes beyond this are masked without reading them. */
export const MAX_OCR_CANDIDATES = 12;

/** Removes zero-width characters commonly used in obfuscation */
export function stripZeroWidthChars(text: string): string {
  return stripInvisible(text);
}

export interface FusedMatch {
  box: BoundingBox;
  kind: string;
  label: string;
  /** Why the box was masked: a validated PII match, or an unverifiable read. */
  reason: "pii" | "uncertain";
}

/**
 * Checks if a recognized text string matches sensitive PII
 * using checksum algorithms (Verhoeff for Aadhaar, Luhn for cards) and regexes.
 */
export function evaluateTextPII(rawText: string): { kind: string; label: string } | null {
  const text = normalizeOcrDigits(rawText).trim();

  for (const m of text.matchAll(/\b\d{4}\s?\d{4}\s?\d{4}\b/g)) {
    if (isValidAadhaar(m[0])) return { kind: "id_number", label: "Aadhaar number (Verhoeff ✓)" };
  }
  for (const m of text.matchAll(/\b(?:\d{4}[\s-]?){3}\d{4}\b/g)) {
    if (isLuhnValid(m[0])) return { kind: "credential", label: "Card number (Luhn ✓)" };
  }
  if (PAN_REGEX.test(text)) return { kind: "id_number", label: "PAN card number" };
  if (API_KEY_REGEX.test(text)) return { kind: "api_key", label: "API key / token" };
  if (EMAIL_REGEX.test(text)) return { kind: "credential", label: "Email address" };
  if (PHONE_REGEX.test(text)) return { kind: "credential", label: "Phone number" };
  return null;
}

/**
 * Decide whether an OCR'd box inside an image/canvas/iframe must be masked.
 * Fails closed: an unreadable crop, or a number the checksums can't clear,
 * is masked rather than sent.
 */
export function classifyOcrText(recognized: string | null): { kind: string; label: string; reason: FusedMatch["reason"] } | null {
  if (recognized === null) {
    return { kind: "visual_text", label: "Unreadable text in image (masked to be safe)", reason: "uncertain" };
  }
  const pii = evaluateTextPII(recognized);
  if (pii) return { ...pii, reason: "pii" };

  const text = normalizeOcrDigits(recognized);
  if (LONG_NUMBER.test(text)) {
    return { kind: "visual_text", label: "Unverified long number in image", reason: "uncertain" };
  }
  if (/\d{3,}/.test(text) && SENSITIVE_NUMBER_LABEL.test(text)) {
    return { kind: "visual_text", label: "Labelled sensitive number in image", reason: "uncertain" };
  }
  return null;
}

function toPixels(regions: SensitiveRegion[], dpr: number): BoundingBox[] {
  return regions.map((r) => ({
    x: Math.round(r.x * dpr),
    y: Math.round(r.y * dpr),
    width: Math.round(r.width * dpr),
    height: Math.round(r.height * dpr),
    kind: r.kind,
    label: r.label,
  }));
}

/**
 * Finds PII the DOM cannot see. Text boxes from the vision model that sit
 * inside pixel content (canvas, img, video, iframe — `mediaRegions`) and are
 * not already covered by a DOM-reported sensitive region are OCR'd and
 * classified. When `mediaRegions` is omitted every uncovered text box is a
 * candidate.
 */
export async function fuseSignalsAndFindMissedPII(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  ppocrBoxes: BoundingBox[],
  domRegions: SensitiveRegion[],
  dpr = 1,
  mediaRegions?: SensitiveRegion[],
  recognize: (dataUrl: string, timeoutMs: number) => Promise<string | null> = recognizeText,
): Promise<FusedMatch[]> {
  const domPixelBoxes = toPixels(domRegions, dpr);
  const mediaPixelBoxes = mediaRegions ? toPixels(mediaRegions, dpr) : null;

  const candidates = ppocrBoxes.filter(
    (box) =>
      !domPixelBoxes.some((dom) => boxesIntersect(box, dom)) &&
      (mediaPixelBoxes === null || mediaPixelBoxes.some((media) => boxesIntersect(box, media))),
  );

  console.log(
    `[PRY Offscreen] Signal fusion: ${ppocrBoxes.length} text boxes, ${candidates.length} inside pixel content and not covered by DOM`,
  );

  const matches: FusedMatch[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const clamped = clampBox(width, height, candidate.x - 4, candidate.y - 4, candidate.width + 8, candidate.height + 8);
    if (!clamped || clamped.width < 12 || clamped.height < 8) continue;

    // Too many candidates to OCR in time: mask the rest unread.
    if (index >= MAX_OCR_CANDIDATES) {
      matches.push({ box: clamped, kind: "visual_text", label: "Unscanned text in image (OCR limit)", reason: "uncertain" });
      continue;
    }

    let recognized: string | null = null;
    try {
      const cropCanvas = new OffscreenCanvas(clamped.width, clamped.height);
      const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true })!;
      cropCtx.drawImage(ctx.canvas, clamped.x, clamped.y, clamped.width, clamped.height, 0, 0, clamped.width, clamped.height);
      const blob = await cropCanvas.convertToBlob({ type: "image/png" });
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      recognized = await recognize(dataUrl, 4000);
    } catch (err) {
      console.warn("[PRY Offscreen] Candidate OCR failed; masking the box:", err);
      recognized = null;
    }

    const decision = classifyOcrText(recognized);
    if (decision) {
      console.log(`[PRY Offscreen] Masking pixel text (${decision.reason}): ${decision.label} at ${clamped.x},${clamped.y}`);
      matches.push({ box: clamped, kind: decision.kind, label: decision.label, reason: decision.reason });
    }
  }
  return matches;
}
