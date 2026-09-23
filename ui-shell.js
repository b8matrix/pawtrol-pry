// UI shell for the side panel: greeting, suggestions, tools menu, exposure
// meter, and the inline model switcher. Runs alongside the bundled
// sidepanel.js and only touches elements that bundle does not own.

const $ = (id) => document.getElementById(id);

const PROFILE_KEY = "pry-profile";
const SETTINGS_KEY = "settings";

// ─── Provider catalog (mirrors options.js) ─────────────────────────────
const PROVIDERS = {
  ollama: {
    chip: "Local",
    label: "Ollama",
    local: true,
    models: ["qwen2.5:1.5b", "qwen2.5:3b", "qwen2.5:7b", "llama3.2:1b", "llama3.2:3b", "llama3.1:8b", "mistral:7b", "phi3:3.8b", "gemma2:9b"],
  },
  anthropic: {
    chip: "Claude",
    label: "Anthropic",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-fable-5"],
  },
  openai: {
    chip: "OpenAI",
    label: "OpenAI",
    models: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.1", "gpt-5"],
  },
  openrouter: {
    chip: "OpenRouter",
    label: "OpenRouter",
    models: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "openai/gpt-5.5", "google/gemini-3.1-pro-preview", "x-ai/grok-4.6", "deepseek/deepseek-v4-pro"],
  },
  groq: {
    chip: "Groq",
    label: "Groq",
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.6-27b", "qwen/qwen3.8-27b"],
  },
  nvidia: {
    chip: "NVIDIA",
    label: "NVIDIA NIM",
    models: ["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-nano-30b-a3b", "deepseek-ai/deepseek-v4-pro-0813", "qwen/qwq-32b", "meta/llama-3.1-8b-instruct"],
  },
};
const DEFAULT_PROVIDER = "ollama";

// ─── Storage helpers ───────────────────────────────────────────────────
async function storageGet(key) {
  try {
    return (await chrome.storage.local.get(key))[key];
  } catch {
    return undefined;
  }
}
async function storageSet(obj) {
  try {
    await chrome.storage.local.set(obj);
    return true;
  } catch {
    return false;
  }
}

// ─── Greeting ──────────────────────────────────────────────────────────
const PHRASES_NAMED = [
  "Hey {name}, what's on your mind?",
  "What are we tackling today, {name}?",
  "{name}, what can I take off your plate?",
  "Where should we start, {name}?",
  "Ready when you are, {name}.",
  "What needs doing on this page, {name}?",
  "Good to see you, {name}. What's next?",
];
const PHRASES_ANON = [
  "What's on your mind?",
  "What are we tackling today?",
  "What can I take off your plate?",
  "Where should we start?",
  "What needs doing on this page?",
];

let userName = "";
let lastPhrase = -1;

function timeOfDay() {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function pickPhrase() {
  const pool = userName ? PHRASES_NAMED : PHRASES_ANON;
  let i = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && i === lastPhrase) i = (i + 1) % pool.length;
  lastPhrase = i;
  return pool[i];
}

// Builds the headline with the user's name in its own span so it can be inked.
function setHeadline(el, phrase) {
  el.replaceChildren();
  const parts = phrase.split("{name}");
  parts.forEach((part, idx) => {
    if (part) el.append(part);
    if (idx < parts.length - 1) {
      const name = document.createElement("span");
      name.className = "greet-name";
      name.textContent = userName;
      el.append(name);
    }
  });
}

function renderGreeting({ reroll = true } = {}) {
  $("greet-time").textContent = timeOfDay();
  $("greet-avatar").textContent = userName ? userName[0].toUpperCase() : "·";
  const nameBtn = $("greet-name");
  nameBtn.textContent = userName || "set your name";
  nameBtn.classList.toggle("unset", !userName);

  if (reroll) {
    const h = $("greet-headline");
    setHeadline(h, pickPhrase());
    h.classList.remove("enter");
    void h.offsetWidth;
    h.classList.add("enter");
  }
}

function openNameForm() {
  const form = $("name-form");
  form.hidden = false;
  $("greet-name").setAttribute("aria-expanded", "true");
  const input = $("name-input");
  input.value = userName;
  input.focus();
  input.select();
}

function closeNameForm() {
  $("name-form").hidden = true;
  $("greet-name").setAttribute("aria-expanded", "false");
}

