// Provider-neutral conversation model used by the agent loop. Each adapter
// converts it to its API's wire format.

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  id: string;
  content: string;
  isError?: boolean;
}

export type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResultContent[] };

export type StopReason = "tool_use" | "end_turn" | "max_tokens" | "refusal";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface PlannerResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  refusal?: string;
  /** Reported by the provider when it sends usage; absent otherwise. */
  usage?: TokenUsage;
}

export interface PlannerRequest {
  system: string;
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  onText: (delta: string) => void;
}

export interface Planner {
  label: string;
  run(request: PlannerRequest): Promise<PlannerResponse>;
}

/** An error whose message is already written for the user. */
export class ProviderError extends Error {}

/** The provider asked us to slow down; retrying after `retryAfterMs` should work. */
export class RateLimitError extends ProviderError {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/** Parse "6.2s", "1m30s", "577ms" or plain seconds ("7") into milliseconds. */
export function parseDurationMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (parts.length === 0) return null;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(parts.reduce((total, [, n, u]) => total + Number(n) * unit[u], 0));
}

/** Tool inputs arrive as objects or JSON strings depending on the provider. */
export function parseToolInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw == "object") return raw as Record<string, unknown>;
  if (typeof raw != "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed == "object" ? parsed : {};
  } catch {
    return {};
  }
}
