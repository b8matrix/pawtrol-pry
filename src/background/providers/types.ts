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

export interface PlannerResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  refusal?: string;
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
