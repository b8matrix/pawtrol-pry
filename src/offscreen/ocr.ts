import { createWorker, type Worker } from "tesseract.js";

let workerPromise: Promise<Worker> | null = null;

function getVendorUrl(relPath: string): string {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(`vendor/${relPath}`);
  }
  return `/vendor/${relPath}`;
}

export async function getOCRWorker(): Promise<Worker | null> {
  if (workerPromise) return workerPromise;

  try {
    workerPromise = createWorker("eng", 1, {
      workerPath: getVendorUrl("worker.min.js"),
      corePath: getVendorUrl("tesseract-core/tesseract-core-simd-lstm.wasm.js"),
      langPath: getVendorUrl("lang"),
      gzip: true,
      workerBlobURL: false,
      logger: () => {},
    });
    const w = await workerPromise;
    return w;
  } catch (err) {
    console.warn("[PRY Offscreen] Failed to initialize Tesseract worker:", err);
    workerPromise = null;
    return null;
  }
}

/** Runs OCR on an image data URL with timeout */
export async function recognizeText(imageDataUrl: string, timeoutMs = 8000): Promise<string | null> {
  const worker = await getOCRWorker();
  if (!worker) return null;

  try {
    const race = Promise.race([
      worker.recognize(imageDataUrl),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("OCR timeout")), timeoutMs)),
    ]);
    const res = await race;
    const text = res?.data?.text ?? "";
    return text.trim().length > 0 ? text : null;
  } catch (err) {
    console.warn("[PRY Offscreen] OCR recognition error or timeout:", err);
    return null;
  }
}
