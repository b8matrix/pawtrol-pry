// Formatting sanitized page state into model context, plus small helpers the
// loop needs (timeouts, byte counts).

import type { PageSnapshot } from "../../shared/types";

/** URL without query or fragment — queries often carry emails, tokens or search terms. */
export function stripUrlQuery(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `${parsed.protocol}//${parsed.host || ""}`;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

/** The compact text form of a (sanitized) snapshot sent to the planner. */
export function formatSnapshot(snapshot: PageSnapshot): string {
  const lines = snapshot.elements.map((element) => {
    const parts = [`[${element.id}]${element.role}`];
    if (element.name) {
      parts.push(JSON.stringify(element.name.length > 40 ? element.name.slice(0, 40) + "..." : element.name));
    }
    if (element.value) {
      parts.push(`=${JSON.stringify(element.value.length > 30 ? element.value.slice(0, 30) + "..." : element.value)}`);
    }
    if (element.attrs) {
      const attrs = Object.entries(element.attrs)
        .filter(([key]) => key !== "offscreen")
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      if (attrs) parts.push(`(${attrs})`);
    }
    return parts.join(" ");
  });
  return [
    `URL: ${stripUrlQuery(snapshot.url)}`,
    `Title: ${snapshot.title}`,
    `Scroll: ${snapshot.scroll.y}/${snapshot.scroll.maxY}`,
    `Elements${snapshot.truncated ? "(truncated)" : ""}:`,
    ...lines,
    `Text: ${snapshot.text}`,
  ].join("\n");
}

/**
 * Keep at most `limit` elements, on-screen first. Groq/NVIDIA (small context
 * windows) drop offscreen elements entirely, even when under the limit.
 */
export function fitSnapshot(snapshot: PageSnapshot, limit: number, dropOffscreen: boolean): PageSnapshot {
  let fitted = snapshot;
  if (dropOffscreen) fitted = { ...fitted, elements: fitted.elements.filter((e) => !e.attrs?.offscreen) };
  if (fitted.elements.length > limit) {
    const onscreen = fitted.elements.filter((e) => !e.attrs?.offscreen);
    const offscreen = fitted.elements.filter((e) => e.attrs?.offscreen);
    fitted = { ...fitted, elements: [...onscreen, ...offscreen].slice(0, limit), truncated: true };
  }
  return fitted;
}

export function isRetryablePlannerError(message: string): boolean {
  return /did not respond within|rate.?limit|timed? ?out|network|fetch failed|econn|overloaded|temporarily|503|429|502|504|timeout/i.test(
    message,
  );
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  return typeof AbortSignal.any == "function" ? AbortSignal.any([a, b]) : a;
}

export function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}
