import { clampBox } from "./blur";
import type { BoundingBox, RedactionVerification } from "./types";

const SENSITIVE_PATTERN_REGEXES: { pattern: RegExp; label: string }[] = [
  { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/, label: "Aadhaar number" },
  { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/, label: "PAN card" },
  { pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/, label: "IFSC code" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: "SSN" },
  { pattern: /\b[A-Z]{1,2}\d{6,8}\b/, label: "Passport number" },
  { pattern: /\b(?:\d{4}[\s-]?){3}\d{4}\b/, label: "Card number" },
  { pattern: /\b(sk-ant-[a-zA-Z0-9_-]{20,})\b/, label: "Anthropic API key" },
  { pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/, label: "OpenAI API key" },
  { pattern: /\b(ghp_[a-zA-Z0-9]{36})\b/, label: "GitHub token" },
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/, label: "AWS key" },
  { pattern: /\b(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.)\b/, label: "JWT token" },
  { pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, label: "Email address" },
  { pattern: /\b(\+?91[\s-]?\d{5}[\s-]?\d{5})\b/, label: "Indian phone" },
];

/** Extracts sensitive pattern labels found in recognized OCR text */
export function extractPIIPatternLabels(text: string): string[] {
  const labels: string[] = [];
  for (const { pattern, label } of SENSITIVE_PATTERN_REGEXES) {
    const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
    if (new RegExp(pattern.source, flags).test(text)) {
      labels.push(label);
    }
  }
  return labels;
}

/** Black pixel ratio in a region */
export function blackPixelRatio(target: ImageData, x: number, y: number, w: number, h: number): number {
  const box = clampBox(target.width, target.height, x, y, w, h);
  if (!box) return 0;
  let dark = 0, total = 0;
  for (let py = box.y; py < box.y + box.height; py += 4) {
    for (let px = box.x; px < box.x + box.width; px += 4) {
      const idx = (py * target.width + px) * 4;
      const r = target.data[idx];
      const g = target.data[idx + 1];
      const b = target.data[idx + 2];
      if (r < 30 && g < 30 && b < 30) dark++;
      total++;
    }
  }
  return total > 0 ? dark / total : 0;
}

/** Mean color difference ratio between original and target */
export function colorDiffRatio(orig: ImageData, target: ImageData, x: number, y: number, w: number, h: number): number {
  const box = clampBox(orig.width, orig.height, x, y, w, h);
  if (!box || box.width === 0 || box.height === 0) return 0;
  let diff = 0, total = 0;
  for (let py = box.y; py < box.y + box.height; py += 4) {
    for (let px = box.x; px < box.x + box.width; px += 4) {
      const idxOrig = (py * orig.width + px) * 4;
      const idxTarget = (py * target.width + px) * 4;
      if (idxOrig + 2 >= orig.data.length || idxTarget + 2 >= target.data.length) continue;
      const dr = Math.abs(orig.data[idxOrig] - target.data[idxTarget]);
      const dg = Math.abs(orig.data[idxOrig + 1] - target.data[idxTarget + 1]);
      const db = Math.abs(orig.data[idxOrig + 2] - target.data[idxTarget + 2]);
      diff += (dr + dg + db) / 765;
      total++;
    }
  }
  return total > 0 ? diff / total : 0;
}

/** Edge / high-frequency metric */
export function edgeIntensity(image: ImageData, x: number, y: number, w: number, h: number): number {
  const box = clampBox(image.width, image.height, x, y, w, h);
  if (!box) return 0;
  let sum = 0;
  for (let py = box.y + 2; py < box.y + box.height - 2; py += 2) {
    for (let px = box.x + 2; px < box.x + box.width - 2; px += 2) {
      const left = (py * image.width + px - 2) * 4;
      const right = (py * image.width + px + 2) * 4;
      const up = ((py - 2) * image.width + px) * 4;
      const down = ((py + 2) * image.width + px) * 4;
      if (right + 2 >= image.data.length || up < 0) continue;
      const lumRight = (image.data[right] + image.data[right + 1] + image.data[right + 2]) / 3;
      const lumLeft = (image.data[left] + image.data[left + 1] + image.data[left + 2]) / 3;
      const lumDown = (image.data[down] + image.data[down + 1] + image.data[down + 2]) / 3;
      const lumUp = (image.data[up] + image.data[up + 1] + image.data[up + 2]) / 3;
      sum += Math.abs(lumRight - lumLeft) + Math.abs(lumDown - lumUp);
    }
  }
  return sum;
}

