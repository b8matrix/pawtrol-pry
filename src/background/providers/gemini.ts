// Gemini adapter — uses the Google AI REST API (AI Studio) with SSE streaming.
// Get a free API key at https://aistudio.google.com/app/apikey
//
// Converts Pawtrol's provider-neutral ConversationMessage format to Gemini's
// Content[] wire format, streams tokens, and maps stop reasons.

import { ProviderError, parseToolInput } from "./types";
import type { ConversationMessage, Planner, PlannerResponse, StopReason, ToolDefinition } from "./types";

// ---------------------------------------------------------------------------
// Wire-format types (subset of the Gemini REST API we actually use)
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function toGeminiContents(messages: ConversationMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const callIdToName = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content }] });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (msg.text) parts.push({ text: msg.text });
      for (const call of msg.toolCalls) {
        callIdToName.set(call.id, call.name);
        parts.push({ functionCall: { name: call.name, args: call.input } });
      }
      if (parts.length === 0) parts.push({ text: "(no output)" });
      contents.push({ role: "model", parts });
      continue;
    }

    // role === "tool"
    // Gemini expects tool results as a "user" turn with functionResponse parts.
    const parts: GeminiPart[] = msg.results.map((r) => {
      const functionName = callIdToName.get(r.id) || r.id;
      return {
        functionResponse: {
          name: functionName,
          response: { content: r.content },
        },
      };
    });
    contents.push({ role: "user", parts });
  }

  return contents;
}

/**
 * Strips disallowed JSON schema keywords from tool parameters before sending
 * to the Gemini API. Gemini uses a strict subset of OpenAPI 3.0 schema and
 * rejects any unknown properties (such as additionalProperties, $schema, etc.)
 * with an HTTP 400 error.
 */
function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const ALLOWED_KEYS = new Set([
    "type",
    "properties",
    "required",
    "description",
    "enum",
    "items",
    "nullable",
    "format",
  ]);

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED_KEYS.has(key)) continue;

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const sanitizedProps: Record<string, unknown> = {};
      for (const [propKey, propVal] of Object.entries(value as Record<string, unknown>)) {
        if (propVal && typeof propVal === "object" && !Array.isArray(propVal)) {
          sanitizedProps[propKey] = sanitizeGeminiSchema(propVal as Record<string, unknown>);
        } else {
          sanitizedProps[propKey] = propVal;
        }
      }
      result[key] = sanitizedProps;
    } else if (key === "items" && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = sanitizeGeminiSchema(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  if (!result.type) {
    result.type = "object";
  }
  if (result.type === "object" && !result.properties) {
    result.properties = {};
  }

  return result;
}

function toGeminiTools(tools: ToolDefinition[]): GeminiFunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: sanitizeGeminiSchema((t.parameters || {}) as Record<string, unknown>),
  }));
}

function toStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "refusal";
    default:
      return "end_turn";
  }
}

function friendlyError(error: unknown): Error {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("api key") || msg.includes("api_key") || msg.includes("401")) {
      return new ProviderError("Gemini rejected your API key. Check it in the extension options.");
    }
    if (msg.includes("quota") || msg.includes("429")) {
      return new ProviderError("Gemini rate-limited this request. Wait a moment and retry.");
    }
    if (msg.includes("404") || msg.includes("not found")) {
      return new ProviderError("Gemini does not recognise that model id. Pick another in the extension options.");
    }
    return error;
  }
  return new Error(String(error));
}

// ---------------------------------------------------------------------------
// Planner factory
// ---------------------------------------------------------------------------

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export function createGeminiPlanner(apiKey: string, model: string): Planner {
  return {
    label: `Gemini ${model}`,

    async run({ system, messages, tools, signal, onText }): Promise<PlannerResponse> {
      const url = `${BASE_URL}/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;

      const body: Record<string, unknown> = {
        system_instruction: { parts: [{ text: system }] },
        contents: toGeminiContents(messages),
        generation_config: { max_output_tokens: 8192 },
      };

      const geminiTools = toGeminiTools(tools);
      if (geminiTools.length > 0) {
        body.tools = [{ function_declarations: geminiTools }];
        body.tool_config = { function_calling_config: { mode: "AUTO" } };
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        throw friendlyError(error);
      }

      if (!response.ok) {
        let detail = "";
        try {
          const errBody = (await response.json()) as { error?: { message?: string } };
          detail = errBody?.error?.message ?? "";
        } catch {
          // ignore JSON parse failure on error body
        }
        if (response.status === 401 || response.status === 403) {
          throw new ProviderError("Gemini rejected your API key. Check it in the extension options.");
        }
        if (response.status === 429) {
          throw new ProviderError("Gemini rate-limited this request. Wait a moment and retry.");
        }
        if (response.status === 404) {
          throw new ProviderError(`Gemini model "${model}" not found. Check the model ID in options.`);
        }
        throw new ProviderError(`Gemini API error ${response.status}${detail ? ": " + detail : ""}`);
      }

      // --- SSE streaming ---
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      let fullText = "";
      let finishReason: string | undefined;
      const rawCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

      try {
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;

            let chunk: GeminiStreamChunk;
            try {
              chunk = JSON.parse(jsonStr) as GeminiStreamChunk;
            } catch {
              continue;
            }

            const candidate = chunk.candidates?.[0];
            if (!candidate) continue;

            if (candidate.finishReason) finishReason = candidate.finishReason;

            for (const part of candidate.content?.parts ?? []) {
              if (part.text) {
                fullText += part.text;
                onText(part.text);
              }
              if (part.functionCall) {
                rawCalls.push({
                  name: part.functionCall.name,
                  args: part.functionCall.args ?? {},
                });
              }
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") throw friendlyError(error);
      }

      const toolCalls = rawCalls.map((call, idx) => ({
        id: `call_${call.name}_${idx}_${Date.now()}`,
        name: call.name,
        input: parseToolInput(call.args),
      }));

      const stopReason = toStopReason(finishReason);

      return {
        text: fullText,
        toolCalls,
        stopReason: toolCalls.length > 0 ? "tool_use" : stopReason,
        refusal: stopReason === "refusal" ? (finishReason ?? "safety") : undefined,
      };
    },
  };
}
