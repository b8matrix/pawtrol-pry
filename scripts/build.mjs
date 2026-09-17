// Builds the extension into dist/. Load dist/ unpacked at chrome://extensions.
//
// Ported contexts are bundled from src/. Contexts not yet ported (side panel,
// options, offscreen) are copied from the repo root as-is until their turn.
//
//   node scripts/build.mjs           one-off build
//   node scripts/build.mjs --watch   rebuild on change

import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "dist");
const watch = process.argv.includes("--watch");

// The Anthropic SDK lazily imports node:fs / node:path for credential-file
// loading, which browsers never reach. Stub them (as the legacy bundle did).
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: "node-stub" }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({ contents: "export default {};", loader: "js" }));
  },
};

const shared = {
  bundle: true,
  minify: !watch,
  plugins: [stubNodeBuiltins],
  target: "chrome120",
  sourcemap: "linked",
  legalComments: "none",
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' },
};

const entries = [
  // The manifest declares the worker as a module.
  { entryPoints: [join(root, "src/background/index.ts")], outfile: join(outdir, "service-worker.js"), format: "esm" },
  { entryPoints: [join(root, "src/content/index.ts")], outfile: join(outdir, "content.js"), format: "iife" },
  // Runs in the page's MAIN world: no sourcemap comment pointing at an extension URL pages could probe.
  {
    entryPoints: [join(root, "src/tripwire/index.ts")],
    outfile: join(outdir, "tripwire.js"),
    format: "iife",
    sourcemap: false,
  },
  // Ported offscreen vision pipeline
  {
    entryPoints: [join(root, "src/offscreen/index.ts")],
    outfile: join(outdir, "offscreen/offscreen.js"),
    format: "esm",
  },
];

const STATIC_FILES = [
  "manifest.json",
  "icons",
  "vendor",
  "styles.css",
  "theme.js",
  "theme-boot.js",
  "sidepanel.html",
  "sidepanel.js",
  "ui-shell.js",
  "options.html",
  "options.js",
  "options-profile.js",
  "offscreen.html",
];

const ORT_RUNTIME_FILES = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
// Models loaded at runtime (see src/offscreen/ppocr.ts, yunet.ts). The float
// PP-OCR export stays in models/ as the quantization source only.
const RUNTIME_MODELS = ["ch_PP-OCRv4_det_infer.quant.onnx", "face_detection_yunet_2023mar.onnx"];

async function copyStatic() {
  for (const file of STATIC_FILES) {
    await cp(join(root, file), join(outdir, file), { recursive: true });
  }
  await mkdir(join(outdir, "models"), { recursive: true });
  for (const model of RUNTIME_MODELS) {
    await cp(join(root, "models", model), join(outdir, "models", model));
  }

  // onnxruntime-web's default bundle loads only the JSEP (WebGPU + WASM)
  // runtime from ort.env.wasm.wasmPaths. Copying the whole dist/ added ~136 MB
  // of unused builds; a missing file must fail the build, not warn.
  const ortDist = join(root, "node_modules", "onnxruntime-web", "dist");
  const ortDest = join(outdir, "vendor", "ort");
  await mkdir(ortDest, { recursive: true });
  for (const file of ORT_RUNTIME_FILES) {
    await cp(join(ortDist, file), join(ortDest, file));
  }
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await copyStatic();

if (watch) {
  for (const entry of entries) {
    const ctx = await context({ ...shared, ...entry });
    await ctx.watch();
  }
  console.log("Watching src/ — reload the extension at chrome://extensions after each rebuild.");
} else {
  await Promise.all(entries.map((entry) => build({ ...shared, ...entry })));
  console.log(`Built to ${outdir}`);
}
