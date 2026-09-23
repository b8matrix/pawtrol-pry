// In-page launcher: a floating button that starts a task on this tab without
// opening the side panel, then shows its progress, confirmations and answer.
//
// It lives in a closed shadow root, so page snapshots, PII scans and
// innerText never see it, and the worker hides it for every screenshot
// (it can show the task and answers with real values).

const PREFS_KEY = "pry-launcher";
const HOST_TAG = "pawtrol-launcher";

interface Prefs {
  enabled: boolean;
  hiddenHosts: string[];
}

type Update = { kind: "launcher-update"; running: boolean; tone: "info" | "step" | "answer" | "error"; text: string };
type Confirm = { kind: "launcher-confirm"; id: string; summary: string };

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --bg: #ffffff; --surface: #f4f4f5; --line: #d4d4d8; --ink: #18181b; --mute: #71717a;
  --accent: #4a6f9a; --accent-ink: #ffffff; --alert: #b4442f; --ok: #3f7a52;
  --shadow: 0 8px 28px rgba(15, 23, 42, 0.18);
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
  display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink);
}
@media (prefers-color-scheme: dark) {
  .root {
    --bg: #0d1116; --surface: #151b23; --line: #2b3440; --ink: #e6ebf1; --mute: #8b96a5;
    --accent: #84aad6; --accent-ink: #0d1116; --alert: #e0806a; --ok: #7fbf8f;
    --shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  }
}
.fab {
  width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--line);
  background: var(--bg); color: var(--accent); box-shadow: var(--shadow);
  display: grid; place-items: center; cursor: pointer; padding: 0; position: relative;
}
.fab:hover { border-color: var(--accent); }
.fab:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.fab svg { width: 22px; height: 22px; }
.fab.busy::after {
  content: ""; position: absolute; inset: -4px; border-radius: 50%;
  border: 2px solid var(--accent); border-right-color: transparent; animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.card {
  width: 340px; max-width: calc(100vw - 40px); background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; box-shadow: var(--shadow); padding: 12px; display: flex; flex-direction: column; gap: 10px;
}
.card[hidden] { display: none; }
.head { display: flex; align-items: center; gap: 6px; }
.title { font-weight: 700; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); flex: 1; }
.icon {
  width: 26px; height: 26px; border: 0; border-radius: 4px; background: transparent; color: var(--mute);
  display: grid; place-items: center; cursor: pointer; padding: 0;
}
.icon:hover { background: var(--surface); color: var(--ink); }
.icon svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
form { display: flex; gap: 6px; margin: 0; }
input {
  flex: 1; min-width: 0; height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 4px;
  background: var(--surface); color: var(--ink); font: inherit;
}
input::placeholder { color: var(--mute); }
.btn {
  height: 34px; padding: 0 12px; border-radius: 4px; border: 1px solid var(--line); background: var(--bg);
  color: var(--ink); font-family: inherit; font-size: 12px; font-weight: 600; line-height: 1; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer;
}
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.danger { color: var(--alert); }
.btn:disabled { opacity: 0.5; cursor: default; }
.hint { color: var(--mute); font-size: 12px; margin: 0; }
.status {
  margin: 0; padding: 8px 10px; border-radius: 4px; background: var(--surface); max-height: 200px; overflow: auto;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.status.step { font: 12px/1.45 ui-monospace, "JetBrains Mono", Consolas, monospace; }
.status.error { color: var(--alert); }
.status[hidden], .row[hidden], form[hidden], .hint[hidden] { display: none; }
.row { display: flex; gap: 6px; justify-content: flex-end; }
@media (prefers-reduced-motion: reduce) { .fab.busy::after { animation: none; } }
`;

const PAW = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><ellipse cx="6.5" cy="10" rx="2" ry="2.6"/><ellipse cx="10" cy="6.5" rx="2" ry="2.6"/><ellipse cx="14" cy="6.5" rx="2" ry="2.6"/><ellipse cx="17.5" cy="10" rx="2" ry="2.6"/><path d="M12 11.5c-3 0-5.5 3.4-5.5 5.6 0 1.6 1.3 2.4 2.8 2.4 1.1 0 1.8-.5 2.7-.5s1.6.5 2.7.5c1.5 0 2.8-.8 2.8-2.4 0-2.2-2.5-5.6-5.5-5.6Z"/></svg>`;
const ICON_PANEL = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10"/><path d="M9.5 3v10"/></svg>`;
const ICON_HIDE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4-5.5-4-5.5-4Z"/><path d="M3 13 13 3"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

let host: HTMLElement | null = null;
let ui: {
  fab: HTMLButtonElement;
  card: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  hint: HTMLElement;
  status: HTMLElement;
  confirmRow: HTMLElement;
  runRow: HTMLElement;
  doneRow: HTMLElement;
} | null = null;
let prefs: Prefs = { enabled: true, hiddenHosts: [] };
let running = false;
/** This launcher started the current run (or picked it up after a navigation). */
let ownsRun = false;
let pendingConfirmId: string | null = null;
/** Opened by the shortcut on a site where the button is hidden. */
let forcedOpen = false;
let captureTimer: ReturnType<typeof setTimeout> | undefined;

function send(message: Record<string, unknown>): Promise<any> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

function shouldShow(): boolean {
  if (forcedOpen || (ownsRun && (running || pendingConfirmId))) return true;
  return prefs.enabled && !prefs.hiddenHosts.includes(location.hostname);
}

function build(): void {
  host = document.createElement(HOST_TAG);
  const shadow = host.attachShadow({ mode: "closed" });
  // A constructed sheet, not a <style> element: page CSPs can block inline styles.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(STYLE);
  shadow.adoptedStyleSheets = [sheet];
  shadow.innerHTML = `
    <div class="root">
      <section class="card" hidden role="dialog" aria-label="Pawtrol">
        <div class="head">
          <span class="title">Pawtrol · this tab</span>
          <button class="icon" data-act="panel" title="Open the side panel" aria-label="Open the side panel">${ICON_PANEL}</button>
          <button class="icon" data-act="hide" title="Hide the button on this site (Alt+Shift+P still opens it)" aria-label="Hide on this site">${ICON_HIDE}</button>
          <button class="icon" data-act="close" title="Close" aria-label="Close">${ICON_CLOSE}</button>
        </div>
        <form>
          <input type="text" placeholder="What should I do on this page?" aria-label="Task" autocomplete="off" spellcheck="false" />
          <button class="btn primary" type="submit">Go</button>
        </form>
        <p class="hint">Pawtrol takes control of this tab. Personal data is redacted on your device first.</p>
        <p class="status" hidden aria-live="polite"></p>
        <div class="row confirm" hidden>
          <button class="btn danger" data-act="deny" type="button">Deny</button>
          <button class="btn primary" data-act="allow" type="button">Allow</button>
        </div>
        <div class="row run" hidden>
          <button class="btn danger" data-act="stop" type="button">Stop</button>
        </div>
        <div class="row done" hidden>
          <button class="btn" data-act="new" type="button">New task</button>
        </div>
      </section>
      <button class="fab" type="button" title="Pawtrol (Alt+Shift+P)" aria-label="Open Pawtrol">${PAW}</button>
    </div>`;
  const $ = <T extends Element>(selector: string) => shadow.querySelector(selector) as T;
  ui = {
    fab: $(".fab"),
    card: $(".card"),
    form: $("form"),
    input: $("input"),
    hint: $(".hint"),
    status: $(".status"),
    confirmRow: $(".row.confirm"),
    runRow: $(".row.run"),
    doneRow: $(".row.done"),
  };

  // Submit is not a composed event, so the page never sees it.
  ui.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void start(ui!.input.value.trim());
  });

  // Pages often handle clicks and keys on document or body in the capture
  // phase (and call stopPropagation or preventDefault), which runs before any
  // listener inside this shadow root. So the launcher takes its own events at
  // window capture, the first stop on the path, handles them there and keeps
  // them from the page. Default actions (focus, typing, form submit) still run.
  const host_ = host;
  for (const type of GUARDED_EVENTS) {
    window.addEventListener(
      type,
      (event) => {
        if (event.target !== host_) return;
        event.stopPropagation();
        if (type === "click") onClick(event as MouseEvent, shadow);
        else if (type === "keydown" && (event as KeyboardEvent).key === "Escape") setOpen(false);
      },
      true,
    );
  }

  // Outside <body>: body.innerText and the body walkers never reach it.
  document.documentElement.appendChild(host);
}

