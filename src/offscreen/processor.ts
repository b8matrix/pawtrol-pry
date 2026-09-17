import type { SensitiveRegion } from "../shared/types";
import { applyBoxBlur, clampBox } from "./blur";
import { fuseSignalsAndFindMissedPII } from "./fusion";
import { recognizeText } from "./ocr";
import { getActiveBackend } from "./ort";
import { detectTextRegions } from "./ppocr";
import { getSurrogateForKind } from "./surrogate";
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
  const [ppocrBoxes, faceBoxes] = await Promise.all([
    detectTextRegions(mainCtx, width, height).catch((err) => {
      console.warn("[PRY Offscreen] PP-OCRv4 text detection error:", err);
      return [] as BoundingBox[];
    }),
    detectFaces(mainCtx, width, height).catch((err) => {
      console.warn("[PRY Offscreen] Face detection error:", err);
      return [] as BoundingBox[];
    }),
  ]);
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

    if (reg.kind === "credential_label" || reg.kind === "input_field") {
      applyBoxBlur(mainCtx, clamped.x, clamped.y, clamped.width, clamped.height, 6 * dpr);
    } else {
      mainCtx.fillStyle = "#ffffff";
      mainCtx.fillRect(clamped.x, clamped.y, clamped.width, clamped.height);
      mainCtx.strokeStyle = "#6366f1";
      mainCtx.lineWidth = Math.max(1, Math.round(dpr));
      mainCtx.strokeRect(clamped.x, clamped.y, clamped.width, clamped.height);

      const surrogate = getSurrogateForKind(reg.kind || reg.label);
      mainCtx.fillStyle = "#0f172a";
      mainCtx.font = `600 ${Math.max(9, Math.round(Math.min(clamped.height * 0.45, 12 * dpr)))}px system-ui, -apple-system, sans-serif`;
      mainCtx.textBaseline = "middle";
      mainCtx.textAlign = "left";
      const textPad = 4 * dpr;
      mainCtx.fillText(
        `🔒 ${surrogate}`,
        clamped.x + textPad,
        clamped.y + clamped.height / 2,
        Math.max(10, clamped.width - textPad * 2),
      );
    }

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
    });
  }

  // 3b. Mask DOM-missed PII (Canvas, PNG, Image text identified by OCR & checksums)
  for (const match of missedPII) {
    const b = match.box;
    mainCtx.fillStyle = "#ffffff";
    mainCtx.fillRect(b.x, b.y, b.width, b.height);
    mainCtx.strokeStyle = "#ef4444";
    mainCtx.lineWidth = Math.max(1, Math.round(dpr));
    mainCtx.strokeRect(b.x, b.y, b.width, b.height);

    const surrogate = getSurrogateForKind(match.kind || match.label);
    mainCtx.fillStyle = "#0f172a";
    mainCtx.font = `600 ${Math.max(9, Math.round(Math.min(b.height * 0.45, 12 * dpr)))}px system-ui, -apple-system, sans-serif`;
    mainCtx.textBaseline = "middle";
    mainCtx.textAlign = "left";
    mainCtx.fillText(`🔒 ${surrogate}`, b.x + 4 * dpr, b.y + b.height / 2, Math.max(10, b.width - 8 * dpr));

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
      confidence: 0.95,
      label: match.label,
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
  };
}
