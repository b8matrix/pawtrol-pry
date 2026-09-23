import type { SensitiveRegion } from "../shared/types";
import { applyBoxBlur, clampBox } from "./blur";
import { fuseSignalsAndFindMissedPII } from "./fusion";
import { recognizeText } from "./ocr";
import { getActiveBackend } from "./ort";
import { detectTextRegions } from "./ppocr";
import type {
  BoundingBox,
  PipelineTimings,
  ProcessedScreenshotResult,
  VisualDetection,
} from "./types";
import {
  createCleanVerification,
  extractPIIPatternLabels,
  packCropsForVerification,
  verifyRedactedPixels,
} from "./verify";
import { detectFaces } from "./yunet";

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Blob read failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Short caption drawn on a mask. Deliberately contains no digits or
 * PII-shaped text: realistic surrogate values ("9999 0123 4563") look exactly
 * like leaks to the re-OCR verifier and would fail every screenshot.
 */
export function maskCaption(kind = "", label = ""): string {
  const text = `${kind} ${label}`.toLowerCase();
  if (text.includes("aadhaar")) return "Aadhaar hidden";
  if (text.includes("pan")) return "PAN hidden";
  if (/card|credit|cvv|cvc/.test(text)) return "Card details hidden";
  if (text.includes("password") || text.includes("otp")) return "Password hidden";
  if (/api|token|secret|key/.test(text)) return "Secret hidden";
  if (text.includes("email")) return "Email hidden";
  if (text.includes("phone") || text.includes("mobile")) return "Phone hidden";
  if (text.includes("id")) return "ID hidden";
  return "Hidden";
}

/**
 * Opaque near-black fill: unlike a blur, nothing of the original survives, and
 * the verifier's dark-pixel check (every channel < 30) confirms it regardless of
 * what was underneath. A light fill over a white field changed too few pixels
 * to pass the colour-difference check.
 */
