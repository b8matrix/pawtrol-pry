import { readLocal } from "./storage";
import type { TranscriptEntry } from "../shared/types";

const HISTORY_KEY = "pry-session-history";
const MAX_SESSIONS = 50;

export interface SessionRecord {
  id: string;
  task: string;
  startedAt: number;
  completedAt: number;
  status: "completed" | "failed" | "stopped";
  transcript: TranscriptEntry[];
  summary: string;
  piiRedacted: number;
  durationMs: number;
}

export async function saveSession(session: SessionRecord): Promise<void> {
  const sessions = (await readLocal<SessionRecord[]>(HISTORY_KEY)) ?? [];
  sessions.unshift(session);
  if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
  await chrome.storage.local.set({ [HISTORY_KEY]: sessions });
}

export async function getSessions(): Promise<SessionRecord[]> {
  return (await readLocal<SessionRecord[]>(HISTORY_KEY)) ?? [];
}

export async function deleteSession(id: string): Promise<void> {
  const sessions = ((await readLocal<SessionRecord[]>(HISTORY_KEY)) ?? []).filter((s) => s.id !== id);
  await chrome.storage.local.set({ [HISTORY_KEY]: sessions });
}

export async function clearSessions(): Promise<void> {
  await chrome.storage.local.remove(HISTORY_KEY);
}
