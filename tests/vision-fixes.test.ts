// Regression tests for the vision-pipeline fixes: serialized ONNX inference,
// fail-closed classification of pixel text, zero-width handling, opaque mask
// captions, and the worker's send gate.

import { describe, expect, test } from "vitest";
import { isSafeToSend } from "../src/background/agent/loop";
import { classifyOcrText, evaluateTextPII } from "../src/offscreen/fusion";
import { runExclusive } from "../src/offscreen/ort";
import { maskCaption } from "../src/offscreen/processor";
import { extractPIIPatternLabels } from "../src/offscreen/verify";
import { isValidAadhaar } from "../src/shared/checksums";
import { mapRangeToOriginal, normalizeOcrDigits, stripInvisible, stripInvisibleWithMap } from "../src/shared/text";

const ZW_AADHAAR = "2\u200B3\u200C4\u200D5\uFEFF 6\u200B7\u200C8\u200D9\uFEFF 0\u200B1\u200C2\u200D4";

describe("zero-width normalization", () => {
  test("strips invisible characters", () => {
    expect(stripInvisible(ZW_AADHAAR)).toBe("2345 6789 0124");
  });

  test("maps a normalized match back to the original offsets", () => {
    const original = `Aadhaar: ${ZW_AADHAAR} on file`;
    const normalized = stripInvisibleWithMap(original);
    const match = normalized.text.match(/\d{4} \d{4} \d{4}/)!;
    const [start, end] = mapRangeToOriginal(normalized, match.index!, match.index! + match[0].length);
    expect(original.slice(start, end)).toBe(ZW_AADHAAR);
    expect(isValidAadhaar(original.slice(start, end))).toBe(true);
  });
});

describe("OCR digit normalization", () => {
  test("fixes lookalike letters inside numbers only", () => {
    expect(normalizeOcrDigits("2345 6789 O124")).toBe("2345 6789 0124");
    expect(normalizeOcrDigits("4lll 1111 IIII 1111")).toBe("4111 1111 1111 1111");
    expect(normalizeOcrDigits("GOVERNMENT OF INDIA")).toBe("GOVERNMENT OF INDIA");
  });

  test("a misread Aadhaar is still recognized", () => {
    expect(evaluateTextPII("2345 6789 O124")?.label).toContain("Aadhaar");
  });
});

describe("pixel text classification fails closed", () => {
  test("unreadable crops are masked", () => {
    expect(classifyOcrText(null)).toMatchObject({ reason: "uncertain" });
  });

  test("validated PII is masked as PII", () => {
    expect(classifyOcrText("GOVERNMENT OF INDIA\n2345 6789 0124")).toMatchObject({ reason: "pii", kind: "id_number" });
    expect(classifyOcrText("Billing Card on File: 4111 1111 1111 1111 (Visa)")).toMatchObject({ reason: "pii" });
  });

  test("long numbers that fail checksums are masked as uncertain", () => {
    // One digit misread: Verhoeff fails, but it is still an ID-shaped number.
    expect(classifyOcrText("2345 6789 0125")).toMatchObject({ reason: "uncertain" });
    expect(classifyOcrText("A/c 000123456789")).toMatchObject({ reason: "uncertain" });
  });

  test("short numbers next to sensitive labels are masked", () => {
    expect(classifyOcrText("CVV: 892 | Exp: 12/28")).toMatchObject({ reason: "uncertain" });
    expect(classifyOcrText("Your OTP is 482913")).not.toBeNull();
  });

  test("ordinary text stays visible", () => {
    expect(classifyOcrText("GOVERNMENT OF INDIA")).toBeNull();
    expect(classifyOcrText("Customer since 2019")).toBeNull();
    expect(classifyOcrText("Chapter 12: Results")).toBeNull();
  });
});

