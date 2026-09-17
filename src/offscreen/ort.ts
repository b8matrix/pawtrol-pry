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
    loadPromise(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Model load timeout after ${timeoutMs}ms for ${modelUrl}`)), timeoutMs),
    ),
  ]);
}