const GUARDED_EVENTS = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu",
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "paste",
  "focusin",
  "focusout",
  "wheel",
  "touchstart",
  "touchend",
];

function onClick(event: MouseEvent, shadow: ShadowRoot): void {
  // The retargeted event only names the host; find what was clicked inside.
  // A keyboard-activated click (detail 0) acts on the focused control.
  const hit = event.detail === 0 ? shadow.activeElement : shadow.elementFromPoint(event.clientX, event.clientY);
  if (!hit || !ui) return;
  if (hit.closest(".fab")) {
    setOpen(ui.card.hidden);
    return;
  }
  const action = hit.closest<HTMLElement>("[data-act]")?.dataset.act;
  if (action === "close") setOpen(false);
  else if (action === "hide") void hideOnSite();
  else if (action === "panel") void openPanel();
  else if (action === "stop") stopRun();
  else if (action === "allow" || action === "deny") answerConfirm(action === "allow");
  else if (action === "new") showIdle();
}

function stopRun(): void {
  if (!ui) return;
  void send({ kind: "stop" });
  ui.runRow.hidden = true;
  setStatus("Stopping…", "info");
}

function setOpen(open: boolean): void {
  if (!ui) return;
  ui.card.hidden = !open;
  if (open && !running && !ui.form.hidden) ui.input.focus();
  // Remembered by the worker, so a navigation mid-run does not reopen it.
  if (ownsRun && running) void send({ kind: "launcher-collapsed", collapsed: !open });
  if (!open) {
    forcedOpen = false;
    render();
  }
}