describe("mask captions never look like PII", () => {
  test("captions describe the hidden value without digits or PII shapes", () => {
    const cases: [string, string][] = [
      ["id_text", "ID number in text: 2345 678..."],
      ["id_number", "Aadhaar number (Verhoeff ✓)"],
      ["id_number", "PAN card number"],
      ["credit_card", "Card number"],
      ["password", "Password"],
      ["api_key", "API key / token"],
      ["credential", "Email address"],
      ["visual_text", "Unverified long number in image"],
      ["input_field", "Public Support Tracking Reference:"],
    ];
    for (const [kind, label] of cases) {
      const caption = maskCaption(kind, label);
      expect(caption, `${kind} / ${label}`).not.toMatch(/\d/);
      expect(extractPIIPatternLabels(caption), caption).toEqual([]);
    }
    expect(maskCaption("id_number", "Aadhaar number (Verhoeff ✓)")).toBe("Aadhaar hidden");
    expect(maskCaption("id_number", "PAN card number")).toBe("PAN hidden");
  });
});

describe("ONNX inference is serialized", () => {
  test("tasks queued concurrently never overlap, and a failure does not stall the queue", async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const task = (n: number, fail = false) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5 + (5 - n)));
      active--;
      order.push(n);
      if (fail) throw new Error(`task ${n} failed`);
      return n;
    };
    const results = await Promise.allSettled([
      runExclusive(task(1)),
      runExclusive(task(2, true)),
      runExclusive(task(3)),
      runExclusive(task(4)),
    ]);
    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  });
});

describe("worker send gate", () => {
  test("only a positively verified redaction may leave the device", () => {
    expect(isSafeToSend({ redactedDataUrl: "data:image/jpeg;base64,x", verification: { verified: true } })).toBe(true);
    expect(isSafeToSend({ redactedDataUrl: "data:image/jpeg;base64,x", verification: { verified: false } })).toBe(false);
    expect(isSafeToSend({ redactedDataUrl: "data:image/jpeg;base64,x" })).toBe(false);
    expect(isSafeToSend({ redactedDataUrl: null, verification: { verified: true } })).toBe(false);
  });
});

describe("PP-OCR probability map post-processing", () => {
  function mapWithKernel(mapW: number, mapH: number, x: number, y: number, w: number, h: number): Float32Array {
    const map = new Float32Array(mapW * mapH);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) map[yy * mapW + xx] = 0.9;
    return map;
  }

  test("expands a shrunk text kernel to cover the whole text line", async () => {
    const { extractBoxesFromProbMap } = await import("../src/offscreen/ppocr");
    // A 200x6 kernel (DBNet's shrunk core of a ~20px-tall line) at map scale 1.
    const boxes = extractBoxesFromProbMap(mapWithKernel(400, 100, 50, 40, 200, 6), 400, 100, 1, 1);
    expect(boxes).toHaveLength(1);
    const [box] = boxes;
    // offset = 200*6*2 / (2*206) ≈ 5.8 px each side → ~18px tall, not the 6px kernel.
    expect(box.height).toBeGreaterThanOrEqual(17);
    expect(box.y).toBeLessThanOrEqual(35);
    expect(box.x).toBeLessThanOrEqual(45);
    expect(box.x + box.width).toBeGreaterThanOrEqual(255);
  });

  test("keeps exact kernel edges (no grid-sampling loss) and scales to screenshot pixels", async () => {
    const { extractBoxesFromProbMap } = await import("../src/offscreen/ppocr");
    const boxes = extractBoxesFromProbMap(mapWithKernel(100, 50, 13, 21, 30, 3), 100, 50, 2, 2, 0.3, 0);
    expect(boxes).toEqual([
      expect.objectContaining({ x: 26, y: 42, width: 60, height: 6 }),
    ]);
  });

  test("separate lines stay separate boxes and specks are ignored", async () => {
    const { extractBoxesFromProbMap } = await import("../src/offscreen/ppocr");
    const map = mapWithKernel(300, 100, 10, 10, 120, 5);
    for (let yy = 40; yy < 45; yy++) for (let xx = 10; xx < 130; xx++) map[yy * 300 + xx] = 0.8;
    map[90 * 300 + 250] = 0.9; // single-pixel noise
    expect(extractBoxesFromProbMap(map, 300, 100, 1, 1)).toHaveLength(2);
  });
});
