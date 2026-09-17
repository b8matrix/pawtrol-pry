// Per-run experience records (what was detected, which actions ran, outcome).
// Values are never stored — only kinds, methods and outcomes.

import { readLocal } from "../storage";

const EXPERIENCE_KEY = "pry-experience-memory";
const MAX_EXPERIENCES = 200;

export type DetectionOutcome = "true_positive" | "false_positive" | "missed";

export interface PIIDetectionRecord {
  kind: string;
  method: string;
  outcome: DetectionOutcome;
  confidence: number;
}

export interface ActionRecord {
  tool: string;
  success: boolean;
  latencyMs: number;
  strategy: "deterministic" | "llm";
  error?: string;
  cause?: string;
}

export interface Experience {
  id: string;
  timestamp: number;
  task: string;
  domain: string;
  pageType: string;
  piiDetections: PIIDetectionRecord[];
  actions: ActionRecord[];
  taskSuccess: boolean;
  durationMs: number;
  piiRedacted: number;
  estimatedTokens: number;
  rulesApplied: number;
  egressBytes: number;
  reocrVerified: boolean;
  reocrLeakedPII: string[];
  rulesFired: string[];
  rulesGenerated: string[];
  userCorrections: string[];
}

async function loadAll(): Promise<Experience[]> {
  return (await readLocal<Experience[]>(EXPERIENCE_KEY)) ?? [];
}

async function saveAll(experiences: Experience[]): Promise<void> {
  if (experiences.length > MAX_EXPERIENCES) experiences = experiences.slice(0, MAX_EXPERIENCES);
  await chrome.storage.local.set({ [EXPERIENCE_KEY]: experiences });
}

export async function recordExperience(experience: Experience): Promise<void> {
  const all = await loadAll();
  all.unshift(experience);
  await saveAll(all);
}

export async function updateExperienceOutcome(id: string, success: boolean): Promise<boolean> {
  const all = await loadAll();
  const experience = all.find((e) => e.id === id);
  if (!experience) return false;
  experience.taskSuccess = success;
  await saveAll(all);
  return true;
}

export async function getAllExperiences(): Promise<Experience[]> {
  return loadAll();
}

export async function getExperiencesForDomain(domain: string): Promise<Experience[]> {
  return (await loadAll()).filter((e) => e.domain === domain);
}

export async function getExperiencesForPageType(pageType: string): Promise<Experience[]> {
  return (await loadAll()).filter((e) => e.pageType === pageType);
}

export async function getRecentExperiences(count: number): Promise<Experience[]> {
  return (await loadAll()).slice(0, count);
}

function actionSuccessRate(experience: Experience): number {
  if (experience.actions.length === 0) return 1;
  return experience.actions.filter((a) => a.success).length / experience.actions.length;
}

export interface MemoryStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  totalPIIDetected: number;
  totalPIIRedacted: number;
  totalFalsePositives: number;
  totalMissedPII: number;
  averageSuccessRate: number;
  sitesVisited: number;
  rulesLearned: number;
  improvementDelta: number;
  totalUserCorrections: number;
}

export async function getMemoryStats(): Promise<MemoryStats> {
  const all = await loadAll();
  if (all.length === 0) {
    return {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      totalPIIDetected: 0,
      totalPIIRedacted: 0,
      totalFalsePositives: 0,
      totalMissedPII: 0,
      averageSuccessRate: 0,
      sitesVisited: 0,
      rulesLearned: 0,
      improvementDelta: 0,
      totalUserCorrections: 0,
    };
  }

  const totalRuns = all.length;
  const successfulRuns = all.filter((e) => e.taskSuccess).length;
  let detected = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let missed = 0;
  let rulesLearned = 0;
  let corrections = 0;
  const sites = new Set<string>();

  for (const experience of all) {
    sites.add(experience.domain);
    rulesLearned += experience.rulesGenerated.length;
    corrections += experience.userCorrections?.length ?? 0;
    for (const detection of experience.piiDetections) {
      detected++;
      if (detection.outcome === "true_positive") truePositives++;
      if (detection.outcome === "false_positive") falsePositives++;
      if (detection.outcome === "missed") missed++;
    }
  }

  // Recent window vs. the window before it; experiences are stored newest first.
  let improvementDelta = 0;
  if (totalRuns >= 4) {
    const window = Math.min(3, Math.floor(totalRuns / 2));
    const recent = all.slice(0, window);
    const earlier = all.slice(window, window * 2);
    if (recent.length > 0 && earlier.length > 0) {
      const score = (runs: Experience[]) =>
        runs.reduce((sum, e) => sum + (e.taskSuccess ? 1 : 0) + actionSuccessRate(e) * 0.5, 0) / runs.length;
      improvementDelta = (score(recent) - score(earlier)) / 1.5;
    }
  }

  return {
    totalRuns,
    successfulRuns,
    failedRuns: totalRuns - successfulRuns,
    totalPIIDetected: detected,
    totalPIIRedacted: truePositives,
    totalFalsePositives: falsePositives,
    totalMissedPII: missed,
    averageSuccessRate: successfulRuns / totalRuns,
    sitesVisited: sites.size,
    rulesLearned,
    improvementDelta,
    totalUserCorrections: corrections,
  };
}

export interface UserCorrection {
  experienceId?: string;
  kind: string;
  label: string;
  correction: string;
}

/** The user said a detection was wrong: flip it to a false positive. */
export async function recordUserCorrection(correction: UserCorrection): Promise<Experience | null> {
  const all = await loadAll();
  const experience = correction.experienceId ? all.find((e) => e.id === correction.experienceId) : all[0];
  if (!experience) return null;

  const match = experience.piiDetections.find((d) => d.kind === correction.kind && d.outcome === "true_positive");
  if (match) {
    match.outcome = "false_positive";
  } else {
    experience.piiDetections.push({ kind: correction.kind, method: "user", outcome: "false_positive", confidence: 0.9 });
  }
  experience.userCorrections = experience.userCorrections ?? [];
  experience.userCorrections.push(`user:${correction.correction}:${correction.kind}:${correction.label}`);
  await saveAll(all);
  return experience;
}

export async function clearExperienceMemory(): Promise<void> {
  await chrome.storage.local.remove(EXPERIENCE_KEY);
}