function initGreeting(profile) {
  userName = (profile?.name ?? "").trim();
  renderGreeting();
  if (!userName) openNameForm();

  $("greet-name").addEventListener("click", () => {
    if ($("name-form").hidden) openNameForm();
    else closeNameForm();
  });

  $("name-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    userName = $("name-input").value.trim().slice(0, 32);
    const current = (await storageGet(PROFILE_KEY)) ?? {};
    await storageSet({ [PROFILE_KEY]: { ...current, name: userName } });
    closeNameForm();
    renderGreeting();
  });

  $("name-input").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && userName) {
      e.stopPropagation();
      closeNameForm();
    }
  });

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[PROFILE_KEY]) return;
    const next = (changes[PROFILE_KEY].newValue?.name ?? "").trim();
    if (next === userName) return;
    userName = next;
    renderGreeting();
  });
}

// ─── Suggestions: show three at a time ─────────────────────────────────
function shuffleSuggestions() {
  const items = [...$("try-list").querySelectorAll(".try-item")];
  const order = items.map((el, i) => [Math.random(), i]).sort((a, b) => a[0] - b[0]);
  const keep = new Set(order.slice(0, 3).map(([, i]) => i));
  items.forEach((el, i) => {
    el.hidden = !keep.has(i);
  });
}

// ─── Tools menu ────────────────────────────────────────────────────────
function initToolsMenu() {
  const btn = $("btn-menu");
  const menu = $("tools-menu");

  const setOpen = (open) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.classList.toggle("active", open);
    if (open) menu.querySelector(".menu-item")?.focus();
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  menu.addEventListener("click", (e) => {
    if (e.target.closest(".menu-item")) setOpen(false);
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll(".menu-item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length].focus();
    } else if (e.key === "Escape") {
      setOpen(false);
      btn.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !e.target.closest(".menu-wrap")) setOpen(false);
  });
}

// ─── Exposure meter ────────────────────────────────────────────────────
const exposure = { entities: 0, alerts: 0 };

function renderExposure() {
  const segs = $("exposure-meter").children;
  const filled = Math.min(segs.length, exposure.entities);
  [...segs].forEach((s, i) => {
    s.classList.toggle("on", i < filled);
    s.style.transitionDelay = `${i * 28}ms`;
  });
  $("exposure-meter").setAttribute(
    "aria-label",
    `${exposure.entities} sensitive ${exposure.entities === 1 ? "entity" : "entities"} redacted`,
  );
  $("exposure-entities").textContent = String(exposure.entities);
  $("exposure-blocked").textContent = String(exposure.alerts);

  const state = $("exposure-state");
  const alert = exposure.alerts > 0;
  state.textContent = alert ? "Alert" : "Guarded";
  state.classList.toggle("alert", alert);
  $("exposure-meter").classList.toggle("alert", alert);
}

async function refreshTripwire() {
  try {
    const res = await chrome.runtime.sendMessage({ kind: "get-tripwire-log" });
    exposure.alerts = Array.isArray(res?.alerts) ? res.alerts.length : 0;
    renderExposure();
  } catch {
    /* service worker asleep; the next update will catch up */
  }
}

// ─── Model switcher ────────────────────────────────────────────────────
let settings = { provider: DEFAULT_PROVIDER, apiKeys: {}, models: {} };

function currentModel(provider = settings.provider) {
  return settings.models?.[provider] || PROVIDERS[provider]?.models[0] || "";
}

function isReady(id) {
  return PROVIDERS[id]?.local || Boolean(settings.apiKeys?.[id]);
}

function normalizeSettings(raw) {
  const s = raw ?? {};
  const apiKeys = { ...(s.apiKeys ?? {}) };
  // Legacy single-key format used by older builds.
  if (s.apiKey && !apiKeys.anthropic) apiKeys.anthropic = s.apiKey;
  const provider = PROVIDERS[s.provider] ? s.provider : DEFAULT_PROVIDER;
  return { ...s, provider, apiKeys, models: { ...(s.models ?? {}) } };
}

async function saveSelection(provider, model) {
  const raw = (await storageGet(SETTINGS_KEY)) ?? {};
  const next = {
    ...raw,
    provider,
    models: { ...(raw.models ?? {}), [provider]: model },
  };
  settings = normalizeSettings(next);
  renderModels();
  await storageSet({ [SETTINGS_KEY]: next });
}

