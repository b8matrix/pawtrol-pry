/**
 * Playwright Crawler for Ground-Truth Dataset Labeling (Stretch Goal)
 * 
 * Automatically captures page screenshots and labels bounding boxes for all
 * interactive and text elements (inputs, buttons, headings, canvases, images).
 * Outputs dataset samples ready for fine-tuning on-device detectors.
 * 
 * Usage:
 *   node scripts/crawler.mjs [url] [outputDir]
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const targetUrl = process.argv[2] ?? "https://example.com";
const outputDir = process.argv[3] ?? "dataset";

async function crawlAndLabel(url, outDir) {
  console.log(`[Crawler] Launching Playwright crawler for ${url}...`);
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  } catch {
    console.warn("[Crawler] networkidle timed out, proceeding with domcontentloaded...");
  }

  // Extract all element bounding boxes and labels
  const annotations = await page.evaluate(() => {
    const selector = "input, textarea, select, button, a, canvas, img, p, h1, h2, h3, h4, h5, h6, [role]";
    const elements = document.querySelectorAll(selector);
    const boxes = [];

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;

      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const role = el.getAttribute("role") || tag;
      const text = (el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("alt") || "").slice(0, 100).trim();

      let category = "text";
      if (tag === "input" || tag === "textarea") {
        category = type === "password" ? "password_field" : "input_field";
      } else if (tag === "button" || role === "button") {
        category = "button";
      } else if (tag === "canvas") {
        category = "canvas";
      } else if (tag === "img") {
        category = "image";
      }

      boxes.push({
        tag,
        category,
        text,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
    return {
      title: document.title,
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      boxes,
    };
  });

  const timestamp = Date.now();
  const screenshotPath = join(outDir, `sample_${timestamp}.png`);
  const jsonPath = join(outDir, `sample_${timestamp}.json`);

  await page.screenshot({ path: screenshotPath, fullPage: false });
  await writeFile(jsonPath, JSON.stringify(annotations, null, 2), "utf8");

  console.log(`[Crawler] Saved screenshot -> ${screenshotPath}`);
  console.log(`[Crawler] Labeled ${annotations.boxes.length} element boxes -> ${jsonPath}`);

  await browser.close();
  return { screenshotPath, jsonPath, boxCount: annotations.boxes.length };
}

crawlAndLabel(targetUrl, outputDir).catch((err) => {
  console.error("[Crawler] Failed:", err);
  process.exit(1);
});
