// Service worker entry: owns run state, the transcript mirror, confirmation
// prompts, the privacy audit feed, post-run learning, and the message router
// the side panel talks to.

import type { Settings, TranscriptEntry } from "../shared/types";
import { runAgent, type AgentEvent, type AuditRecord, type PriorExchange } from "./agent/loop";
import { clearSessions, deleteSession, getSessions, saveSession } from "./history";
import {
  clearExperienceMemory,
  getExperiencesForDomain,
  getMemoryStats,
  recordExperience,
  recordUserCorrection,
  updateExperienceOutcome,
  type Experience,
} from "./learning/experience-memory";
import { applyReflectionResults, clearLearnedRules, getLearnedRules, getRulesSummary } from "./learning/learned-rules";
import { addLessons, addTrajectory, generateLessons, getLessons, getTrajectories } from "./learning/lessons";
import { reflectOnExperience } from "./learning/reflection";
import { createEgressWatch, type TripwireAlert } from "./privacy/egress-watch";
import { getLedgerSummary, logRedaction } from "./privacy/ledger";
import { captureAndProcessScreenshot } from "./privacy/screenshot";
import { createPlanner } from "./providers";
import { loadSettings } from "./settings";

const MAX_PRIOR_EXCHANGES = 3;
const PRIOR_TASK_CHARS = 400;
const PRIOR_ANSWER_CHARS = 800;
const MAX_TRIPWIRE_ALERTS = 60;
const CONFIRM_TIMEOUT_MS = 120_000;
const MAX_AUDIT_RECORDS = 10;
const LAST_REFLECTION_KEY = "pry-last-reflection";

let transcript: TranscriptEntry[] = [];
let running = false;
let runController: AbortController | null = null;
let pendingExperience: Experience | null = null;
const priorExchanges: PriorExchange[] = [];
const egressWatch = createEgressWatch();
const tripwireAlerts: TripwireAlert[] = [];
let egressEntryShown = false;
const pendingConfirms = new Map<string, (approved: boolean) => void>();
let auditRecords: (AuditRecord & { timestamp: number })[] = [];
let runStartedAt = 0;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/** Mirror the event into the transcript (for get-state) and forward it to the panel. */
function emit(event: AgentEvent): void {
  if (event.kind === "entry") {
    transcript.push((event as { entry: TranscriptEntry }).entry);
  } else if (event.kind === "patch") {
    const patch = event as { id: string; text?: string; pending?: boolean };
    const entry = transcript.find((e) => e.id === patch.id);
    if (entry) {
      // Assistant narration streams as deltas; everything else is replaced.
      if (patch.text !== undefined) entry.text = entry.role === "assistant" ? entry.text + patch.text : patch.text;
      if (patch.pending !== undefined) entry.pending = patch.pending;
    }
  } else if (event.kind === "experience") {
    pendingExperience = (event as { experience: Experience }).experience;
  }
  chrome.runtime.sendMessage(event).catch(() => {});
}

function onTripwireAlert(alert: TripwireAlert): void {
  tripwireAlerts.unshift(alert);
  if (tripwireAlerts.length > MAX_TRIPWIRE_ALERTS) tripwireAlerts.length = MAX_TRIPWIRE_ALERTS;
  logRedaction(1, `tripwire_${alert.piiType || "egress"}`).catch(() => {});
  const summary = egressWatch.bump(alert);
  if (egressEntryShown) {
    emit({ kind: "patch", id: "egress-watch", text: summary });
  } else {
    egressEntryShown = true;
    emit({ kind: "entry", entry: { id: "egress-watch", role: "egress", text: summary } });
  }
  emit({ kind: "tripwire-update", alert });
}

function askConfirm(id: string, summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingConfirms.has(id)) return;
      pendingConfirms.delete(id);
      emit({
        kind: "entry",
        entry: {
          id: `confirm-timeout-${Date.now()}`,
          role: "system",
          text: "Approval request timed out after 120s and was treated as declined. Re-run and approve within the window if you want the action to proceed.",
        },
      });
      resolve(false);
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(id, (approved) => {
      clearTimeout(timer);
      resolve(approved);
    });
    emit({ kind: "confirm", id, summary });
  });
}

function declineAllConfirms(): void {
  for (const resolve of pendingConfirms.values()) resolve(false);
  pendingConfirms.clear();
}

function recordAudit(record: AuditRecord): void {
  // Keep the first capture plus the most recent ones.
  if (auditRecords.length >= MAX_AUDIT_RECORDS) {
    auditRecords = [auditRecords[0], ...auditRecords.slice(auditRecords.length - MAX_AUDIT_RECORDS + 2)];
  }
  auditRecords.push({ ...record, timestamp: Date.now() });
}

