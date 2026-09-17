// Screenshot capture → offscreen redaction. The raw capture never leaves this
// module except to the offscreen document (same extension), which masks
// sensitive regions, blurs faces and re-OCRs the result to verify the masks.

import type { SensitiveRegion } from "../../shared/types";

export interface VisualDetection {
  kind: string;
  label: string;
  confidence: number;
}

export interface RedactionVerification {
  verified: boolean;
  regionsChecked: number;
  regionsRedacted: number;
  leakedPatterns: string[];
  summary: string;
}

export interface ProcessedScreenshot {
  redactedDataUrl: string;
  redactedCount: number;
  detections: VisualDetection[];
  verification?: RedactionVerification;
}

export interface CapturedScreenshot {
  original: string;
  processed: ProcessedScreenshot;
}

const OFFSCREEN_TIMEOUT_MS = 45_000;
const CONTENT_QUERY_TIMEOUT_MS = 15_000;

async function ensureOffscreenDocument(): Promise<void> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
    });
    if (contexts?.length > 0) return;
  } catch {}
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS" as chrome.offscreen.Reason, "BLOBS" as chrome.offscreen.Reason],
      justification: "Canvas screenshot redaction, Tesseract OCR verification, and face detection",
    });
  } catch {}
}

async function captureActiveTab(): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const { width, height } = bitmap;
    bitmap.close();
    return { dataUrl, width, height };
  } catch {
    return null;
  }
}

async function processInOffscreen(
  dataUrl: string,
  width: number,
  height: number,
  sensitiveRegions: SensitiveRegion[] = [],
  dpr = 1,
): Promise<ProcessedScreenshot> {
  await ensureOffscreenDocument();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<ProcessedScreenshot>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onMessage);
      reject(new Error("Offscreen processing timed out after 45s"));
    }, OFFSCREEN_TIMEOUT_MS);
    const onMessage = (message: any) => {
      if (message.type !== "screenshot-processed" || message.requestId !== requestId) return;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(onMessage);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.runtime.sendMessage({ type: "process-screenshot", requestId, dataUrl, width, height, sensitiveRegions, dpr });
  });
}

type QueryOutcome = { ok: true; value: any } | { ok: false; reason: "timeout" | "error" };

function queryTab(tabId: number, message: unknown, timeoutMs = CONTENT_QUERY_TIMEOUT_MS): Promise<QueryOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: QueryOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: "timeout" }), timeoutMs);
    chrome.tabs.sendMessage(tabId, message).then(
      (value) => settle({ ok: true, value }),
      () => settle({ ok: false, reason: "error" }),
    );
  });
}

async function getSensitiveRegions(tabId: number): Promise<{ regions: SensitiveRegion[]; dpr: number } | null> {
  try {
    const ping = await queryTab(tabId, { kind: "ping" });
    if (!ping.ok && ping.reason === "error") {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await new Promise((r) => setTimeout(r, 100));
    }
    const response = await queryTab(tabId, { kind: "get-sensitive-regions" });
    if (!response.ok || !response.value.sensitiveRegions) {
      console.log("[PRY] No sensitive regions returned from content script");
      return null;
    }
    console.log(
      `[PRY] Content script found ${response.value.sensitiveRegions.length} sensitive regions, DPR=${response.value.dpr}`,
    );
    return { regions: response.value.sensitiveRegions, dpr: response.value.dpr ?? 1 };
  } catch (error) {
    console.warn("[PRY] getSensitiveRegions failed:", error);
    return null;
  }
}

/** Capture the visible tab and return both the raw and the redacted image. */
export async function captureAndProcessScreenshot(): Promise<CapturedScreenshot | null> {
  const shot = await captureActiveTab();
  if (!shot) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const regionInfo = tab?.id ? await getSensitiveRegions(tab.id) : null;
  const dpr = regionInfo?.dpr ?? 1;
  const regions = regionInfo?.regions ?? [];
  console.log(`[PRY] Screenshot: ${shot.width}x${shot.height} @ ${dpr}x DPR, ${regions.length} sensitive regions found`);
  const processed = await processInOffscreen(shot.dataUrl, shot.width, shot.height, regions, dpr);
  return { original: shot.dataUrl, processed };
}
