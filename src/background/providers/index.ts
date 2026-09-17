import type { ProviderId, Settings } from "../../shared/types";
import { DEFAULT_SETTINGS } from "../settings";
import { createAnthropicPlanner } from "./anthropic";
import { createOllamaPlanner } from "./ollama";
import { createOpenAICompatiblePlanner, type OpenAICompatibleOptions } from "./openai-compatible";
import { ProviderError, type Planner } from "./types";

type CompatibleProvider = Exclude<ProviderId, "anthropic" | "ollama">;

const COMPATIBLE: Record<CompatibleProvider, OpenAICompatibleOptions> = {
  openai: {
    displayName: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    maxTokens: 8000,
    maxTokensParam: "max_completion_tokens",
    streamReasoning: false,
  },
  openrouter: {
    displayName: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    maxTokens: 8000,
    maxTokensParam: "max_tokens",
    streamReasoning: false,
    defaultHeaders: { "HTTP-Referer": "https://github.com/pry/pry-agent", "X-Title": "Pawtrol" },
  },
  groq: {
    displayName: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    maxTokens: 2048,
    maxTokensParam: "max_tokens",
    streamReasoning: false,
  },
  nvidia: {
    displayName: "NVIDIA",
    baseURL: "https://integrate.api.nvidia.com/v1",
    maxTokens: 2048,
    maxTokensParam: "max_tokens",
    streamReasoning: false,
  },
};

export function createPlanner(settings: Settings): Planner {
  const provider = settings.provider;
  const apiKey = settings.apiKeys[provider] ?? "";
  const model = (settings.models[provider] ?? "").trim() || DEFAULT_SETTINGS.models[provider] || "";
  if (!model) throw new ProviderError(`No model chosen for ${provider}. Pick one in the extension options.`);
  if (provider === "ollama") return createOllamaPlanner(model);
  if (!apiKey) throw new ProviderError(`No API key set for ${provider}. Open the extension options and add one.`);
  if (provider === "anthropic") return createAnthropicPlanner(apiKey, model);
  return createOpenAICompatiblePlanner(apiKey, model, COMPATIBLE[provider]);
}

export type { Planner } from "./types";
