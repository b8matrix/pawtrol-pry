/**
 * Vision pipeline E2E: loads dist/ into Chromium and sends real screenshots of
 * every bench page through the production offscreen pipeline, with the DOM and
 * media regions the content script actually reports.
 *
 * What it proves (by OCR-ing the images in Node, not by string-matching base64):
 *  1. Every `mustRedact` value in bench/pages/*.truth.json that OCR can read in
 *     the original screenshot is NOT readable in the redacted one.
 *  2. A real face photo is found by YuNet (not a fallback) and blurred.
 *  3. Redaction verification passes, so the worker would allow sending.
 *  4. Fail closed: with a model file missing, the pipeline returns an error and
 *     no redacted image at all.
 *
 *   npm run build && npm run test:vision
 */

import { createServer } from "node:http";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createWorker } from "tesseract.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = process.env.PAWTROL_EXTENSION_DIR ?? join(root, "dist");
const pagesDir = join(root, "bench", "pages");
const artifacts = process.env.PAWTROL_VISION_ARTIFACTS; // optional dir for original/redacted images

const PHOTO_PAGE = `<!doctype html><html><body style="font-family:sans-serif;padding:24px">
<h2>Account profile</h2><img id="photo" src="/fixtures/face-public-domain.jpg" width="330" height="412" alt="Profile photo">
<p>Member since 2019</p></body></html>`;

// --- Test site --------------------------------------------------------------------
const site = createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  if (url.pathname === "/photo") return res.writeHead(200, { "content-type": "text/html" }).end(PHOTO_PAGE);
  const file = url.pathname.startsWith("/fixtures/")
    ? join(root, "tests", "e2e", url.pathname)
    : join(pagesDir, decodeURIComponent(url.pathname));
  let body;
  try {
    body = await readFile(file);
  } catch {
    return res.writeHead(404).end();
  }
  const type = { ".html": "text/html", ".jpg": "image/jpeg", ".png": "image/png" }[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type }).end(body);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${site.address().port}`;

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${message}`);
  if (!ok) failures.push(message);
};

// --- OCR in Node (independent of the extension's own OCR) -------------------------------
const ocr = await createWorker("eng", 1, {
  langPath: join(root, "vendor", "lang"),
  gzip: true,
  cachePath: await mkdtemp(join(tmpdir(), "pawtrol-ocr-cache-")),
  logger: () => {},
});
async function readImage(buffer) {
  const { data } = await ocr.recognize(buffer);
  return data.text;
}
/** Compare on alphanumerics only, with common OCR digit confusions folded. */
function fold(text) {
  return text
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL|]/g, "1");
}

// --- Browser helpers --------------------------------------------------------------------
async function launch(extensionDir) {
  const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "pawtrol-vision-")), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const worker = async () =>
    context.serviceWorkers().find((w) => w.url().endsWith("/service-worker.js")) ??
    (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  const extensionId = new URL((await worker()).url()).host;
  // Results are broadcast by the offscreen document; an extension page collects them so no
  // long-running evaluate has to keep the MV3 service worker alive.
  const collector = await context.newPage();
  await collector.goto(`chrome-extension://${extensionId}/options.html`);
  return { context, worker, collector, extensionId };
}

/** Screenshot the page as the production worker does and run it through the offscreen pipeline. */
async function processPage(env, path) {
  const page = await env.context.newPage();
  await page.goto(`${base}/${path}`);
  await page.bringToFront();
  await page.waitForTimeout(2000);

  const shot = await (await env.worker()).evaluate(async (pageUrl) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    const regions = await chrome.tabs.sendMessage(tab.id, { kind: "get-sensitive-regions" });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS", "BLOBS"], justification: "E2E" });
    }
    return { dataUrl, ...size, regions };
  }, page.url());

  const requestId = `e2e-${Math.random().toString(36).slice(2)}`;
  const pending = env.collector.evaluate(
    (id) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: "E2E timeout after 120s" }), 120_000);
        chrome.runtime.onMessage.addListener(function on(message) {
          if (message.type !== "screenshot-processed" || message.requestId !== id) return;
          chrome.runtime.onMessage.removeListener(on);
          clearTimeout(timer);
          resolve(message);
        });
      }),
    requestId,
  );
  await env.collector.waitForTimeout(100);
  await (await env.worker()).evaluate(
    (message) => {
      chrome.runtime.sendMessage(message);
    },
    {
      type: "process-screenshot",
      requestId,
      dataUrl: shot.dataUrl,
      width: shot.width,
      height: shot.height,
      sensitiveRegions: shot.regions.sensitiveRegions ?? [],
      mediaRegions: shot.regions.mediaRegions ?? [],
      dpr: shot.regions.dpr ?? 1,
    },
  );
  const response = await pending;
  await page.close();
  return { shot, response };
}

