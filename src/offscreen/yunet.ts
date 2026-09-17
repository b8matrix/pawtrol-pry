import * as ort from "onnxruntime-web";
import { clusterBoxes } from "./blur";
import { createSessionWithFallback, getModelUrl } from "./ort";
import type { BoundingBox } from "./types";

let yunetSession: ort.InferenceSession | null = null;
let sessionLoading: Promise<ort.InferenceSession> | null = null;

const MODEL_FILE = "face_detection_yunet_2023mar.onnx";
const INPUT_W = 640;
const INPUT_H = 640;

export async function getYuNetSession(): Promise<ort.InferenceSession> {
  if (yunetSession) return yunetSession;
  if (sessionLoading) return sessionLoading;

  sessionLoading = (async () => {
    const modelUrl = getModelUrl(MODEL_FILE);
    const { session } = await createSessionWithFallback(modelUrl);
    yunetSession = session;
    sessionLoading = null;
    return session;
  })();

  return sessionLoading;
}

/** Prepares 1x3x640x640 float32 tensor from canvas */
function prepareYuNetInput(
  ctx: OffscreenCanvasRenderingContext2D,
  origW: number,
  origH: number,
): { tensor: ort.Tensor; scaleX: number; scaleY: number } {
  const canvas = new OffscreenCanvas(INPUT_W, INPUT_H);
  const tempCtx = canvas.getContext("2d", { willReadFrequently: true })!;
  tempCtx.drawImage(ctx.canvas, 0, 0, INPUT_W, INPUT_H);
  const imgData = tempCtx.getImageData(0, 0, INPUT_W, INPUT_H);

  const floatData = new Float32Array(1 * 3 * INPUT_H * INPUT_W);
  const planeSize = INPUT_W * INPUT_H;

  for (let i = 0; i < planeSize; i++) {
    // YuNet expects BGR or RGB float32 in [0, 255]
    floatData[i] = imgData.data[i * 4]; // R
    floatData[planeSize + i] = imgData.data[i * 4 + 1]; // G
    floatData[2 * planeSize + i] = imgData.data[i * 4 + 2]; // B
  }

  const tensor = new ort.Tensor("float32", floatData, [1, 3, INPUT_H, INPUT_W]);
  return {
    tensor,
    scaleX: origW / INPUT_W,
    scaleY: origH / INPUT_H,
  };
}

/** Parses YuNet multi-stride outputs */
function parseYuNetDetections(
  results: Record<string, ort.Tensor>,
  scaleX: number,
  scaleY: number,
  scoreThreshold = 0.5,
): BoundingBox[] {
  const strides = [8, 16, 32];
  const boxes: BoundingBox[] = [];

  for (const s of strides) {
    const clsTensor = results[`cls_${s}`];
    const objTensor = results[`obj_${s}`];
    const bboxTensor = results[`bbox_${s}`];

    if (!clsTensor || !bboxTensor) continue;

    const clsData = clsTensor.data as Float32Array;
    const objData = objTensor ? (objTensor.data as Float32Array) : null;
    const bboxData = bboxTensor.data as Float32Array;

    const cols = INPUT_W / s;
    const rows = INPUT_H / s;
    const numAnchors = cols * rows;

    for (let i = 0; i < numAnchors; i++) {
      const clsVal = clsData[i];
      const objVal = objData ? objData[i] : 1.0;
      const score = Math.sqrt(Math.max(0, clsVal * objVal));

      if (score >= scoreThreshold) {
        const cx = i % cols;
        const cy = Math.floor(i / cols);

        const bIdx = i * 4;
        const dx = bboxData[bIdx];
        const dy = bboxData[bIdx + 1];
        const dw = bboxData[bIdx + 2];
        const dh = bboxData[bIdx + 3];

        const xCenter = (cx + dx) * s;
        const yCenter = (cy + dy) * s;
        const w = Math.exp(dw) * s;
        const h = Math.exp(dh) * s;

        const xMin = Math.max(0, (xCenter - w / 2) * scaleX);
        const yMin = Math.max(0, (yCenter - h / 2) * scaleY);
        const finalW = w * scaleX;
        const finalH = h * scaleY;

        if (finalW > 10 && finalH > 10) {
          boxes.push({
            x: Math.round(xMin),
            y: Math.round(yMin),
            width: Math.round(finalW),
            height: Math.round(finalH),
            confidence: score,
            kind: "face",
            label: "Face detected",
          });
        }
      }
    }
  }

  return clusterBoxes(boxes);
}