function setStatus(text: string, tone: Update["tone"]): void {
  if (!ui) return;
  ui.status.hidden = !text;
  ui.status.textContent = text;
  ui.status.className = `status ${tone}`;
}

function showIdle(): void {
  if (!ui) return;
  ui.form.hidden = false;
  ui.hint.hidden = false;
  ui.input.value = "";
  ui.runRow.hidden = true;
  ui.doneRow.hidden = true;
  ui.confirmRow.hidden = true;
  setStatus("", "info");
  ui.input.focus();
}

function showRunning(text: string, tone: Update["tone"]): void {
  if (!ui) return;
  // The task text is not kept on screen while the agent works.
  ui.form.hidden = true;
  ui.hint.hidden = true;
  ui.doneRow.hidden = true;
  ui.runRow.hidden = Boolean(pendingConfirmId);
  setStatus(text, tone);
}

function showDone(text: string, tone: Update["tone"]): void {
  if (!ui) return;
  ui.form.hidden = true;
  ui.hint.hidden = true;
  ui.runRow.hidden = true;
  ui.confirmRow.hidden = true;
  ui.doneRow.hidden = false;
  setStatus(text, tone);
}

/** Show or hide the whole launcher to match prefs and run state. */
function render(): void {
  if (!host && shouldShow()) build();
  if (!host || !ui) return;
  host.style.display = shouldShow() ? "" : "none";
  ui.fab.classList.toggle("busy", running);
}

async function start(task: string): Promise<void> {
  if (!task || !ui) return;
  const reply = await send({ kind: "run", task });
  if (!reply?.ok) {
    setStatus(reply?.reason ?? "Pawtrol could not start. Reload the page and try again.", "error");
    return;
  }
  running = true;
  ownsRun = true;
  showRunning("Starting…", "info");
  render();
}

