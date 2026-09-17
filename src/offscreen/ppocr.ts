import * as ort from "onnxruntime-web";
import { createSessionWithFallback, getModelUrl, runSession } from "./ort";
import type { BoundingBox } from "./types";

let ppocrSession: ort.InferenceSession | null = null;
let sessionLoading: Promise<ort.InferenceSession> | null = null;

const MODEL_FILE = "ch_PP-OCRv4_det_infer.quant.onnx";

export async function getPPOCRSession(): Promise<ort.InferenceSession> {
  if (ppocrSession) return ppocrSession;
  if (sessionLoading) return sessionLoading;

  sessionLoading = (async () => {
    const modelUrl = getModelUrl(MODEL_FILE);
    const { session } = await createSessionWithFallback(modelUrl);
    ppocrSession = session;
    sessionLoading = null;
    return session;
  })();

  return sessionLoading;
}

/** Prepares a normalized CHW float32 tensor from ImageData for PP-OCRv4 */
function prepareImageTensor(
  ctx: OffscreenCanvasRenderingContext2D,
  origW: number,
  origH: number,
  maxSide = 960,
): { tensor: ort.Tensor; targetW: number; targetH: number; scaleX: number; scaleY: number } {
  let targetW = origW;
  let targetH = origH;
  const ratio = Math.min(maxSide / origW, maxSide / origH, 1.0);
  targetW = Math.max(32, Math.round((origW * ratio) / 32) * 32);
  targetH = Math.max(32, Math.round((origH * ratio) / 32) * 32);

  const canvas = new OffscreenCanvas(targetW, targetH);
  const tempCtx = canvas.getContext("2d", { willReadFrequently: true })!;
  tempCtx.drawImage(ctx.canvas, 0, 0, targetW, targetH);
  const imgData = tempCtx.getImageData(0, 0, targetW, targetH);

  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const floatData = new Float32Array(1 * 3 * targetH * targetW);
  const planeSize = targetW * targetH;

  for (let i = 0; i < planeSize; i++) {
    const r = imgData.data[i * 4] / 255.0;
    const g = imgData.data[i * 4 + 1] / 255.0;
    const b = imgData.data[i * 4 + 2] / 255.0;

    floatData[i] = (r - mean[0]) / std[0];
    floatData[planeSize + i] = (g - mean[1]) / std[1];
    floatData[2 * planeSize + i] = (b - mean[2]) / std[2];
  }

  const tensor = new ort.Tensor("float32", floatData, [1, 3, targetH, targetW]);
  return {
    tensor,
    targetW,
    targetH,
    scaleX: origW / targetW,
    scaleY: origH / targetH,
  };
}

/** DB post-processing expansion ratio (PaddleOCR's det_db_unclip_ratio). */
export const UNCLIP_RATIO = 2.0;

/**
 * DBNet post-processing: threshold the probability map, take 4-connected
 * components at full map resolution, and "unclip" each box. DBNet predicts a
 * deliberately shrunk text kernel, so each side is expanded by
 * area * ratio / perimeter (the PaddleOCR formula). Without it boxes cover only
 * the middle of each glyph row and OCR reads garbage.
 */
export function extractBoxesFromProbMap(
  probMap: Float32Array,
  mapW: number,
  mapH: number,
  scaleX: number,
  scaleY: number,
  thresh = 0.3,
  unclipRatio = UNCLIP_RATIO,
): BoundingBox[] {
  const size = mapW * mapH;
  const visited = new Uint8Array(size);
  const stack = new Int32Array(size);
  const boxes: BoundingBox[] = [];

  for (let start = 0; start < size; start++) {
    if (visited[start] || probMap[start] <= thresh) continue;

    let minX = mapW, maxX = -1, minY = mapH, maxY = -1;
    let count = 0;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;

    while (top > 0) {
      const idx = stack[--top];
      const x = idx % mapW;
      const y = (idx - x) / mapW;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [x > 0 ? idx - 1 : -1, x < mapW - 1 ? idx + 1 : -1, y > 0 ? idx - mapW : -1, y < mapH - 1 ? idx + mapW : -1];
      for (const n of neighbors) {
        if (n >= 0 && !visited[n] && probMap[n] > thresh) {
          visited[n] = 1;
          stack[top++] = n;
        }
      }
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (count < 8 || w < 3 || h < 2) continue;

    const offset = (w * h * unclipRatio) / (2 * (w + h));
    const x0 = Math.max(0, minX - offset);
    const y0 = Math.max(0, minY - offset);
    const x1 = Math.min(mapW, maxX + 1 + offset);
    const y1 = Math.min(mapH, maxY + 1 + offset);

    boxes.push({
      x: Math.floor(x0 * scaleX),
      y: Math.floor(y0 * scaleY),
      width: Math.ceil((x1 - x0) * scaleX),
      height: Math.ceil((y1 - y0) * scaleY),
      confidence: 0.9,
      kind: "ocr_text",
      label: "Detected text",
      source: "ppocr",
    });
  }
  return boxes;
}

/** Runs PP-OCRv4 detection across a canvas image */
export async function detectTextRegions(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): Promise<BoundingBox[]> {
  const session = await getPPOCRSession();
  const { tensor, targetW, targetH, scaleX, scaleY } = prepareImageTensor(ctx, width, height);

  const inputName = session.inputNames[0];
  const feeds: Record<string, ort.Tensor> = { [inputName]: tensor };
  const results = await runSession(session, feeds);

  const outputName = session.outputNames[0];
  const outputTensor = results[outputName];
  const probData = outputTensor.data as Float32Array;

  const boxes = extractBoxesFromProbMap(probData, targetW, targetH, scaleX, scaleY);
  return boxes;
}