function renderModels() {
  const chips = $("provider-chips");
  const ids = Object.keys(PROVIDERS).filter((id) => isReady(id) || id === settings.provider);
  chips.replaceChildren();

  for (const id of ids) {
    const p = PROVIDERS[id];
    const active = id === settings.provider;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `chip${active ? " active" : ""}${isReady(id) ? "" : " needs-key"}`;
    chip.setAttribute("role", "radio");
    chip.setAttribute("aria-checked", String(active));
    chip.title = `${p.label} · ${currentModel(id)}`;
    chip.innerHTML = `<span class="chip-dot" aria-hidden="true"></span>`;
    chip.append(p.chip);
    chip.addEventListener("click", () => {
      if (id !== settings.provider) saveSelection(id, currentModel(id));
    });
    chips.append(chip);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "chip chip-add";
  add.title = "Add a provider in Settings";
  add.setAttribute("aria-label", "Add a provider");
  add.innerHTML = `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>`;
  add.addEventListener("click", () => chrome.runtime.openOptionsPage());
  chips.append(add);

  const p = PROVIDERS[settings.provider];
  const model = currentModel();
  $("model-name").textContent = model;
  $("model-btn").title = `${p.label} · ${model}`;

  const note = $("model-note");
  note.classList.toggle("warn", !isReady(settings.provider));
  if (!isReady(settings.provider)) {
    note.innerHTML = "";
    const link = document.createElement("button");
    link.type = "button";
    link.className = "inline-link";
    link.textContent = "Add a key in Settings";
    link.addEventListener("click", () => chrome.runtime.openOptionsPage());
    note.append(`No ${p.label} key yet. `, link);
  } else if (p.local) {
    note.textContent = "On-device · Ollama. Nothing leaves your machine.";
  } else {
    note.textContent = `Cloud · ${p.label}. Only redacted text and pixels are sent.`;
  }

  renderModelMenu();
}

function renderModelMenu() {
  const list = $("model-list");
  const p = PROVIDERS[settings.provider];
  const model = currentModel();
  const options = p.models.includes(model) ? p.models : [model, ...p.models];

  $("model-menu-head").textContent = `${p.label} models`;
  list.replaceChildren();
  for (const m of options) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = `model-option${m === model ? " active" : ""}`;
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", String(m === model));
    opt.textContent = m;
    opt.addEventListener("click", () => {
      setModelMenu(false);
      if (m !== model) saveSelection(settings.provider, m);
    });
    list.append(opt);
  }
}

function setModelMenu(open) {
  $("model-menu").hidden = !open;
  $("model-btn").setAttribute("aria-expanded", String(open));
  $("model-btn").classList.toggle("active", open);
  if (open) {
    const active = $("model-list").querySelector(".active") ?? $("model-list").firstElementChild;
    active?.focus();
  }
}

async function initModels() {
  settings = normalizeSettings(await storageGet(SETTINGS_KEY));
  renderModels();

  $("model-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    setModelMenu($("model-menu").hidden);
  });
  $("model-menu").addEventListener("keydown", (e) => {
    const opts = [...$("model-list").querySelectorAll(".model-option")];
    const i = opts.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.stopPropagation();
      setModelMenu(false);
      $("model-btn").focus();
    } else if (e.key === "ArrowDown" && i > -1) {
      e.preventDefault();
      (opts[i + 1] ?? $("model-custom-input")).focus();
    } else if (e.key === "ArrowUp" && i > 0) {
      e.preventDefault();
      opts[i - 1].focus();
    }
  });
  $("model-custom").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = $("model-custom-input").value.trim();
    if (!value) return;
    $("model-custom-input").value = "";
    setModelMenu(false);
    saveSelection(settings.provider, value);
  });
  document.addEventListener("click", (e) => {
    if (!$("model-menu").hidden && !e.target.closest(".model-pick")) setModelMenu(false);
  });

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    renderModels();
  });
}

// ─── Screenshot inspector ──────────────────────────────────────────────
// The bundle renders the audit's before/after pairs as small thumbnails.
// This makes each pair open a full-panel viewer, and outlines exactly which
// areas were masked by comparing the original and redacted pixels.

const viewer = { audit: null, index: 0, mode: "highlight", zoom: false, cache: new Map(), returnFocus: null };