function answerConfirm(approved: boolean): void {
  if (!pendingConfirmId || !ui) return;
  void send({ kind: "confirm-reply", id: pendingConfirmId, approved });
  pendingConfirmId = null;
  ui.confirmRow.hidden = true;
  ui.runRow.hidden = !running;
  setStatus(approved ? "Allowed. Continuing…" : "Declined.", "info");
}

async function hideOnSite(): Promise<void> {
  const hiddenHosts = [...new Set([...prefs.hiddenHosts, location.hostname])];
  forcedOpen = false;
  try {
    await chrome.storage.local.set({ [PREFS_KEY]: { ...prefs, hiddenHosts } });
  } catch {}
}

async function openPanel(): Promise<void> {
  const reply = await send({ kind: "open-panel" });
  if (!reply?.ok) setStatus("Click the Pawtrol icon in the toolbar to open the side panel.", "info");
}

function onUpdate(update: Update): void {
  running = update.running;
  render();
  // A run started from the side panel only shows as the busy ring here.
  if (!ui || !ownsRun) return;
  if (update.running) showRunning(update.text, update.tone);
  else showDone(update.text, update.tone);
}

function onConfirm(confirm: Confirm): void {
  // The side panel asks for its own runs.
  if (!ownsRun) return;
  pendingConfirmId = confirm.id;
  render();
  if (!ui || host?.style.display === "none") return;
  ui.card.hidden = false;
  ui.runRow.hidden = true;
  ui.confirmRow.hidden = false;
  setStatus(`Allow this? ${confirm.summary}`, "info");
}

/** Messages from the worker. Returns true when the launcher handled it. */
export function handleLauncherMessage(message: any, sendResponse: (response: unknown) => void): boolean {
  switch (message?.kind) {
    case "launcher-update":
      onUpdate(message);
      break;
    case "launcher-confirm":
      onConfirm(message);
      break;
    case "launcher-confirm-done":
      if (pendingConfirmId === message.id && ui) {
        pendingConfirmId = null;
        ui.confirmRow.hidden = true;
        ui.runRow.hidden = !running;
      }
      break;
    case "launcher-open":
      forcedOpen = true;
      render();
      setOpen(true);
      break;
    case "launcher-hide":
      if (!host || host.style.display === "none") {
        sendResponse({ ok: true });
        return true;
      }
      // Opacity, not visibility: invisible to the capture, but it still takes
      // clicks, so a click mid-capture never falls through to the page.
      host.style.opacity = "0";
      // Never stay hidden if the matching "show" is lost.
      clearTimeout(captureTimer);
      captureTimer = setTimeout(() => host && (host.style.opacity = ""), 5000);
      // Reply once the hidden state has been painted.
      requestAnimationFrame(() => requestAnimationFrame(() => sendResponse({ ok: true })));
      return true;
    case "launcher-show":
      clearTimeout(captureTimer);
      if (host) host.style.opacity = "";
      break;
    default:
      return false;
  }
  sendResponse({ ok: true });
  return true;
}

export function initLauncher(): void {
  const w = window as unknown as { __PRY_LAUNCHER__?: boolean };
  // content.js can be injected again into a tab that already has it.
  if (w.__PRY_LAUNCHER__ || window.top !== window || document.contentType !== "text/html") return;
  w.__PRY_LAUNCHER__ = true;

  chrome.storage.local
    .get(PREFS_KEY)
    .then((stored) => {
      prefs = { enabled: true, hiddenHosts: [], ...(stored[PREFS_KEY] ?? {}) };
      render();
    })
    .catch(() => render());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[PREFS_KEY]) return;
    prefs = { enabled: true, hiddenHosts: [], ...(changes[PREFS_KEY].newValue ?? {}) };
    render();
  });

  // A run may have navigated this tab: pick up where the last page left off.
  void send({ kind: "launcher-state" }).then((state) => {
    if (!state?.running) return;
    running = true;
    ownsRun = Boolean(state.owned);
    render();
    if (ownsRun && ui && !state.collapsed) ui.card.hidden = false;
    if (state.update) onUpdate(state.update);
    else showRunning("Working…", "info");
    if (state.confirm) onConfirm(state.confirm);
  });
}