const decode = (dataUrl) => Buffer.from(dataUrl.split(",")[1], "base64");

// --- 1–3: every bench page plus the real photo ----------------------------------------------
const env = await launch(dist);
try {
  const truthFiles = (await readdir(pagesDir)).filter((f) => f.endsWith(".truth.json")).sort();
  for (const truthFile of truthFiles) {
    const truth = JSON.parse(await readFile(join(pagesDir, truthFile), "utf8"));
    console.log(`\n== ${truth.testPage}`);
    const { shot, response } = await processPage(env, truth.testPage);
    if (response.error) {
      check(false, `${truth.testPage}: pipeline error: ${response.error}`);
      continue;
    }
    const result = response.result;
    const original = decode(shot.dataUrl);
    const redacted = decode(result.redactedDataUrl);
    if (artifacts) {
      const slug = truth.testPage.replace(/\.html$/, "");
      await writeFile(join(artifacts, `${slug}.original.png`), original);
      await writeFile(join(artifacts, `${slug}.redacted.jpg`), redacted);
    }
    console.log(
      `      ${result.detections.length} masked (${result.detections.map((d) => `${d.kind}/${d.source ?? "?"}`).join(", ") || "none"}); ` +
        `backend=${result.backend}; timings=${JSON.stringify(result.timings)}`,
    );

    const originalText = fold(await readImage(original));
    const redactedText = fold(await readImage(redacted));
    const values = truth.expectedDetections
      .filter((d) => d.mustRedact)
      .map((d) => d.normalizedValue ?? d.value ?? d.actualValue)
      .filter(Boolean);
    for (const value of values) {
      const needle = fold(value);
      if (!originalText.includes(needle)) {
        // Masked by the browser itself (password dots) or unreadable to OCR at this size.
        console.log(`INFO  ${JSON.stringify(value)} not OCR-readable in the original screenshot; nothing to verify`);
        continue;
      }
      check(!redactedText.includes(needle), `${truth.testPage}: ${JSON.stringify(value)} no longer readable after redaction`);
    }
    check(result.verification?.verified === true, `${truth.testPage}: verification passed (${result.verification?.summary})`);
    if (truth.minFacesBlurred) {
      const faces = result.detections.filter((d) => d.kind === "face").length;
      // Known asset issue: this page draws cartoon faces, which a real face detector should not match.
      console.log(`INFO  ${faces}/${truth.minFacesBlurred} cartoon faces blurred (replace with real photos for a meaningful check)`);
    }
  }

  console.log("\n== photo (public-domain portrait)");
  const { response } = await processPage(env, "photo");
  if (response.error) {
    check(false, `photo: pipeline error: ${response.error}`);
  } else {
    const faces = response.result.detections.filter((d) => d.kind === "face");
    check(faces.some((f) => f.source === "yunet"), `photo: face found by YuNet (${faces.map((f) => f.source).join(", ") || "none"})`);
    check(response.result.verification?.verified === true, "photo: face blur verified");
    check(["WebGPU", "WASM"].includes(response.result.backend), `photo: backend reported (${response.result.backend})`);
    if (artifacts) await writeFile(join(artifacts, "photo.redacted.jpg"), decode(response.result.redactedDataUrl));
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.error(error);
} finally {
  await env.context.close();
}

// --- 4: fail closed when a model is missing ---------------------------------------------------
console.log("\n== fail closed (text detection model removed)");
const brokenDist = await mkdtemp(join(tmpdir(), "pawtrol-broken-dist-"));
try {
  await cp(dist, brokenDist, { recursive: true });
  await rm(join(brokenDist, "models", "ch_PP-OCRv4_det_infer.quant.onnx"));
  const broken = await launch(brokenDist);
  try {
    const { response } = await processPage(broken, "canvas-aadhaar.html");
    check(Boolean(response.error), `missing model returns an error (${response.error ?? "no error"})`);
    check(!response.result?.redactedDataUrl, "missing model returns no image to send");
  } finally {
    await broken.context.close();
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.error(error);
} finally {
  await rm(brokenDist, { recursive: true, force: true }).catch(() => {});
  await ocr.terminate();
  site.close();
}

console.log(failures.length === 0 ? "\nVision verification: ALL CHECKS PASSED" : `\nVision verification: ${failures.length} FAILURE(S)`);
process.exit(failures.length === 0 ? 0 : 1);
