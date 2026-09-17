import * as ort from "onnxruntime-web";
import { createSessionWithFallback, getModelUrl } from "./ort";
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
  maxSide = 640,
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

/** Post-processes the probability map to find text bounding boxes */
function extractBoxesFromProbMap(
  probMap: Float32Array,
  mapW: number,
  mapH: number,
  scaleX: number,
  scaleY: number,
  thresh = 0.3,
): BoundingBox[] {
  const binary = new Uint8Array(mapW * mapH);
  for (let i = 0; i < binary.length; i++) {
    binary[i] = probMap[i] > thresh ? 1 : 0;
  }

  const visited = new Uint8Array(binary.length);
  const boxes: BoundingBox[] = [];
  const step = 4;

  for (let y = 0; y < mapH; y += step) {
    for (let x = 0; x < mapW; x += step) {
      const startIdx = y * mapW + x;
      if (!binary[startIdx] || visited[startIdx]) continue;

      let minX = x, maxX = x, minY = y, maxY = y;
      let count = 0;
      const queue = [startIdx];

      while (queue.length > 0 && count < 3000) {
        const idx = queue.pop()!;
        if (visited[idx]) continue;
        visited[idx] = 1;
        count++;

        const cx = idx % mapW;
        const cy = Math.floor(idx / mapW);
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);

        for (const [dx, dy] of [[-step, 0], [step, 0], [0, -step], [0, step]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && nx < mapW && ny >= 0 && ny < mapH) {
            const nIdx = ny * mapW + nx;
            if (binary[nIdx] && !visited[nIdx]) {
              queue.push(nIdx);
            }
          }
        }
      }

      const boxW = maxX - minX;
      const boxH = maxY - minY;
      if (boxW >= 4 && boxH >= 4 && count >= 8) {
        // Expand slightly (unclip)
        const padX = Math.round(boxW * 0.1);
        const padY = Math.round(boxH * 0.1);

        boxes.push({
          x: Math.max(0, Math.round((minX - padX) * scaleX)),
          y: Math.max(0, Math.round((minY - padY) * scaleY)),
          width: Math.round((boxW + padX * 2) * scaleX),
          height: Math.round((boxH + padY * 2) * scaleY),
          confidence: 0.9,
          kind: "ocr_text",
          label: "Detected text",
        });
      }
    }
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
  const results = await session.run(feeds);

  const outputName = session.outputNames[0];
  const outputTensor = results[outputName];
  const probData = outputTensor.data as Float32Array;

  const boxes = extractBoxesFromProbMap(probData, targetW, targetH, scaleX, scaleY);
  return boxes;
}
