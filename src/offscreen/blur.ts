import type { BoundingBox } from "./types";

/** Clamps a bounding box to the dimensions of an image/canvas. */
export function clampBox(
  imageWidth: number,
  imageHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  const minX = Math.max(0, Math.round(x));
  const minY = Math.max(0, Math.round(y));
  const maxX = Math.min(imageWidth, Math.round(x + width));
  const maxY = Math.min(imageHeight, Math.round(y + height));
  if (maxX - minX <= 0 || maxY - minY <= 0) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 1D horizontal & vertical box blur pass across an RGBA channel */
export function boxBlurChannel(imageData: ImageData, channelOffset: number, radius: number): void {
  const { width: w, height: h, data } = imageData;
  const temp = new Float64Array(w * h);
  const diameter = radius * 2 + 1;

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      const clampedX = Math.min(w - 1, Math.max(0, i));
      sum += data[(rowOffset + clampedX) * 4 + channelOffset];
    }
    for (let x = 0; x < w; x++) {
      temp[rowOffset + x] = sum / diameter;
      const nextX = Math.min(w - 1, x + radius + 1);
      const prevX = Math.max(0, x - radius);
      sum += data[(rowOffset + nextX) * 4 + channelOffset] - data[(rowOffset + prevX) * 4 + channelOffset];
    }
  }

  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      const clampedY = Math.min(h - 1, Math.max(0, i));
      sum += temp[clampedY * w + x];
    }
    for (let y = 0; y < h; y++) {
      data[(y * w + x) * 4 + channelOffset] = sum / diameter;
      const nextY = Math.min(h - 1, y + radius + 1);
      const prevY = Math.max(0, y - radius);
      sum += temp[nextY * w + x] - temp[prevY * w + x];
    }
  }
}

/** Applies high-quality box blur to a region on an OffscreenCanvas context */
export function applyBoxBlur(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const clampedRadius = Math.min(40, Math.max(2, Math.round(radius)));
  const imgData = ctx.getImageData(x, y, width, height);
  boxBlurChannel(imgData, 0, clampedRadius); // Red
  boxBlurChannel(imgData, 1, clampedRadius); // Green
  boxBlurChannel(imgData, 2, clampedRadius); // Blue
  ctx.putImageData(imgData, x, y);
}

/** Checks if two bounding boxes intersect */
export function boxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
}

/** Merges two overlapping bounding boxes */
export function mergeBoxes(a: BoundingBox, b: BoundingBox): BoundingBox {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    confidence: Math.max(a.confidence ?? 0.5, b.confidence ?? 0.5),
    label: a.label ?? b.label,
    kind: a.kind ?? b.kind,
  };
}

/** Merges overlapping bounding boxes in a list (NMS-style clustering) */
export function clusterBoxes(boxes: BoundingBox[]): BoundingBox[] {
  if (boxes.length <= 1) return boxes;
  const merged: BoundingBox[] = [];
  const visited = new Set<number>();

  for (let i = 0; i < boxes.length; i++) {
    if (visited.has(i)) continue;
    let current = boxes[i];
    visited.add(i);

    for (let j = i + 1; j < boxes.length; j++) {
      if (visited.has(j)) continue;
      if (boxesIntersect(current, boxes[j])) {
        current = mergeBoxes(current, boxes[j]);
        visited.add(j);
      }
    }
    merged.push(current);
  }
  return merged;
}
