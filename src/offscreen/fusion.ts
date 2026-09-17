import { isValidAadhaar, isLuhnValid } from "../shared/checksums";
import type { SensitiveRegion } from "../shared/types";
import { boxesIntersect, clampBox } from "./blur";
import { recognizeText } from "./ocr";
import type { BoundingBox } from "./types";

const PAN_REGEX = /\b[A-Z]{5}\d{4}[A-Z]\b/;
const API_KEY_REGEX = /\b(sk-ant-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|AKIA[0-9A-Z]{16})\b/;
const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;
const PHONE_REGEX = /\b(\+?91[\s-]?)?[6-9]\d{9}\b/;

/** Removes zero-width characters commonly used in obfuscation */
export function stripZeroWidthChars(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, "");
}

export interface FusedMatch {
  box: BoundingBox;
  kind: string;
  label: string;
  text: string;
}

/**
 * Checks if a recognized text string matches sensitive PII
 * using checksum algorithms (Verhoeff for Aadhaar, Luhn for cards) and regexes.
 */
export function evaluateTextPII(rawText: string): { kind: string; label: string } | null {
  const text = stripZeroWidthChars(rawText).trim();

  // 1. Aadhaar Check (12 digits, Verhoeff checksum)
  const aadhaarMatches = text.matchAll(/\b\d{4}\s?\d{4}\s?\d{4}\b/g);
  for (const m of aadhaarMatches) {
    if (isValidAadhaar(m[0])) {
      return { kind: "id_number", label: "Aadhaar number (Verhoeff ✓)" };
    }
  }

  // 2. Credit / Debit Card (Luhn checksum)
  const cardMatches = text.matchAll(/\b(?:\d{4}[\s-]?){3}\d{4}\b/g);
  for (const m of cardMatches) {
    if (isLuhnValid(m[0])) {
      return { kind: "credential", label: "Card number (Luhn ✓)" };
    }
  }

  // 3. PAN Card
  const panMatch = PAN_REGEX.exec(text);
  if (panMatch) {
    return { kind: "id_number", label: "PAN card number" };
  }

  // 4. API Keys
  const keyMatch = API_KEY_REGEX.exec(text);
  if (keyMatch) {
    return { kind: "api_key", label: "API key / token" };
  }

  // 5. Email
  if (EMAIL_REGEX.test(text)) {
    return { kind: "credential", label: "Email address" };
  }

  // 6. Phone
  if (PHONE_REGEX.test(text)) {
    return { kind: "credential", label: "Phone number" };
  }

  return null;
}

/**
 * Compares detected PP-OCRv4 text boxes against the page DOM structure.
 * For text the DOM misses (images, canvas, PDFs), runs OCR and validates against checksums.
 */
export async function fuseSignalsAndFindMissedPII(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  ppocrBoxes: BoundingBox[],
  domRegions: SensitiveRegion[],
  dpr = 1,
): Promise<FusedMatch[]> {
  // Convert DOM regions to screenshot pixel coordinates
  const domPixelBoxes: BoundingBox[] = domRegions.map((r) => ({
    x: Math.round(r.x * dpr),
    y: Math.round(r.y * dpr),
    width: Math.round(r.width * dpr),
    height: Math.round(r.height * dpr),
    kind: r.kind,
    label: r.label,
  }));

  // Identify boxes detected by vision that do not overlap with existing DOM regions
  const missedCandidateBoxes: BoundingBox[] = [];
  for (const box of ppocrBoxes) {
    let coveredByDom = false;
    for (const domBox of domPixelBoxes) {
      if (boxesIntersect(box, domBox)) {
        coveredByDom = true;
        break;
      }
    }
    if (!coveredByDom) {
      missedCandidateBoxes.push(box);
    }
  }

  console.log(
    `[PRY Offscreen] Signal fusion: ${ppocrBoxes.length} text boxes found, ${missedCandidateBoxes.length} missed by DOM`,
  );

  const matchedPII: FusedMatch[] = [];
  // Limit to most prominent candidates to prevent OCR bottlenecks
  const candidates = missedCandidateBoxes.slice(0, 10);

  for (const cand of candidates) {
    const clamped = clampBox(width, height, cand.x - 4, cand.y - 4, cand.width + 8, cand.height + 8);
    if (!clamped || clamped.width < 12 || clamped.height < 8) continue;

    try {
      const cropCanvas = new OffscreenCanvas(clamped.width, clamped.height);
      const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true })!;
      cropCtx.drawImage(
        ctx.canvas,
        clamped.x,
        clamped.y,
        clamped.width,
        clamped.height,
        0,
        0,
        clamped.width,
        clamped.height,
      );

      const blob = await cropCanvas.convertToBlob({ type: "image/png" });
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });

      const recognized = await recognizeText(dataUrl, 4000);
      if (!recognized) continue;

      const piiMatch = evaluateTextPII(recognized);
      if (piiMatch) {
        console.log(`[PRY Offscreen] DOM-missed PII match: ${piiMatch.label} in box ${clamped.x},${clamped.y}`);
        matchedPII.push({
          box: clamped,
          kind: piiMatch.kind,
          label: piiMatch.label,
          text: recognized,
        });
      }
    } catch (err) {
      console.warn("[PRY Offscreen] Candidate OCR processing error:", err);
    }
  }

  return matchedPII;
}
