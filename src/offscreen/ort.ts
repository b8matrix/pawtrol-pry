import * as ort from "onnxruntime-web";
import type { ExecutionBackend } from "./types";

let activeBackend: ExecutionBackend = "WASM";
let configured = false;

export function getActiveBackend(): ExecutionBackend {
  return activeBackend;
}

export function configureOrtEnv(): void {
  if (configured) return;
  configured = true;
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/");
  }
}

// onnxruntime-web shares one WASM/WebGPU backend across sessions and does not
// support overlapping session.run calls: concurrent runs fail with "Session
// already started" / "Session mismatch" and can crash the document. Every
// inference goes through this queue.
let inferenceQueue: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = inferenceQueue.then(task, task);
  inferenceQueue = run.catch(() => {});
  return run;
}

export function runSession(
  session: ort.InferenceSession,
  feeds: Record<string, ort.Tensor>,
): Promise<ort.InferenceSession.OnnxValueMapType> {
  return runExclusive(() => session.run(feeds));
}

export function getModelUrl(fileName: string): string {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(`models/${fileName}`);
  }
  return `/models/${fileName}`;
}

export async function createSessionWithFallback(
  modelUrl: string,
  timeoutMs = 15000,
): Promise<{ session: ort.InferenceSession; backend: ExecutionBackend }> {
  configureOrtEnv();

  const loadPromise = async () => {
    // 1. Attempt WebGPU execution provider if navigator.gpu is available
    if (typeof navigator !== "undefined" && "gpu" in navigator && (navigator as any).gpu) {
      try {
        const session = await ort.InferenceSession.create(modelUrl, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
        });
        activeBackend = "WebGPU";
        console.log(`[PRY Offscreen] Successfully initialized WebGPU session for ${modelUrl}`);
        return { session, backend: "WebGPU" as ExecutionBackend };
      } catch (gpuErr) {
        console.warn(`[PRY Offscreen] WebGPU failed for ${modelUrl}, falling back to WASM:`, gpuErr);
      }
    }

    // 2. Fallback to WASM execution provider
    try {
      const session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      activeBackend = "WASM";
      console.log(`[PRY Offscreen] Initialized WASM session for ${modelUrl}`);
      return { session, backend: "WASM" as ExecutionBackend };
    } catch (wasmErr) {
      console.error(`[PRY Offscreen] WASM session load failed for ${modelUrl}:`, wasmErr);
      throw wasmErr;
    }
  };

  return Promise.race([
    // Session creation initializes the shared backend too, so it queues with inference.
    runExclusive(loadPromise),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Model load timeout after ${timeoutMs}ms for ${modelUrl}`)), timeoutMs),
    ),
  ]);
}
