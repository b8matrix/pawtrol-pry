import { processScreenshot } from "./processor";

console.log("[PRY] Offscreen document initialized — WebGPU/WASM on-device vision pipeline ready.");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "process-screenshot" && message.dataUrl && message.width && message.height) {
    const requestId = message.requestId;

    processScreenshot(
      message.dataUrl,
      message.width,
      message.height,
      message.sensitiveRegions ?? [],
      message.dpr ?? 1,
    )
      .then((result) => {
        chrome.runtime.sendMessage({
          type: "screenshot-processed",
          requestId,
          result,
        });
        sendResponse({ received: true });
      })
      .catch((err) => {
        console.error("[PRY Offscreen] Screenshot processing failed:", err);
        // Fail closed: report failure so background aborts screenshot transmission
        chrome.runtime.sendMessage({
          type: "screenshot-processed",
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
        sendResponse({ received: true, error: err instanceof Error ? err.message : String(err) });
      });

    return true; // Keep message channel open for async response
  }

  return false;
});
