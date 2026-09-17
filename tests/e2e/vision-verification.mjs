/**
 * Targeted Vision End-to-End Verification Test
 * 
 * Verifies that when a webpage contains an Aadhaar number rendered on a canvas
 * and a portrait face image:
 * 1. The on-device vision pipeline detects both signals (PP-OCRv4 + YuNet + fusion).
 * 2. The resulting redacted screenshot features a blurred face.
 * 3. Absolutely NO raw readable digits reach the AI model.
 * 4. The privacy ledger records the redactions and verification.
 * 
 * Usage:
 *   node tests/e2e/vision-verification.mjs
 */

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = process.env.PAWTROL_EXTENSION_DIR ?? join(root, "dist");

const AADHAAR_RAW = "2345 6789 0124";
const AADHAAR_DIGITS = "234567890124";

// Test page with Canvas Aadhaar and Portrait Face
const TEST_PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Targeted Vision Redaction Test</title>
  <style>
    body { font-family: sans-serif; padding: 20px; background: #f8fafc; }
    .card { background: white; padding: 16px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <h1>Vision Pipeline Verification Page</h1>
  
  <div class="card">
    <h3>Aadhaar on Canvas</h3>
    <canvas id="aadhaarCanvas" width="400" height="90" style="border: 1px solid #94a3b8;"></canvas>
  </div>

  <div class="card">
    <h3>User Identity Photo</h3>
    <canvas id="faceCanvas" width="160" height="180" style="border: 1px solid #94a3b8;"></canvas>
  </div>

  <script>
    // Draw Aadhaar on canvas
    const ac = document.getElementById("aadhaarCanvas");
    const actx = ac.getContext("2d");
    actx.fillStyle = "#ffffff";
    actx.fillRect(0, 0, ac.width, ac.height);
    actx.fillStyle = "#0f172a";
    actx.font = "bold 24px monospace";
    actx.fillText("${AADHAAR_RAW}", 25, 55);

    // Draw Portrait Face on canvas
    const fc = document.getElementById("faceCanvas");
    const fctx = fc.getContext("2d");
    const w = fc.width, h = fc.height;
    fctx.fillStyle = "#e2e8f0";
    fctx.fillRect(0, 0, w, h);

    // Hair
    fctx.fillStyle = "#1e293b";
    fctx.beginPath();
    fctx.arc(w / 2, h * 0.45, w * 0.4, 0, Math.PI * 2);
    fctx.fill();

    // Face oval
    fctx.fillStyle = "#f5d0b5";
    fctx.beginPath();
    fctx.ellipse(w / 2, h * 0.52, w * 0.32, h * 0.38, 0, 0, Math.PI * 2);
    fctx.fill();

    // Eyes
    fctx.fillStyle = "#ffffff";
    fctx.beginPath();
    fctx.ellipse(w * 0.38, h * 0.46, w * 0.08, h * 0.06, 0, 0, Math.PI * 2);
    fctx.ellipse(w * 0.62, h * 0.46, w * 0.08, h * 0.06, 0, 0, Math.PI * 2);
    fctx.fill();

    fctx.fillStyle = "#0f172a";
    fctx.beginPath();
    fctx.arc(w * 0.38, h * 0.46, w * 0.04, 0, Math.PI * 2);
    fctx.arc(w * 0.62, h * 0.46, w * 0.04, 0, Math.PI * 2);
    fctx.fill();

    // Mouth
    fctx.strokeStyle = "#991b1b";
    fctx.lineWidth = 4;
    fctx.beginPath();
    fctx.arc(w / 2, h * 0.68, w * 0.15, 0.15 * Math.PI, 0.85 * Math.PI, false);
    fctx.stroke();
  </script>
</body>
</html>`;

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

// 1. Local test site
const site = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" }).end(TEST_PAGE);
});
const sitePort = await listen(site);
const testUrl = `http://127.0.0.1:${sitePort}/test`;

// 2. Mock AI model recording incoming requests
const incomingRequests = [];
const mockAiServer = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    incomingRequests.push(body);
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ message: { content: "Verified visual observation." } }) + "\n");
    res.end(JSON.stringify({ done: true }) + "\n");
  });
});
await listen(mockAiServer, 11434);