/** Areas where the redacted image differs from the original, as pixel boxes. */
function findMaskedRegions(orig, red, width, height) {
  const B = 8;
  const cols = Math.ceil(width / B);
  const rows = Math.ceil(height / B);
  const marked = new Uint8Array(cols * rows);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let sum = 0;
      let samples = 0;
      for (let y = by * B; y < Math.min(height, by * B + B); y += 2) {
        for (let x = bx * B; x < Math.min(width, bx * B + B); x += 2) {
          const i = (y * width + x) * 4;
          sum += Math.abs(orig[i] - red[i]) + Math.abs(orig[i + 1] - red[i + 1]) + Math.abs(orig[i + 2] - red[i + 2]);
          samples++;
        }
      }
      // Fallback only: opaque masks change nearly every pixel a lot, while
      // JPEG noise around text stays well below this.
      if (samples && sum / samples > 90) marked[by * cols + bx] = 1;
    }
  }
  const boxes = [];
  const seen = new Uint8Array(cols * rows);
  for (let start = 0; start < marked.length; start++) {
    if (!marked[start] || seen[start]) continue;
    let x0 = cols, y0 = rows, x1 = 0, y1 = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const cell = stack.pop();
      const cx = cell % cols;
      const cy = (cell - cx) / cols;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (marked[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    boxes.push({ x: x0 * B, y: y0 * B, w: (x1 - x0 + 1) * B, h: (y1 - y0 + 1) * B });
  }
  return boxes;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}

/** Both images at the redacted image's size, plus the masked boxes. Cached per shot. */
async function prepareShot(shot) {
  const key = shot.redacted || shot.original;
  if (viewer.cache.has(key)) return viewer.cache.get(key);
  const [orig, red] = await Promise.all([
    shot.original ? loadImage(shot.original) : null,
    shot.redacted ? loadImage(shot.redacted) : null,
  ]);
  const base = red || orig;
  const width = base.naturalWidth;
  const height = base.naturalHeight;
  let boxes = [];
  if (Array.isArray(shot.maskedBoxes)) {
    // Exact areas reported by the redaction pipeline, in image pixels.
    boxes = shot.maskedBoxes.map((b) => ({ x: b.x, y: b.y, w: b.width, h: b.height }));
  } else if (orig && red) {
    const read = (img) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height).data;
    };
    boxes = findMaskedRegions(read(orig), read(red), width, height);
  }
  const prepared = { orig, red, width, height, boxes };
  viewer.cache.set(key, prepared);
  return prepared;
}

function shotsFromDom() {
  return [...document.querySelectorAll("#audit-screenshots .screenshot-pair")].map((pair) => {
    const imgs = pair.querySelectorAll("img");
    return { original: imgs[0]?.getAttribute("src") ?? "", redacted: imgs[1]?.getAttribute("src") ?? "" };
  });
}

function currentShots() {
  const fromAudit = viewer.audit?.screenshots ?? [];
  const fromDom = shotsFromDom();
  // Prefer the richer audit payload when it matches what the bundle rendered.
  return fromAudit.length === fromDom.length && fromAudit.length > 0 ? fromAudit : fromDom;
}

function shotFacts(shot, boxes) {
  const parts = [];
  if (typeof shot.redactedCount == "number") parts.push(`${shot.redactedCount} item${shot.redactedCount === 1 ? "" : "s"} masked`);
  else if (boxes) parts.push(`${boxes.length} area${boxes.length === 1 ? "" : "s"} masked`);
  if (shot.verified === true) parts.push("verified by re-reading the image");
  else if (shot.verified === false) parts.push("not verified, so it was never sent");
  return parts.join(" · ");
}

function buildViewer() {
  const root = document.createElement("div");
  root.id = "shot-viewer";
  root.className = "shot-viewer hidden";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Screenshot inspector");
  root.innerHTML = `
    <div class="shot-viewer-bar">
      <div class="shot-viewer-modes" role="group" aria-label="View">
        <button class="chip" type="button" data-mode="highlight">What was hidden</button>
        <button class="chip" type="button" data-mode="redacted">Redacted</button>
        <button class="chip" type="button" data-mode="original">Original</button>
      </div>
      <button class="icon-btn" type="button" data-viewer="close" aria-label="Close inspector">
        <svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    </div>
    <p class="shot-viewer-note" aria-live="polite"></p>
    <div class="shot-viewer-stage" tabindex="0" aria-label="Screenshot. Click to zoom."><canvas></canvas></div>
    <div class="shot-viewer-foot">
      <button class="icon-btn" type="button" data-viewer="prev" aria-label="Previous screenshot">
        <svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" /></svg>
      </button>
      <span class="shot-viewer-count"></span>
      <button class="icon-btn" type="button" data-viewer="next" aria-label="Next screenshot">
        <svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
      </button>
      <span class="shot-viewer-spacer"></span>
      <button class="link-btn" type="button" data-viewer="zoom">Zoom in</button>
      <button class="link-btn" type="button" data-viewer="open">Open full size</button>
    </div>`;
  document.body.appendChild(root);

  root.querySelectorAll("[data-mode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      viewer.mode = btn.dataset.mode;
      renderViewer();
    }),
  );
  const act = (name, fn) => root.querySelector(`[data-viewer="${name}"]`).addEventListener("click", fn);
  act("close", closeViewer);
  act("prev", () => step(-1));
  act("next", () => step(1));
  act("zoom", toggleZoom);
  act("open", openFullSize);
  root.querySelector(".shot-viewer-stage").addEventListener("click", toggleZoom);
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeViewer(); }
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  });
  return root;
}