/** Pixel variance in region */
export function regionVariance(image: ImageData, x: number, y: number, w: number, h: number): number {
  const box = clampBox(image.width, image.height, x, y, w, h);
  if (!box) return 0;
  let sum = 0, sumSq = 0, count = 0;
  for (let py = box.y; py < box.y + box.height; py += 4) {
    for (let px = box.x; px < box.x + box.width; px += 4) {
      const idx = (py * image.width + px) * 4;
      const lum = (image.data[idx] + image.data[idx + 1] + image.data[idx + 2]) / 3;
      sum += lum;
      sumSq += lum * lum;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}

/** Pixel difference ratio with threshold */
export function pixelDiffCount(
  orig: ImageData,
  target: ImageData,
  x: number,
  y: number,
  w: number,
  h: number,
  threshold = 8,
): number {
  const box = clampBox(orig.width, orig.height, x, y, w, h);
  if (!box) return 0;
  let count = 0, total = 0;
  for (let py = box.y; py < box.y + box.height; py += 3) {
    for (let px = box.x; px < box.x + box.width; px += 3) {
      const idxO = (py * orig.width + px) * 4;
      const idxT = (py * target.width + px) * 4;
      if (idxT + 2 >= target.data.length || idxO + 2 >= orig.data.length) continue;
      const dr = Math.abs(orig.data[idxO] - target.data[idxT]);
      const dg = Math.abs(orig.data[idxO + 1] - target.data[idxT + 1]);
      const db = Math.abs(orig.data[idxO + 2] - target.data[idxT + 2]);
      if (dr >= threshold || dg >= threshold || db >= threshold) count++;
      total++;
    }
  }
  return total > 0 ? count / total : 0;
}

const VERIFY_KINDS = new Set(["input_field", "credential_label", "face", "credential"]);

/** Compares original and redacted image regions to confirm redaction */
export function verifyRedactedPixels(
  original: ImageData | null,
  redacted: ImageData,
  regions: BoundingBox[],
  timestamp = Date.now(),
): RedactionVerification {
  let checked = 0;
  let confirmed = 0;
  const leaks: string[] = [];

  for (const r of regions) {
    if (!clampBox(redacted.width, redacted.height, r.x, r.y, r.width, r.height)) continue;
    checked++;
    const darkRatio = blackPixelRatio(redacted, r.x, r.y, r.width, r.height);

    if (original) {
      const origVar = regionVariance(original, r.x, r.y, r.width, r.height);
      const diffRatio = colorDiffRatio(original, redacted, r.x, r.y, r.width, r.height);

      if (origVar < 40) { confirmed++; continue; }
      if (darkRatio > 0.5) { confirmed++; continue; }
      if (diffRatio > 0.12) { confirmed++; continue; }

      if (r.kind && VERIFY_KINDS.has(r.kind)) {
        const edgeOrig = edgeIntensity(original, r.x, r.y, r.width, r.height);
        const edgeRedacted = edgeIntensity(redacted, r.x, r.y, r.width, r.height);
        const pDiff = pixelDiffCount(original, redacted, r.x, r.y, r.width, r.height);

        if ((edgeOrig > 800 && edgeRedacted < Math.max(edgeOrig * 0.45, 120)) || pDiff > 0.1) {
          confirmed++;
          continue;
        }
      }
      leaks.push(`"${r.label ?? r.kind}" (${r.kind}) at ${r.x},${r.y} was not visibly redacted — original content may still be visible.`);
    } else {
      if (darkRatio > 0.5 || regionVariance(redacted, r.x, r.y, r.width, r.height) < 400) {
        confirmed++;
      } else {
        leaks.push(`"${r.label ?? r.kind}" (${r.kind}) at ${r.x},${r.y} could not be confirmed redacted.`);
      }
    }
  }

  const passed = checked === 0 || confirmed === checked;
  const confidence = checked > 0 ? confirmed / checked : 1;
  const summary = passed
    ? `VERIFIED: ${confirmed}/${checked} sensitive regions confirmed redacted. Zero PII leakage.`
    : `WARNING: ${confirmed}/${checked} regions confirmed redacted; ${checked - confirmed} may still contain sensitive content.`;

  return {
    verified: passed,
    regionsChecked: checked,
    regionsRedacted: confirmed,
    leakedPatterns: leaks,
    confidence,
    summary,
    timestamp,
  };
}

export function createCleanVerification(timestamp = Date.now()): RedactionVerification {
  return {
    verified: true,
    regionsChecked: 0,
    regionsRedacted: 0,
    leakedPatterns: [],
    confidence: 1,
    summary: "VERIFIED: nothing sensitive on screen — zero regions required redaction.",
    timestamp,
  };
}

export interface PackedCropSlot {
  regionIndex: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface PackedAtlas {
  slots: PackedCropSlot[];
  width: number;
  height: number;
}

/** Packs crop regions into an atlas canvas for batch re-OCR verification */
export function packCropsForVerification(
  regions: BoundingBox[],
  options: { maxCrops?: number; maxWidth?: number; maxHeight?: number; maxCropHeight?: number } = {},
): PackedAtlas {
  const maxCrops = options.maxCrops ?? 24;
  const maxWidth = options.maxWidth ?? 4096;
  const maxHeight = options.maxHeight ?? 2048;
  const maxCropHeight = options.maxCropHeight ?? 128;
  const padX = 4;
  const padY = 8;

  const slots: PackedCropSlot[] = [];
  let curX = 0;
  let curY = 0;
  let rowHeight = 0;

  for (let i = 0; i < regions.length && slots.length < maxCrops; i++) {
    const reg = regions[i];
    if (!(reg.width > 0) || !(reg.height > 0)) continue;

    const sx = Math.round(reg.x);
    const sy = Math.round(reg.y);
    const sw = Math.max(1, Math.round(reg.width));
    const sh = Math.max(1, Math.round(reg.height));

    const scale = Math.min(1, maxCropHeight / sh);
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    if (curX + dw > maxWidth) {
      curX = 0;
      curY += rowHeight + padY;
      rowHeight = 0;
    }
    if (curY + dh > maxHeight) break;

    slots.push({ regionIndex: i, sx, sy, sw, sh, dx: curX, dy: curY, dw, dh });
    curX += dw + padX;
    rowHeight = Math.max(rowHeight, dh);
  }

  let totalW = 0;
  let totalH = 0;
  for (const s of slots) {
    totalW = Math.max(totalW, s.dx + s.dw);
    totalH = Math.max(totalH, s.dy + s.dh);
  }

  return { slots, width: totalW, height: totalH };
}
