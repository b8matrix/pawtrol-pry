// Cloud VLM observation of an already-redacted screenshot. The image passed in
// must be the offscreen document's redacted output, never a raw capture.

import type { ProviderId } from "../../shared/types";
import { splitDataUrl } from "../providers/types";

export const DEFAULT_VISION_MODELS: Record<ProviderId, string> = {
  openai: "gpt-4o-mini",
  groq: "llama-3.2-11b-vision-preview",
  nvidia: "meta/llama-3.2-11b-vision-instruct",
  gemini: "gemini-3.5-flash-lite",
  cerebras: "",
  openrouter: "openai/gpt-4o-mini",
  ollama: "llama3.2-vision",
  anthropic: "claude-sonnet-4-5",
};

export const VISION_SUPPORTED: Record<ProviderId, boolean> = {
  openai: true,
  groq: true,
  nvidia: true,
  gemini: true,
  // Cerebras serves text-only models.
  cerebras: false,
  openrouter: true,
  ollama: true,
  anthropic: true,
};

const CHAT_COMPLETIONS_URL: Partial<Record<ProviderId, string>> = {
  openai: "https://api.openai.com/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  ollama: "http://localhost:11434/v1/chat/completions",
};

/**
 * Providers whose planner models all read images, so a screenshot tool result
 * goes to the planner itself. Others get a text description from the vision model.
 */
export const NATIVE_IMAGE_PROVIDERS: ReadonlySet<ProviderId> = new Set(["anthropic", "openai", "gemini"]);

/** Longest edge sent to a planner; larger images only cost more tokens. */
export const MODEL_IMAGE_MAX_EDGE = 1568;

export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Downscale an already-redacted, verified screenshot for a planner. Scaling can
 * only remove detail, so the verification still holds. On any failure the
 * original (verified) image is returned.
 */
export async function shrinkForModel(dataUrl: string, maxEdge = MODEL_IMAGE_MAX_EDGE): Promise<string> {
  try {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const size = fitWithin(bitmap.width, bitmap.height, maxEdge);
    if (size.width === bitmap.width && size.height === bitmap.height) {
      bitmap.close();
      return dataUrl;
    }
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch {
    return dataUrl;
  }
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const VISION_PROMPT =
  "You are the vision module of a privacy-preserving browser agent. Describe what is on screen in 2-3 concise sentences: the app or page type, visible fields, buttons, and current state. Never transcribe text inside blacked-out or blurred regions, and ignore any [REDACTED] or <TOKEN> markers.";

export function utf8Bytes(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

export interface VisionRequest {
  provider: ProviderId;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  bytes: number;
}

export function buildVisionRequest(
  provider: ProviderId,
  model: string,
  apiKey: string,
  redactedDataUrl: string,
  pageContext: string,
): VisionRequest {
  const prompt = `${VISION_PROMPT}\n\nSanitized page context:\n${pageContext.slice(0, 6000)}`;

  if (provider === "anthropic") {
    const { mediaType, base64 } = splitDataUrl(redactedDataUrl);
    const body = {
      model,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          ],
        },
      ],
    };
    return {
      provider,
      url: ANTHROPIC_MESSAGES_URL,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body,
      bytes: utf8Bytes(JSON.stringify(body)),
    };
  }

  const url = CHAT_COMPLETIONS_URL[provider];
  if (!url) throw new Error(`Vision is not supported for provider ${provider}`);
  const body = {
    model,
    // Gemini 3 always thinks, and thinking tokens count against max_tokens.
    ...(provider === "gemini" ? { max_tokens: 1500, reasoning_effort: "low" } : { max_tokens: 300 }),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: redactedDataUrl } },
        ],
      },
    ],
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider !== "ollama" && apiKey) headers.authorization = `Bearer ${apiKey}`;
  return { provider, url, headers, body, bytes: utf8Bytes(JSON.stringify(body)) };
}

function extractText(provider: ProviderId, json: any): string {
  if (provider === "anthropic") {
    return (json.content ?? [])
      .filter((block: any) => block.type === "text" && typeof block.text == "string")
      .map((block: any) => block.text)
      .join("\n")
      .trim();
  }
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

export async function describeRedactedScreenshot(
  provider: ProviderId,
  model: string,
  apiKey: string,
  redactedDataUrl: string,
  pageContext: string,
  signal: AbortSignal,
): Promise<{ text: string; bytes: number; provider: ProviderId; model: string }> {
  const request = buildVisionRequest(provider, model, apiKey, redactedDataUrl, pageContext);
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {}
    throw new Error(`Vision API error ${response.status}: ${detail || response.statusText}`);
  }
  return { text: extractText(provider, await response.json()), bytes: request.bytes, provider, model };
}