function step(delta) {
  const count = currentShots().length;
  if (count < 2) return;
  viewer.index = (viewer.index + delta + count) % count;
  viewer.zoom = false;
  renderViewer();
}

function toggleZoom() {
  viewer.zoom = !viewer.zoom;
  const root = $("shot-viewer");
  root.classList.toggle("zoomed", viewer.zoom);
  root.querySelector('[data-viewer="zoom"]').textContent = viewer.zoom ? "Fit to panel" : "Zoom in";
  // At full size, bring the first hidden area into view.
  const first = viewer.zoom && viewer.current?.boxes[0];
  if (first) {
    const stage = root.querySelector(".shot-viewer-stage");
    stage.scrollLeft = Math.max(0, first.x - 24);
    stage.scrollTop = Math.max(0, first.y - 24);
  }
}

function drawShot(canvas, prepared) {
  const { orig, red, width, height, boxes } = prepared;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const img = viewer.mode === "original" ? orig || red : red || orig;
  ctx.drawImage(img, 0, 0, width, height);
  if (viewer.mode !== "highlight" || boxes.length === 0) return;
  const styles = getComputedStyle(document.documentElement);
  const alert = styles.getPropertyValue("--alert").trim() || "#ec997e";
  // Dim everything that stayed as-is, then redraw the masked areas at full strength.
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.fillRect(0, 0, width, height);
  for (const b of boxes) ctx.drawImage(img, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
  const line = Math.max(2, Math.round(width / 480));
  ctx.lineWidth = line;
  ctx.strokeStyle = alert;
  ctx.font = `600 ${Math.max(11, line * 6)}px "JetBrains Mono", monospace`;
  boxes.forEach((b, i) => {
    ctx.strokeRect(b.x - line, b.y - line, b.w + line * 2, b.h + line * 2);
    const tag = String(i + 1);
    const tw = ctx.measureText(tag).width + line * 4;
    const th = Math.max(14, line * 8);
    const ty = b.y - th - line > 0 ? b.y - th - line : b.y + b.h + line;
    ctx.fillStyle = alert;
    ctx.fillRect(b.x - line, ty, tw, th);
    ctx.fillStyle = "#0d1116";
    ctx.fillText(tag, b.x + line, ty + th - line * 2);
  });
}

const MODE_NOTES = {
  highlight: (n) =>
    n === 0
      ? "Nothing on this screenshot needed masking."
      : `The ${n} outlined area${n === 1 ? " was" : "s were"} masked or blurred. Everything dimmed stayed as it was.`,
  redacted: (_, visionOn) =>
    visionOn
      ? "This redacted copy is the only version a vision model can receive."
      : "Vision is off, so no screenshot leaves your device. This is the copy that would be sent if you turned it on.",
  original: () => "The original capture. It stays on this device and is never sent.",
};

async function renderViewer() {
  const root = $("shot-viewer");
  const shots = currentShots();
  if (shots.length === 0) return closeViewer();
  viewer.index = Math.min(viewer.index, shots.length - 1);
  const shot = shots[viewer.index];
  root.querySelectorAll("[data-mode]").forEach((btn) => {
    const active = btn.dataset.mode === viewer.mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
  root.querySelector(".shot-viewer-count").textContent = `${viewer.index + 1} / ${shots.length}`;
  root.querySelector('[data-viewer="prev"]').disabled = shots.length < 2;
  root.querySelector('[data-viewer="next"]').disabled = shots.length < 2;
  root.classList.toggle("zoomed", viewer.zoom);
  root.querySelector('[data-viewer="zoom"]').textContent = viewer.zoom ? "Fit to panel" : "Zoom in";
  const note = root.querySelector(".shot-viewer-note");
  note.textContent = "Comparing the original and redacted images…";

  const token = `${viewer.index}:${viewer.mode}`;
  viewer.pending = token;
  try {
    const prepared = await prepareShot(shot);
    if (viewer.pending !== token) return;
    viewer.current = prepared;
    drawShot(root.querySelector("canvas"), prepared);
    const raw = await storageGet(SETTINGS_KEY);
    const visionOn = Boolean(raw?.vision?.enabled);
    // Highlight mode already states the count; only add the verification result.
    const facts = viewer.mode === "highlight" ? shotFacts({ verified: shot.verified }) : shotFacts(shot, prepared.boxes);
    note.textContent = MODE_NOTES[viewer.mode](prepared.boxes.length, visionOn) + (facts ? ` ${facts[0].toUpperCase()}${facts.slice(1)}.` : "");
  } catch {
    if (viewer.pending === token) note.textContent = "This screenshot could not be loaded.";
  }
}

function openFullSize() {
  $("shot-viewer").querySelector("canvas").toBlob((blob) => {
    if (blob) window.open(URL.createObjectURL(blob), "_blank");
  }, "image/png");
}

function openViewer(index) {
  viewer.index = index;
  viewer.zoom = false;
  viewer.returnFocus = document.activeElement;
  const root = $("shot-viewer") ?? buildViewer();
  root.classList.remove("hidden");
  renderViewer();
  root.querySelector('[data-viewer="close"]').focus();
}

function closeViewer() {
  $("shot-viewer")?.classList.add("hidden");
  viewer.returnFocus?.focus?.();
}

/** Caption and click target for each pair the bundle renders. */
function enhanceAuditPairs() {
  const container = $("audit-screenshots");
  const pairs = container.querySelectorAll(".screenshot-pair");
  const shots = currentShots();
  const heading = container.querySelector("h4");
  if (heading && pairs.length > 0 && !container.querySelector(".audit-shots-hint")) {
    heading.insertAdjacentHTML("afterend", '<p class="audit-shots-hint empty-sub">Tap a screenshot to see exactly what was hidden.</p>');
  }
  pairs.forEach((pair, i) => {
    if (pair.dataset.inspectable) return;
    pair.dataset.inspectable = "true";
    pair.setAttribute("role", "button");
    pair.tabIndex = 0;
    pair.setAttribute("aria-label", `Inspect screenshot ${i + 1}`);
    const facts = shots[i] ? shotFacts(shots[i]) : "";
    pair.insertAdjacentHTML(
      "beforeend",
      `<div class="shot-meta"><span>Screenshot ${i + 1}${facts ? ` · ${facts}` : ""}</span><span class="shot-meta-open">Inspect</span></div>`,
    );
    pair.addEventListener("click", () => openViewer(i));
    pair.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openViewer(i); }
    });
  });
}

