// Mirrors run progress onto the in-page launcher (src/content/launcher.ts) of
// the tab a run started in, so a task started from the page can be followed,
// approved and stopped without opening the side panel.

import type { TranscriptEntry } from "../shared/types";
import type { AgentEvent } from "./agent/loop";

export const LAUNCHER_KEY = "pry-launcher";

export interface LauncherPrefs {
  enabled: boolean;
  /** Hosts where the user hid the button; the shortcut still opens it there. */
  hiddenHosts: string[];
}

export const DEFAULT_LAUNCHER_PREFS: LauncherPrefs = { enabled: true, hiddenHosts: [] };

export type LauncherMessage =
  | { kind: "launcher-update"; running: boolean; tone: "info" | "step" | "answer" | "error"; text: string }
  | { kind: "launcher-confirm"; id: string; summary: string }
  | { kind: "launcher-confirm-done"; id: string };

const MAX_TEXT = 600;
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

/** The launcher message for one agent event, or null when the launcher does not show it. */
export function launcherMessageFor(event: AgentEvent, transcript: TranscriptEntry[]): LauncherMessage | null {
  if (event.kind === "status") {
    if (event.running) return { kind: "launcher-update", running: true, tone: "info", text: "Starting…" };
    // The run's outcome: its last answer or error, after the task that started it.
    const lastTask = transcript.map((e) => e.role).lastIndexOf("user");
    const outcome = [...transcript.slice(lastTask + 1)]
      .reverse()
      .find((e) => e.role === "assistant" || e.role === "error" || (e.role === "system" && e.text === "Stopped."));
    if (!outcome) return { kind: "launcher-update", running: false, tone: "info", text: "Stopped." };
    return {
      kind: "launcher-update",
      running: false,
      tone: outcome.role === "error" ? "error" : outcome.role === "system" ? "info" : "answer",
      text: clip(outcome.text.trim() || "Done."),
    };
  }
  if (event.kind === "entry") {
    const entry = (event as { entry: TranscriptEntry }).entry;
    if (entry.role === "step") return { kind: "launcher-update", running: true, tone: "step", text: clip(entry.text) };
    if (entry.role === "error") return { kind: "launcher-update", running: true, tone: "error", text: clip(entry.text) };
    return null;
  }
  if (event.kind === "confirm") {
    return { kind: "launcher-confirm", id: String(event.id), summary: clip(String(event.summary ?? "")) };
  }
  return null;
}