function emitPrivacyAudit(): void {
  const allDetections = [];
  const allTokens = [];
  let totalRedacted = 0;
  for (const record of auditRecords) {
    allDetections.push(...record.detections);
    allTokens.push(...record.tokens);
    totalRedacted += record.redactedCount;
  }
  const screenshots = auditRecords
    .filter((r) => r.original || r.redacted)
    .slice(-5)
    .map((r) => ({ original: r.original, redacted: r.redacted, timestamp: r.timestamp }));
  const verification = [...auditRecords].reverse().find((r) => r.verification)?.verification;
  emit({
    kind: "privacy-audit",
    audit: {
      screenshots,
      allDetections,
      allTokens,
      totalRedacted,
      totalScreenshots: auditRecords.length,
      totalPIIDetections: allDetections.length,
      durationMs: Date.now() - runStartedAt,
      verification,
    },
  });
}

async function buildLearningStats() {
  const [stats, rulesSummary, lessons, trajectories] = await Promise.all([
    getMemoryStats(),
    getRulesSummary(),
    getLessons(),
    getTrajectories(),
  ]);
  return {
    stats,
    rulesSummary,
    lessons: {
      total: lessons.length,
      recent: lessons
        .slice(0, 5)
        .map((l) => ({ domain: l.domain, pageType: l.pageType, text: l.text, createdAt: l.createdAt })),
    },
    trajectories: {
      total: trajectories.length,
      recent: trajectories
        .slice(0, 5)
        .map((t) => ({ domain: t.domain, pageType: t.pageType, task: t.task, steps: t.steps, createdAt: t.createdAt })),
    },
  };
}

async function emitLearningUpdate(reflection = ""): Promise<void> {
  try {
    if (reflection) await chrome.storage.local.set({ [LAST_REFLECTION_KEY]: reflection });
    const { stats, rulesSummary, lessons, trajectories } = await buildLearningStats();
    emit({
      kind: "learning-update",
      stats: {
        totalRuns: stats.totalRuns,
        successRate: Math.round(stats.averageSuccessRate * 100),
        piiDetected: stats.totalPIIDetected,
        piiRedacted: stats.totalPIIRedacted,
        falsePositives: stats.totalFalsePositives,
        missedPII: stats.totalMissedPII,
        sitesVisited: stats.sitesVisited,
        rulesLearned: stats.rulesLearned,
        improvementDelta: stats.improvementDelta,
        corrections: stats.totalUserCorrections,
        rulesSummary,
        lastReflection: reflection,
        lessons,
        trajectories,
      },
    });
  } catch (error) {
    console.warn("[PRY] Emitting learning stats failed:", error);
  }
}

/** After a run: store the experience, derive rules, and save a lesson or trajectory. */
async function learnFromRun(experience: Experience, settings: Settings): Promise<void> {
  try {
    await recordExperience(experience);
    const domainHistory = await getExperiencesForDomain(experience.domain);
    const visitsBefore = Math.max(0, domainHistory.length - 1);
    const rules = await getLearnedRules();
    const reflection = reflectOnExperience(
      experience,
      rules,
      visitsBefore,
      domainHistory.filter((e) => e.id !== experience.id),
    );
    if (reflection.newRules.length > 0) {
      await applyReflectionResults(reflection);
      console.log(`[PRY] Reflection: ${reflection.newRules.length} new rules generated.`);
    }
    await emitLearningUpdate(reflection.summary);

    try {
      if (experience.taskSuccess) {
        const steps = experience.actions
          .map((a) => `${a.tool}${a.success ? "" : "✗"}`)
          .slice(0, 8)
          .join(" → ");
        const answer = [...transcript].reverse().find((e) => e.role === "assistant")?.text ?? "";
        if (steps) {
          await addTrajectory({
            domain: experience.domain,
            pageType: experience.pageType,
            task: experience.task.slice(0, 200),
            steps,
            answer,
          });
        }
      } else {
        const lessons = await generateLessons(createPlanner(settings), experience);
        if (lessons.length > 0) {
          await addLessons(experience.domain, experience.pageType, lessons);
          const bytes = new Blob([JSON.stringify(lessons)]).size;
          emit({ kind: "egress", bytes: (experience.egressBytes ?? 0) + bytes });
          console.log(`[PRY] Reflection: ${lessons.length} lesson(s) generated.`);
        }
      }
    } catch (error) {
      console.warn("[PRY] Semantic learning failed:", error);
    }
  } catch (error) {
    console.warn("[PRY] Reflection failed:", error);
  }
}