// ---------------------------------------------------------------------------
// Baseline skin-color heuristic and Chrome FaceDetector fallbacks
// ---------------------------------------------------------------------------

function isSkinTone(r: number, g: number, b: number): boolean {
  const classic = r > 95 && g > 40 && b > 20 && r > g && r > b && Math.abs(r - g) > 15 && r - b > 15;
  const sum = r + g + b;
  if (sum === 0) return false;
  const nr = r / sum, ng = g / sum, nb = b / sum;
  const norm = nr > 0.28 && nr < 0.55 && ng > 0.18 && ng < 0.42 && nb > 0.08 && nb < 0.32 && nr > nb;
  return classic || norm;
}

export function detectSkinColorFaces(
  imageData: ImageData,
  width: number,
  height: number,
): BoundingBox[] {
  const { data } = imageData;
  const step = 12;
  const minPixels = 40;
  const mask = new Uint8Array(width * height);

  for (let i = 0; i < mask.length; i++) {
    const idx = i * 4;
    mask[i] = isSkinTone(data[idx], data[idx + 1], data[idx + 2]) ? 1 : 0;
  }

  const found: BoundingBox[] = [];
  const visited = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const startIdx = y * width + x;
      if (!mask[startIdx] || visited[startIdx]) continue;

      let minX = x, maxX = x, minY = y, maxY = y;
      let count = 0;
      const stack = [startIdx];

      while (stack.length > 0 && count < 2000) {
        const idx = stack.pop()!;
        if (visited[idx]) continue;
        visited[idx] = 1;

        const cx = idx % width;
        const cy = Math.floor(idx / width);
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        count++;

        for (const [dx, dy] of [[0, -step], [0, step], [-step, 0], [step, 0]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nIdx = ny * width + nx;
            if (mask[nIdx] && !visited[nIdx]) stack.push(nIdx);
          }
        }
      }

      if (count >= minPixels) {
        const w = maxX - minX;
        const h = maxY - minY;
        const aspect = w / h;
        if (aspect > 0.5 && aspect < 2.0 && w > 28 && h > 28) {
          found.push({
            x: minX,
            y: minY,
            width: w,
            height: h,
            confidence: Math.min(0.9, count / 200),
            kind: "face",
            label: "Face detected",
          });
        }
      }
    }
  }

  return clusterBoxes(found).slice(0, 8);
}

/** Detects faces using YuNet ONNX with fallback to native Chrome FaceDetector / skin heuristic */
export async function detectFaces(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): Promise<BoundingBox[]> {
  try {
    const session = await getYuNetSession();
    const { tensor, scaleX, scaleY } = prepareYuNetInput(ctx, width, height);
    const inputName = session.inputNames[0];
    const results = await session.run({ [inputName]: tensor });
    const boxes = parseYuNetDetections(results, scaleX, scaleY, 0.45);
    if (boxes.length > 0) {
      console.log(`[PRY Offscreen] YuNet detected ${boxes.length} face(s)`);
      return boxes;
    }
  } catch (err) {
    console.warn("[PRY Offscreen] YuNet face detection error, falling back:", err);
  }

  // Native Chrome FaceDetector fallback
  if (typeof (globalThis as any).FaceDetector !== "undefined") {
    try {
      const detector = new (globalThis as any).FaceDetector({ fastMode: true, maxDetectedFaces: 10 });
      const blob = await ctx.canvas.convertToBlob();
      const bitmap = await createImageBitmap(blob);
      const nativeFaces = await detector.detect(bitmap);
      bitmap.close();
      if (nativeFaces.length > 0) {
        return nativeFaces.map((f: any) => ({
          x: f.boundingBox.x,
          y: f.boundingBox.y,
          width: f.boundingBox.width,
          height: f.boundingBox.height,
          confidence: 0.95,
          kind: "face",
          label: "Face detected",
        }));
      }
    } catch {}
  }

  // Skin color heuristic fallback
  const imgData = ctx.getImageData(0, 0, width, height);
  const heuristicFaces = detectSkinColorFaces(imgData, width, height);
  console.log(`[PRY Offscreen] Skin-color heuristic found ${heuristicFaces.length} face(s)`);
  return heuristicFaces;
}
