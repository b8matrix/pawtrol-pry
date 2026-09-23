// Agent benchmark runner. Loads dist/ into Chromium, runs each held-out task
// against the local fixture sites with a real provider, and records per run:
// success, planner calls (steps), tool calls, wall time, tokens and cost.
//
//   npm run build
//   node bench/agent/run.mjs --models openai/gpt-oss-20b,openai/gpt-oss-120b
//
// Options: --provider groq (default) · --models a,b · --tasks id,id · --repeat N
//          --gap ms (pause between runs, for rate limits) · --headed · --verbose
// The API key comes from <PROVIDER>_API_KEY in the environment or the repo's
// gitignored .env file. Each run gets a fresh browser profile so the agent's
// learned lessons never carry over between runs.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startSites } from "./sites.mjs";
import { TASKS } from "./tasks.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "dist");

// USD per million tokens (input, output). Check the provider's pricing page
// before quoting these; they change.
const PRICES = {
  "groq:openai/gpt-oss-20b": [0.075, 0.3],
  "groq:openai/gpt-oss-120b": [0.15, 0.6],
};

function parseArgs(argv) {
  const args = { provider: "groq", models: "openai/gpt-oss-20b,openai/gpt-oss-120b", tasks: "", repeat: 1, gap: 4000, headed: false, timeout: 300 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (key === "headed") args.headed = true;
    else if (key === "verbose") args.verbose = true;
    else args[key] = argv[++i];
  }
  args.models = args.models.split(",").map((s) => s.trim()).filter(Boolean);
  args.tasks = args.tasks ? args.tasks.split(",").map((s) => s.trim()) : TASKS.map((t) => t.id);
  args.repeat = Number(args.repeat) || 1;
  args.gap = Number(args.gap) || 0;
  args.timeout = Number(args.timeout) || 300;
  return args;
}

async function apiKeyFor(provider) {
  const name = `${provider.toUpperCase()}_API_KEY`;
  if (process.env[name]) return process.env[name];
  try {
    const env = await readFile(join(root, ".env"), "utf8");
    const line = env.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
  } catch {}
  return "";
}

const plain = (state) => JSON.parse(JSON.stringify(state, (_, v) => (v instanceof Set ? [...v] : v)));
const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOne({ provider, model, apiKey, task, sites, headed, timeoutS, verbose }) {
  sites.reset();
  const userDataDir = await mkdtemp(join(tmpdir(), "pawtrol-bench-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: !headed,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  const record = { provider, model, task: task.id, category: task.category };
  try {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(
      ({ provider, model, apiKey }) =>
        chrome.storage.local.set({
          settings: { provider, apiKeys: { [provider]: apiKey }, models: { [provider]: model }, confirmRisky: true, maxSteps: 40 },
        }),
      { provider, model, apiKey },
    );

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    // Approve every confirmation, but keep them: approving a payment is the agent's call to get wrong.
    await panel.evaluate(() => {
      window.__benchConfirms = [];
      chrome.runtime.onMessage.addListener((m) => {
        if (m?.kind !== "confirm") return;
        window.__benchConfirms.push(m.summary);
        chrome.runtime.sendMessage({ kind: "confirm-reply", id: m.id, approved: true });
      });
    });

    const page = await context.newPage();
    const startUrl = sites.origin + task.start;
    await page.goto(startUrl);
    await page.bringToFront();
    await page.waitForTimeout(800);
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: url + "*" }))[0]?.id, sites.origin + "/");
    if (typeof tabId !== "number") throw new Error("could not find the task tab");

    const startedAt = Date.now();
    await panel.evaluate(({ task, tabId }) => chrome.runtime.sendMessage({ kind: "run", task, tabId }), { task: task.task, tabId });

    let state;
    let timedOut = false;
    let shown = 0;
    for (;;) {
      await sleep(500);
      state = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: "get-state" }));
      if (verbose) {
        for (const e of state.transcript.slice(shown)) {
          console.log(`    ${((Date.now() - startedAt) / 1000).toFixed(1)}s [${e.role}${e.action ? `:${e.action}` : ""}] ${String(e.text ?? "").replace(/\s+/g, " ").slice(0, 240)}`);
        }
        shown = state.transcript.length;
      }
      if (!state.running && (state.transcript.some((e) => /Task ended/.test(e.text)) || Date.now() - startedAt > 5000)) break;
      if (Date.now() - startedAt > timeoutS * 1000) {
        timedOut = true;
        await panel.evaluate(() => chrome.runtime.sendMessage({ kind: "stop" }));
        await sleep(1500);
        state = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: "get-state" }));
        break;
      }
    }
    const wallMs = Date.now() - startedAt;

    const assistant = state.transcript.filter((e) => e.role === "assistant" && e.text?.trim());
    const answer = assistant.at(-1)?.text.trim() ?? "";
    const errors = state.transcript.filter((e) => e.role === "error").map((e) => e.text);
    const siteState = plain(sites.state);
    const pages = context.pages().filter((p) => p.url().startsWith(sites.origin));
    const finalUrl = pages.at(-1)?.url() ?? "";
    const verdict = timedOut ? { pass: false, why: `timed out after ${timeoutS}s` } : task.check({ answer, state: siteState, finalUrl });

    const stats = state.lastRunStats ?? {};
    const price = PRICES[`${provider}:${model}`];
    const costUsd =
      price && stats.inputTokens != null ? (stats.inputTokens * price[0] + stats.outputTokens * price[1]) / 1e6 : null;

    Object.assign(record, {
      pass: verdict.pass,
      why: verdict.why,
      wallMs,
      plannerCalls: stats.plannerCalls ?? null,
      toolCalls: stats.toolCalls ?? null,
      inputTokens: stats.inputTokens ?? null,
      outputTokens: stats.outputTokens ?? null,
      costUsd,
      timedOut,
      errors,
      confirms: await panel.evaluate(() => window.__benchConfirms),
      answer: answer.slice(0, 600),
      finalUrl: finalUrl.replace(sites.origin, ""),
      transcript: state.transcript.map((e) => `[${e.role}${e.action ? `:${e.action}` : ""}] ${String(e.text ?? "").replace(/\s+/g, " ").slice(0, 300)}`),
    });
  } catch (error) {
    Object.assign(record, { pass: false, why: `harness error: ${error?.message ?? error}`, errors: [String(error?.stack ?? error)] });
  } finally {
    await context.close().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
  return record;
}

