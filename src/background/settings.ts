import type { Settings } from "../shared/types";

export const DEFAULT_SETTINGS: Settings = {
  provider: "ollama",
  apiKeys: { anthropic: "", openai: "", openrouter: "", ollama: "", groq: "", nvidia: "", gemini: "" },
  models: {
    anthropic: "claude-opus-5",
    openai: "gpt-5",
    openrouter: "anthropic/claude-opus-5",
    ollama: "qwen2.5:1.5b",
    groq: "openai/gpt-oss-20b",
    nvidia: "nvidia/nemotron-3.5-lightning-30b-a3b",
    gemini: "gemini-2.0-flash",
  },
  maxSteps: 40,
  confirmRisky: true,
  vision: { enabled: false, model: "" },
  privacy: { blurFaces: true, maskCredentials: true, tokenizePII: true, showRedactionLabels: false },
};

/**
 * Merge stored settings over the defaults, migrating older shapes:
 * a top-level `apiKey`/`model` (Anthropic-only builds) and `server.enabled`
 * (which used to switch vision on).
 */
export function normalizeSettings(stored: unknown): Settings {
  const raw = (stored ?? {}) as Record<string, any>;
  const serverEnabled = raw.server?.enabled === true;
  const rest = { ...raw };
  delete rest.server;

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...rest,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(rest.apiKeys ?? {}) },
    models: { ...DEFAULT_SETTINGS.models, ...(rest.models ?? {}) },
    vision: { ...DEFAULT_SETTINGS.vision, ...(rest.vision ?? {}), enabled: rest.vision?.enabled ?? serverEnabled },
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(rest.privacy ?? {}) },
  };
  if (rest.apiKey && !settings.apiKeys.anthropic) settings.apiKeys.anthropic = rest.apiKey;
  if (rest.model && !rest.models) settings.models.anthropic = rest.model;
  if (settings.models.gemini === "gemini-2.5-flash" || settings.models.gemini === "gemini-2.5-pro") {
    settings.models.gemini = "gemini-2.0-flash";
  }
  return settings;
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return normalizeSettings(settings);
}