function paintMask(
  ctx: OffscreenCanvasRenderingContext2D,
  box: { x: number; y: number; width: number; height: number },
  caption: string,
  borderColor: string,
  dpr: number,
): void {
  ctx.fillStyle = "#111418";
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = Math.max(1, Math.round(dpr));
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = `600 ${Math.max(9, Math.round(Math.min(box.height * 0.45, 12 * dpr)))}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(`🔒 ${caption}`, box.x + 4 * dpr, box.y + box.height / 2, Math.max(10, box.width - 8 * dpr));
}

/**
 * Main offscreen screenshot privacy processing pipeline.
 * Runs PP-OCRv4 and YuNet in parallel, fuses signals with DOM structure,
 * applies visual masking & unconditional face blurring, verifies with re-OCR,
 * and tracks per-stage timings and active backend.
 */
export async function processScreenshot(
  dataUrl: string,
  width: number,
  height: number,
  sensitiveRegions: SensitiveRegion[] = [],
  dpr = 1,
  mediaRegions?: SensitiveRegion[],
): Promise<ProcessedScreenshotResult> {
  const startTime = performance.now();
  console.log(
    `[PRY Offscreen] Processing ${width}x${height} screenshot (DPR=${dpr}), ${sensitiveRegions.length} DOM regions`,
  );

  // 1. Initialize canvas and draw original capture
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const mainCanvas = new OffscreenCanvas(width, height);
  const mainCtx = mainCanvas.getContext("2d", { willReadFrequently: true })!;
  mainCtx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // Snapshot original image for verification comparisons
  const origCanvas = new OffscreenCanvas(width, height);
  const origCtx = origCanvas.getContext("2d", { willReadFrequently: true })!;
  origCtx.drawImage(mainCanvas, 0, 0);
  const origData = origCtx.getImageData(0, 0, width, height);

  const visualDetections: VisualDetection[] = [];
  const allRedactedBoxes: BoundingBox[] = [];

  // ---------------------------------------------------------------------------
  // Stage 1: Detection (PP-OCRv4 text detection + YuNet face detection in parallel)
  // ---------------------------------------------------------------------------
  const detectStart = performance.now();
  // Sequential on purpose (the ORT backend cannot run sessions concurrently),
  // and no catch: a detector failure rejects the whole screenshot so the
  // worker withholds it instead of treating "no boxes" as "nothing sensitive".
  const ppocrBoxes = await detectTextRegions(mainCtx, width, height);
  const faceBoxes = await detectFaces(mainCtx, width, height);
  const detectDuration = performance.now() - detectStart;

  // ---------------------------------------------------------------------------
  // Stage 2: OCR & Signal Fusion
  // ---------------------------------------------------------------------------
  const ocrStart = performance.now();
  const missedPII = await fuseSignalsAndFindMissedPII(
    mainCtx,
    width,
    height,
    ppocrBoxes,
    sensitiveRegions,
    dpr,
    mediaRegions,
  );
  const ocrDuration = performance.now() - ocrStart;

  // ---------------------------------------------------------------------------
  // Stage 3: Masking
  // ---------------------------------------------------------------------------
  const maskStart = performance.now();

  // 3a. Mask DOM-reported sensitive regions
  for (const reg of sensitiveRegions) {
    const pad = 4 * dpr;
    const clamped = clampBox(
      width,
      height,
      reg.x * dpr - pad,
      reg.y * dpr - pad,
      reg.width * dpr + pad * 2,
      reg.height * dpr + pad * 2,
    );
    if (!clamped) continue;

    paintMask(mainCtx, clamped, maskCaption(reg.kind, reg.label), "#6366f1", dpr);

    allRedactedBoxes.push({
      x: clamped.x,
      y: clamped.y,
      width: clamped.width,
      height: clamped.height,
      kind: reg.kind,
      label: reg.label,
    });
    visualDetections.push({
      kind: reg.kind === "credential_label" || reg.kind === "input_field" ? "credential" : reg.kind,
      box: { x: reg.x, y: reg.y, width: reg.width, height: reg.height },
      confidence: 0.95,
      label: reg.label,
      source: "dom",
    });
  }

  // 3b. Mask DOM-missed PII (Canvas, PNG, Image text identified by OCR & checksums)
  for (const match of missedPII) {
    const b = match.box;
    paintMask(mainCtx, b, maskCaption(match.kind, match.label), "#ef4444", dpr);

    allRedactedBoxes.push({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      kind: match.kind,
      label: match.label,
    });
    visualDetections.push({
      kind: match.kind,
      box: { x: b.x / dpr, y: b.y / dpr, width: b.width / dpr, height: b.height / dpr },
      confidence: match.reason === "pii" ? 0.95 : 0.6,
      label: match.label,
      source: "ppocr+ocr",
    });
  }

  // 3c. Unconditionally blur all detected faces
  for (const f of faceBoxes) {
    const padX = f.width * 0.15;
    const padY = f.height * 0.15;
    const clamped = clampBox(
      width,
      height,
      f.x - padX,
      f.y - padY,
      f.width + padX * 2,
      f.height + padY * 2,
    );
    if (!clamped || clamped.width <= 10 || clamped.height <= 10) continue;

    applyBoxBlur(mainCtx, clamped.x, clamped.y, clamped.width, clamped.height, 12 * dpr);

    allRedactedBoxes.push({
      x: clamped.x,
      y: clamped.y,
      width: clamped.width,
      height: clamped.height,
      kind: "face",
      label: "Face detected",
    });
    visualDetections.push({
      kind: "face",
      box: { x: f.x / width, y: f.y / height, width: f.width / width, height: f.height / height },
      confidence: f.confidence ?? 0.95,
      label: "Face detected",
      source: f.source,
    });
  }
  const maskDuration = performance.now() - maskStart;

  // Convert final redacted canvas to data URL
  const redactedBlob = await mainCanvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const redactedDataUrl = await blobToDataUrl(redactedBlob);

  // ---------------------------------------------------------------------------
  // Stage 4: Verification (Pixel checks + Atlas re-OCR)
  // ---------------------------------------------------------------------------
  const verifyStart = performance.now();
  let verification = createCleanVerification();

  if (allRedactedBoxes.length > 0) {
    try {
      const redactedImgData = mainCtx.getImageData(0, 0, width, height);
      verification = verifyRedactedPixels(origData, redactedImgData, allRedactedBoxes);

      // Re-OCR verification pass on packed crops
      try {
        const atlas = packCropsForVerification(allRedactedBoxes);
        if (atlas.slots.length > 0) {
          const atlasCanvas = new OffscreenCanvas(atlas.width, atlas.height);
          const atlasCtx = atlasCanvas.getContext("2d")!;
          atlasCtx.fillStyle = "#ffffff";
          atlasCtx.fillRect(0, 0, atlas.width, atlas.height);

          const rBitmap = await createImageBitmap(redactedBlob);
          for (const slot of atlas.slots) {
            atlasCtx.drawImage(
              rBitmap,
              slot.sx,
              slot.sy,
              slot.sw,
              slot.sh,
              slot.dx,
              slot.dy,
              slot.dw,
              slot.dh,
            );
          }
          rBitmap.close();

          const atlasBlob = await atlasCanvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
          const atlasDataUrl = await blobToDataUrl(atlasBlob);
          const reOcrText = await recognizeText(atlasDataUrl, 5000);

          if (reOcrText) {
            const leakedLabels = extractPIIPatternLabels(reOcrText);
            verification = {
              ...verification,
              ocrRan: true,
              leakedText: leakedLabels.length > 0 ? reOcrText.slice(0, 300) : undefined,
            };

            if (leakedLabels.length > 0) {
              verification.verified = false;
              verification.leakedPatterns = [
                ...verification.leakedPatterns,
                ...leakedLabels.map((l) => `OCR: ${l} still readable inside a redacted region`),
              ];
              verification.confidence = Math.min(verification.confidence, 0.3);
              verification.summary = `WARNING: OCR found ${leakedLabels.join(", ")} still readable inside a redacted region.`;
            } else {
              verification.summary = `${verification.summary} OCR re-read the redacted regions and found no readable PII.`;
            }
          }
        }
      } catch (ocrErr) {
        console.warn("[PRY Offscreen] Re-OCR pass encountered non-fatal error:", ocrErr);
      }
    } catch (verErr: any) {
      verification = {
        verified: false,
        regionsChecked: 0,
        regionsRedacted: 0,
        leakedPatterns: [`Verification error: ${verErr.message}`],
        confidence: 0,
        summary: "WARNING: verification could not run.",
        timestamp: Date.now(),
      };
    }
  }
  const verifyDuration = performance.now() - verifyStart;
  const totalDuration = performance.now() - startTime;

  const timings: PipelineTimings = {
    detection: Math.round(detectDuration),
    ocr: Math.round(ocrDuration),
    masking: Math.round(maskDuration),
    verification: Math.round(verifyDuration),
    total: Math.round(totalDuration),
  };

  const backend = getActiveBackend();

  console.log(
    `[PRY Offscreen] Completed: ${visualDetections.length} redacted in ${Math.round(totalDuration)}ms (Backend: ${backend}). Timings: det=${timings.detection}ms, ocr=${timings.ocr}ms, mask=${timings.masking}ms, verify=${timings.verification}ms`,
  );

  return {
    redactedDataUrl,
    detections: visualDetections,
    redactedCount: visualDetections.length,
    processingTimeMs: totalDuration,
    verification,
    timings,
    backend,
    maskedBoxes: allRedactedBoxes.map(({ x, y, width, height, kind }) => ({ x, y, width, height, kind: kind ?? "pii" })),
  };
}