function initAuditViewer() {
  const container = $("audit-screenshots");
  if (!container) return;
  new MutationObserver(() => {
    viewer.cache.clear();
    enhanceAuditPairs();
  }).observe(container, { childList: true });
  enhanceAuditPairs();
  // Closing the audit sheet also closes the inspector.
  $("audit-close")?.addEventListener("click", closeViewer);
}

// ─── Wire-up ───────────────────────────────────────────────────────────
async function init() {
  initAuditViewer();
  initToolsMenu();
  shuffleSuggestions();
  initGreeting(await storageGet(PROFILE_KEY));
  renderExposure();
  refreshTripwire();
  await initModels();

  $("new-task-btn").addEventListener("click", () => {
    exposure.entities = 0;
    renderExposure();
    shuffleSuggestions();
    renderGreeting();
    refreshTripwire();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === "privacy-audit") {
      viewer.audit = msg.audit ?? null;
      exposure.entities = Number(msg.audit?.totalRedacted ?? msg.audit?.totalPIIDetections ?? 0);
      renderExposure();
    } else if (msg?.kind === "tripwire-update") {
      refreshTripwire();
    }
  });

  // Re-roll the greeting whenever the panel is reopened on an empty ledger.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !$("empty").classList.contains("hidden")) {
      renderGreeting();
    }
  });
}

init();
