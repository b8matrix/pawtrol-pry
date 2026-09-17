// Rules the reflection step derives from past runs (false-positive filters,
// planner strategy hints, site patterns). Confidence decays daily; stale or
// weak rules are pruned on every save.

import { readLocal } from "../storage";

const RULES_KEY = "pry-learned-rules";
const MAX_RULES = 500;
const DAILY_DECAY = 0.005;
const STALE_AFTER_DAYS = 30;
const STALE_MIN_CONFIDENCE = 0.6;
const MS_PER_DAY = 86_400_000;

export type RuleCategory = "pii_detection" | "strategy" | "site_pattern" | "redaction";

export interface LearnedRule {
  id: string;
  category: RuleCategory;
  description: string;
  pattern: { domain?: string; pageType?: string; condition: string; action: string };
  confidence: number;
  confirmedCount: number;
  createdAt: number;
  lastConfirmedAt: number;
}

export interface ReflectionResults {
  newRules: LearnedRule[];
  confirmedRules: string[];
  contradictedRules: string[];
}

async function loadRules(): Promise<LearnedRule[]> {
  return (await readLocal<LearnedRule[]>(RULES_KEY)) ?? [];
}

/** Decay confidence by age, dropping rules that are too weak or stale. Mutates confidences. */
export function applyRuleLifecycle(rules: LearnedRule[], now = Date.now()): LearnedRule[] {
  const kept: LearnedRule[] = [];
  for (const rule of rules) {
    const ageDays = Math.max(0, (now - rule.lastConfirmedAt) / MS_PER_DAY);
    const confidence = rule.confidence * Math.pow(1 - DAILY_DECAY, ageDays);
    rule.confidence = confidence;
    if (confidence < 0.1) continue;
    if (ageDays > STALE_AFTER_DAYS && confidence < STALE_MIN_CONFIDENCE) continue;
    kept.push(rule);
  }
  return kept;
}

async function saveRules(rules: LearnedRule[]): Promise<void> {
  rules = applyRuleLifecycle(rules);
  if (rules.length > MAX_RULES) {
    rules.sort((a, b) => b.confidence - a.confidence);
    rules.length = MAX_RULES;
  }
  await chrome.storage.local.set({ [RULES_KEY]: rules });
}

export async function applyReflectionResults(results: ReflectionResults): Promise<void> {
  const rules = await loadRules();
  for (const rule of results.newRules) {
    const duplicate = rules.some(
      (r) =>
        r.category === rule.category &&
        r.pattern.condition === rule.pattern.condition &&
        r.pattern.domain === rule.pattern.domain,
    );
    if (!duplicate) rules.push(rule);
  }
  for (const id of results.confirmedRules) {
    const rule = rules.find((r) => r.id === id);
    if (!rule) continue;
    rule.confirmedCount++;
    rule.confidence = Math.min(1, rule.confidence + 0.1);
    rule.lastConfirmedAt = Date.now();
  }
  for (const id of results.contradictedRules) {
    const rule = rules.find((r) => r.id === id);
    if (!rule) continue;
    rule.confidence = Math.max(0, rule.confidence - 0.2);
    if (rule.confidence < 0.1) {
      const index = rules.indexOf(rule);
      if (index >= 0) rules.splice(index, 1);
    }
  }
  await saveRules(rules);
}

export async function getLearnedRules(): Promise<LearnedRule[]> {
  return loadRules();
}

export async function getApplicableRules(domain: string, pageType: string): Promise<LearnedRule[]> {
  return (await loadRules()).filter((rule) => {
    if (rule.pattern.domain && rule.pattern.domain !== domain) return false;
    if (rule.pattern.pageType && rule.pattern.pageType !== pageType) return false;
    return rule.confidence >= 0.3;
  });
}

export async function getRulesByCategory(category: RuleCategory): Promise<LearnedRule[]> {
  return (await loadRules()).filter((rule) => rule.category === category);
}

/** "<kind>:<method>" keys for confident false-positive rules. */
export function buildSuppressionKeys(rules: LearnedRule[]): Set<string> {
  const keys = new Set<string>();
  for (const rule of rules) {
    if (rule.category !== "pii_detection" || rule.confidence < 0.5) continue;
    const match = rule.pattern.condition.match(/^false_positive:([^:]+):([^:]+)$/);
    if (match) keys.add(`${match[1]}:${match[2]}`);
  }
  return keys;
}

export function recommendsLLMOnly(rules: LearnedRule[]): boolean {
  return rules.some((r) => r.category === "strategy" && r.pattern.action === "use_llm" && r.confidence >= 0.5);
}

export async function getRulesSummary() {
  const rules = await loadRules();
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const byCategory: Record<string, number> = {};
  let highConfidence = 0;
  let recentlyCreated = 0;
  for (const rule of rules) {
    byCategory[rule.category] = (byCategory[rule.category] ?? 0) + 1;
    if (rule.confidence >= 0.7) highConfidence++;
    if (rule.createdAt > hourAgo) recentlyCreated++;
  }
  const recent = [...rules]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10)
    .map((r) => ({
      id: r.id,
      category: r.category,
      description: r.description,
      confidence: r.confidence,
      confirmedCount: r.confirmedCount,
      createdAt: r.createdAt,
    }));
  return { total: rules.length, byCategory, highConfidence, recentlyCreated, recent };
}

export async function clearLearnedRules(): Promise<void> {
  await chrome.storage.local.remove(RULES_KEY);
}
