// Semantic memory: short LLM-written lessons from failed runs, and step
// sequences from successful runs, both keyed by domain and page type.

import { readLocal } from "../storage";
import type { Planner } from "../providers/types";
import { REFLECTION_PROMPT } from "../agent/prompts";
import type { Experience } from "./experience-memory";

const LESSONS_KEY = "pry-lessons";
const MAX_LESSONS = 50;
const TRAJECTORIES_KEY = "pry-trajectories";
const MAX_TRAJECTORIES = 30;
const MAX_PER_DOMAIN = 5;

export interface Lesson {
  id: string;
  domain: string;
  pageType: string;
  text: string;
  createdAt: number;
}

export interface Trajectory {
  id: string;
  domain: string;
  pageType: string;
  task: string;
  steps: string;
  answer: string;
  createdAt: number;
}

function capPerDomain<T extends { domain: string }>(items: T[]): T[] {
  const perDomain = new Map<string, number>();
  return items.filter((item) => {
    const count = perDomain.get(item.domain) ?? 0;
    if (count >= MAX_PER_DOMAIN) return false;
    perDomain.set(item.domain, count + 1);
    return true;
  });
}

const randomSuffix = () => Math.random().toString(36).slice(2, 6);

export async function getLessons(): Promise<Lesson[]> {
  return (await readLocal<Lesson[]>(LESSONS_KEY)) ?? [];
}

export async function addLessons(domain: string, pageType: string, texts: string[]): Promise<number> {
  const lessons = await getLessons();
  let added = 0;
  for (const raw of texts) {
    const text = raw.replace(/^[-*•\s]+/, "").trim().slice(0, 300);
    if (!text || lessons.some((l) => l.domain === domain && l.text === text)) continue;
    lessons.unshift({ id: `lesson-${Date.now()}-${randomSuffix()}`, domain, pageType, text, createdAt: Date.now() });
    added++;
  }
  await chrome.storage.local.set({ [LESSONS_KEY]: capPerDomain(lessons).slice(0, MAX_LESSONS) });
  return added;
}

export function selectLessons(lessons: Lesson[], domain: string, pageType: string, limit = 3): Lesson[] {
  return lessons
    .filter((l) => l.domain === domain && (l.pageType === pageType || l.pageType === ""))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export async function getTrajectories(): Promise<Trajectory[]> {
  return (await readLocal<Trajectory[]>(TRAJECTORIES_KEY)) ?? [];
}

export async function addTrajectory(trajectory: Omit<Trajectory, "id" | "createdAt">): Promise<void> {
  const existing = await getTrajectories();
  const entry: Trajectory = {
    ...trajectory,
    task: trajectory.task.slice(0, 200),
    answer: trajectory.answer.slice(0, 200),
    createdAt: Date.now(),
    id: `traj-${Date.now()}-${randomSuffix()}`,
  };
  const others = existing.filter((t) => !(t.domain === entry.domain && t.task === entry.task));
  others.unshift(entry);
  await chrome.storage.local.set({ [TRAJECTORIES_KEY]: capPerDomain(others).slice(0, MAX_TRAJECTORIES) });
}

/** Same-page-type successes first, then other pages on the same domain. */
export function selectTrajectories(trajectories: Trajectory[], domain: string, pageType: string, limit = 2): Trajectory[] {
  const newest = [...trajectories].sort((a, b) => b.createdAt - a.createdAt);
  const samePage = newest.filter((t) => t.domain === domain && t.pageType === pageType);
  const sameDomain = newest.filter((t) => t.domain === domain && t.pageType !== pageType);
  return [...samePage, ...sameDomain].slice(0, limit);
}

/** Ask the planner model for up to 3 lessons about a finished run. */
export async function generateLessons(planner: Planner, experience: Experience): Promise<string[]> {
  const actions = experience.actions
    .map((a) => `- ${a.tool} ${a.success ? "ok" : `FAILED (${a.cause ?? "unknown"})`}`)
    .join("\n");
  const prompt = `Task: ${experience.task.slice(0, 300)}
Site: ${experience.domain} (${experience.pageType})
Outcome: ${experience.taskSuccess ? "success" : "failure"}
Actions:
${actions}

Write up to 3 lessons for the next run on ${experience.domain}.`;

  const response = await planner.run({
    system: REFLECTION_PROMPT,
    messages: [{ role: "user", content: prompt }],
    tools: [],
    signal: new AbortController().signal,
    onText: () => {},
  });
  return response.text
    .split("\n")
    .map((line) => line.replace(/^[-*•\s\d.]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}