async function startRun(task: string, tabId: number): Promise<void> {
  if (running) return;
  const settings = await loadSettings();
  running = true;
  runController = new AbortController();
  runStartedAt = Date.now();
  auditRecords = [];
  emit({ kind: "status", running: true });
  emit({ kind: "entry", entry: { id: `u-${Date.now()}`, role: "user", text: task } });

  try {
    await runAgent(task, tabId, {
      settings,
      emit,
      askConfirm,
      signal: runController.signal,
      captureScreenshot: captureAndProcessScreenshot,
      recordAudit,
      history: priorExchanges,
    });
  } catch (error) {
    emit({
      kind: "entry",
      entry: { id: `err-${Date.now()}`, role: "error", text: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    running = false;
    const stopped = runController?.signal.aborted === true;
    runController = null;

    const lastAssistant = transcript.filter((e) => e.role === "assistant").pop();
    const hadError = transcript.some((e) => e.role === "error");
    await saveSession({
      id: `session-${runStartedAt}`,
      task,
      startedAt: runStartedAt,
      completedAt: Date.now(),
      status: hadError ? "failed" : stopped ? "stopped" : "completed",
      transcript: [...transcript],
      summary: lastAssistant?.text?.slice(0, 200) ?? "Task completed",
      piiRedacted: auditRecords.reduce((sum, r) => sum + r.redactedCount, 0),
      durationMs: Date.now() - runStartedAt,
    });

    const answer = [...transcript].reverse().find((e) => e.role === "assistant");
    if (answer?.text) {
      priorExchanges.push({
        task: task.slice(0, PRIOR_TASK_CHARS),
        answer: answer.text.slice(0, PRIOR_ANSWER_CHARS),
        timestamp: Date.now(),
      });
      if (priorExchanges.length > MAX_PRIOR_EXCHANGES) priorExchanges.shift();
    }
    if (auditRecords.length > 0) emitPrivacyAudit();
    if (pendingExperience) {
      await learnFromRun(pendingExperience, settings);
      pendingExperience = null;
    }
    declineAllConfirms();
    emit({ kind: "status", running: false });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "TRIPWIRE_ALERT") {
    const detail = message.detail;
    if (detail) {
      onTripwireAlert({
        url: String(detail.url ?? ""),
        method: String(detail.method ?? "REQUEST"),
        piiType: String(detail.piiType ?? "pii"),
        sample: String(detail.sample ?? ""),
        timestamp: Number(detail.timestamp) || Date.now(),
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  switch (message.kind) {
    case "run":
      startRun(message.task, message.tabId);
      sendResponse({ ok: true });
      return false;

    case "stop":
      runController?.abort();
      declineAllConfirms();
      running = false;
      emit({ kind: "status", running: false });
      emit({ kind: "entry", entry: { id: `s-${Date.now()}`, role: "system", text: "Stopped." } });
      sendResponse({ ok: true });
      return false;

    case "reset":
      runController?.abort();
      transcript = [];
      priorExchanges.length = 0;
      running = false;
      egressWatch.reset();
      tripwireAlerts.length = 0;
      egressEntryShown = false;
      sendResponse({ ok: true });
      return false;

    case "confirm-reply": {
      const resolve = pendingConfirms.get(message.id);
      pendingConfirms.delete(message.id);
      resolve?.(message.approved);
      sendResponse({ ok: true });
      return false;
    }

    case "get-state":
      sendResponse({ transcript, running });
      return false;

    case "get-history":
      getSessions().then((sessions) => sendResponse({ sessions }));
      return true;

    case "delete-history":
      if (message.clearAll) clearSessions().then(() => sendResponse({ ok: true }));
      else if (message.sessionId) deleteSession(message.sessionId).then(() => sendResponse({ ok: true }));
      return true;

    case "get-learning-stats":
      (async () => {
        const { stats, rulesSummary, lessons, trajectories } = await buildLearningStats();
        const { [LAST_REFLECTION_KEY]: lastReflection } = await chrome.storage.local.get(LAST_REFLECTION_KEY);
        sendResponse({ stats, rulesSummary, lastReflection: lastReflection ?? "", lessons, trajectories });
      })();
      return true;

    case "record-correction":
      (async () => {
        const experience = await recordUserCorrection({
          experienceId: message.experienceId,
          kind: message.piiKind,
          label: message.label,
          correction: message.correction,
        });
        if (!experience) {
          sendResponse({ ok: false, reason: "No matching run found to correct." });
          return;
        }
        const reflection = reflectOnExperience(experience, await getLearnedRules());
        if (reflection.newRules.length > 0) await applyReflectionResults(reflection);
        await emitLearningUpdate(reflection.summary);
        sendResponse({ ok: true, experienceId: experience.id, rulesGenerated: reflection.newRules.length });
      })();
      return true;

    case "clear-learning":
      (async () => {
        await clearExperienceMemory();
        await clearLearnedRules();
        await chrome.storage.local.remove(LAST_REFLECTION_KEY);
        sendResponse({ ok: true });
      })();
      return true;

    case "get-ledger":
      getLedgerSummary().then((ledgerSummary) => sendResponse({ ledgerSummary }));
      return true;

    case "record-outcome":
      (async () => {
        const updated = await updateExperienceOutcome(message.experienceId, message.helpful);
        if (updated && pendingExperience && pendingExperience.id === message.experienceId && !message.helpful) {
          pendingExperience.taskSuccess = false;
        }
        if (updated && !message.helpful) {
          emit({
            kind: "entry",
            entry: {
              id: `fb-${Date.now()}`,
              role: "system",
              text: "Feedback noted: this run did not satisfy you — recorded as a failure so the learning loop won't trust its rules.",
            },
          });
        }
        sendResponse({ ok: updated });
      })();
      return true;

    case "get-tripwire-log":
      sendResponse({ alerts: tripwireAlerts, summary: egressWatch.summary() });
      return false;

    default:
      return false;
  }
});

export { captureAndProcessScreenshot };
