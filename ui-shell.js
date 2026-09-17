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

// ─── Wire-up ───────────────────────────────────────────────────────────
async function init() {
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