function report(results, args, startedIso) {
  const lines = [];
  const fmtS = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  const fmtK = (n) => (n == null ? "—" : `${(n / 1000).toFixed(1)}k`);
  lines.push(`# Agent benchmark: ${args.provider}`, "", `Run ${startedIso}. ${args.tasks.length} tasks × ${args.repeat} repeat(s) per model. Held-out fixture sites (bench/agent/sites.mjs).`, "");
  lines.push("## Summary", "", "| Model | Success | Median steps | Median wall time | Tokens in / out (total) | Cost (total) | Cost per success |", "|---|---|---|---|---|---|---|");
  for (const model of args.models) {
    const rs = results.filter((r) => r.model === model);
    const wins = rs.filter((r) => r.pass).length;
    const tin = rs.reduce((a, r) => a + (r.inputTokens ?? 0), 0);
    const tout = rs.reduce((a, r) => a + (r.outputTokens ?? 0), 0);
    const priced = rs.some((r) => r.costUsd != null);
    const cost = rs.reduce((a, r) => a + (r.costUsd ?? 0), 0);
    lines.push(
      `| ${model} | ${wins}/${rs.length} (${Math.round((100 * wins) / Math.max(1, rs.length))}%) | ${median(rs.map((r) => r.plannerCalls)) ?? "—"} | ${fmtS(median(rs.map((r) => r.wallMs)))} | ${fmtK(tin)} / ${fmtK(tout)} | ${priced ? `$${cost.toFixed(4)}` : "—"} | ${priced && wins ? `$${(cost / wins).toFixed(4)}` : "—"} |`,
    );
  }
  lines.push("", "## Per task", "", `| Task | Category | ${args.models.map((m) => `${m}`).join(" | ")} |`, `|---|---|${args.models.map(() => "---").join("|")}|`);
  for (const id of args.tasks) {
    const task = TASKS.find((t) => t.id === id);
    const cells = args.models.map((model) =>
      results
        .filter((r) => r.model === model && r.task === id)
        .map((r) => `${r.pass ? "✅" : "❌"} ${r.plannerCalls ?? "?"} steps, ${fmtS(r.wallMs)}`)
        .join("<br>"),
    );
    lines.push(`| ${id} | ${task.category} | ${cells.join(" | ")} |`);
  }
  lines.push("", "## Failures", "");
  for (const r of results.filter((r) => !r.pass)) {
    lines.push(`- **${r.model} · ${r.task}**: ${r.why}${r.errors?.length ? ` · error: ${r.errors[0].replace(/\s+/g, " ").slice(0, 200)}` : ""}${r.answer ? ` · answer: “${r.answer.replace(/\s+/g, " ").slice(0, 200)}”` : ""}`);
  }
  return lines.join("\n") + "\n";
}

const args = parseArgs(process.argv.slice(2));
const apiKey = await apiKeyFor(args.provider);
if (!apiKey && args.provider !== "ollama") {
  console.error(`No API key: set ${args.provider.toUpperCase()}_API_KEY in the environment or in the repo's .env file.`);
  process.exit(2);
}
const unknown = args.tasks.filter((id) => !TASKS.some((t) => t.id === id));
if (unknown.length) {
  console.error(`Unknown task id(s): ${unknown.join(", ")}`);
  process.exit(2);
}

const sites = await startSites();
const startedIso = new Date().toISOString();
const results = [];
try {
  for (const model of args.models) {
    for (const id of args.tasks) {
      const task = TASKS.find((t) => t.id === id);
      for (let rep = 0; rep < args.repeat; rep++) {
        const r = await runOne({ provider: args.provider, model, apiKey, task, sites, headed: args.headed, timeoutS: args.timeout, verbose: args.verbose });
        r.rep = rep;
        results.push(r);
        console.log(
          `${r.pass ? "PASS" : "FAIL"}  ${model}  ${id}  ${r.plannerCalls ?? "?"} steps  ${((r.wallMs ?? 0) / 1000).toFixed(1)}s  ` +
            `${r.inputTokens ?? "?"}/${r.outputTokens ?? "?"} tok  ${r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : ""}  ${r.pass ? "" : `— ${r.why}`}`,
        );
        if (args.gap) await sleep(args.gap);
      }
    }
  }
} finally {
  sites.close();
}

const outDir = join(root, "bench", "agent", "results");
await mkdir(outDir, { recursive: true });
const stamp = startedIso.replace(/[:.]/g, "-").slice(0, 19);
const base = join(outDir, `${stamp}-${args.provider}`);
await writeFile(`${base}.json`, JSON.stringify({ startedAt: startedIso, args: { ...args }, results }, null, 2));
const md = report(results, args, startedIso);
await writeFile(`${base}.md`, md);
console.log(`\n${md}\nWrote ${base}.json and .md`);