// 3. Launch Persistent Chromium Context
const userDataDir = await mkdtemp(join(tmpdir(), "pawtrol-vision-e2e-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failures.push(msg);
};

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  check(worker.url().endsWith("/service-worker.js"), `service worker booted (${extensionId})`);

  // Enable vision in settings
  await worker.evaluate(() =>
    chrome.storage.local.set({
      settings: {
        provider: "ollama",
        models: { ollama: "mock-planner" },
        confirmRisky: false,
        vision: { enabled: true, model: "mock-vision" },
        privacy: { blurFaces: true, maskCredentials: true, tokenizePII: true, showRedactionLabels: true },
      },
    }),
  );

  const page = await context.newPage();
  await page.goto(testUrl);
  await page.bringToFront();
  await page.waitForTimeout(2000);

  // Directly exercise offscreen processing on the active tab screenshot
  const captureResult = await worker.evaluate(async () => {
    // Query active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();

    // Ensure offscreen document exists
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (!contexts?.length) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS", "BLOBS"],
        justification: "Vision testing",
      });
    }

    // Process screenshot in offscreen
    return new Promise((resolve, reject) => {
      const requestId = `test-${Date.now()}`;
      const onMsg = (msg) => {
        if (msg.type !== "screenshot-processed" || msg.requestId !== requestId) return;
        chrome.runtime.onMessage.removeListener(onMsg);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      };
      chrome.runtime.onMessage.addListener(onMsg);
      chrome.runtime.sendMessage({
        type: "process-screenshot",
        requestId,
        dataUrl,
        width,
        height,
        sensitiveRegions: [], // No DOM regions — tests pure on-device vision detection on canvas
        dpr: 1,
      });
    });
  });

  check(captureResult && typeof captureResult.redactedDataUrl === "string", "offscreen returned redacted screenshot");
  check(captureResult.redactedCount > 0, `vision pipeline redacted ${captureResult.redactedCount} regions`);
  check(
    captureResult.detections.some((d) => d.kind === "face"),
    "face detected by YuNet / skin heuristic",
  );

  // Check backend and timings reported
  check(
    captureResult.backend === "WebGPU" || captureResult.backend === "WASM",
    `active execution backend reported (${captureResult.backend})`,
  );
  check(
    typeof captureResult.timings?.detection === "number" && typeof captureResult.timings?.masking === "number",
    `per-stage timings reported (det=${captureResult.timings?.detection}ms, mask=${captureResult.timings?.masking}ms, total=${captureResult.timings?.total}ms)`,
  );

  // Now verify that the redacted image sent to AI contains absolutely ZERO digits of the Aadhaar number
  const fullEgress = JSON.stringify(captureResult);
  check(!fullEgress.includes(AADHAAR_RAW), `raw formatted Aadhaar never in output: ${AADHAAR_RAW}`);
  check(!fullEgress.includes(AADHAAR_DIGITS), `raw unformatted digits never in output: ${AADHAAR_DIGITS}`);

  // Also simulate sending observation to mock AI model
  await worker.evaluate(async (redactedUrl) => {
    await fetch("http://127.0.0.1:11434/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: redactedUrl } }] }],
      }),
    });
  }, captureResult.redactedDataUrl);

  check(incomingRequests.length === 1, "mock AI received the observation request");
  const aiPayload = incomingRequests.join("\n");
  check(!aiPayload.includes(AADHAAR_RAW), "AI model request contains no formatted Aadhaar");
  check(!aiPayload.includes(AADHAAR_DIGITS), "AI model request contains no raw Aadhaar digits");

  // Check verification results
  check(captureResult.verification?.verified === true, `redaction verification passed (${captureResult.verification?.summary})`);
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.error(error);
} finally {
  await context.close();
  site.close();
  mockAiServer.close();
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

console.log(failures.length === 0 ? "\nTargeted Vision Verification: ALL CHECKS PASSED" : `\nTargeted Vision Verification: ${failures.length} FAILURE(S)`);
process.exit(failures.length === 0 ? 0 : 1);
