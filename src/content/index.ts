// Isolated-world content script (top frame). Answers worker requests and
// relays tripwire alerts raised by the MAIN-world script.

import { performAction } from "./actions";
import { findSensitiveRegions } from "./sensitive-regions";
import { takeSnapshot } from "./snapshot";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.kind) {
    case "ping":
      sendResponse({ ok: true, detail: "alive" });
      return false;

    case "snapshot":
      sendResponse({ ok: true, detail: "snapshot", snapshot: takeSnapshot() });
      return false;

    case "act":
      performAction(message.action).then(sendResponse);
      return true;

    case "capture-screenshot":
      sendResponse({ ok: false, detail: "Screenshot capture must be handled by the service worker" });
      return false;

    case "get-sensitive-regions":
      sendResponse({
        ok: true,
        detail: "sensitive-regions",
        sensitiveRegions: findSensitiveRegions(),
        dpr: window.devicePixelRatio || 1,
      });
      return false;

    case "capture-and-act":
      (async () => {
        try {
          const result = await performAction(message.action);
          sendResponse({ ok: result.ok, detail: result.detail, snapshot: result.snapshot });
        } catch (error) {
          sendResponse({ ok: false, detail: `Action failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      })();
      return true;

    default:
      sendResponse({ ok: false, detail: "Unknown request" });
      return false;
  }
});

window.addEventListener("__PRY_TRIPWIRE_ALERT__", (event) => {
  const detail = (event as CustomEvent).detail;
  if (detail) chrome.runtime.sendMessage({ type: "TRIPWIRE_ALERT", detail }).catch(() => {});
});
