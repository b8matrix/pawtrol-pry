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
import { gatePlanner, type EgressPayload } from "./privacy/egress-gate";
import { getLedgerSummary, logEgressBlock, logRedaction } from "./privacy/ledger";
import { captureAndProcessScreenshot } from "./privacy/screenshot";
import { isRestrictedUrl } from "./browser/executor";
import { launcherMessageFor, type LauncherMessage } from "./launcher";
import { createPlanner } from "./providers";
import { loadSettings } from "./settings";

const MAX_PRIOR_EXCHANGES = 3;
const PRIOR_TASK_CHARS = 400;
const PRIOR_ANSWER_CHARS = 800;
const MAX_TRIPWIRE_ALERTS = 60;
const CONFIRM_TIMEOUT_MS = 120_000;
const MAX_AUDIT_RECORDS = 10;
/** Outgoing requests kept for the "What the cloud saw" view (current run only). */
const MAX_EGRESS_PAYLOADS = 20;
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
let egressPayloads: EgressPayload[] = [];
let runStartedAt = 0;
let lastRunStats: unknown = null;
/** The tab whose in-page launcher mirrors the current run, and what it last showed. */
let launcherTabId: number | null = null;
/** The run was started from the page launcher, which then follows it across navigations. */
let launcherOwnsRun = false;
let launcherState: { update?: LauncherMessage; confirm?: LauncherMessage; collapsed?: boolean } = {};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/** Mirror the event into the transcript (for get-state) and forward it to the panel. */
function emit(event: AgentEvent): void {
  if (event.kind === "entry") {
    transcript.push((event as { entry: TranscriptEntry }).entry);
  } else if (event.kind === "patch") {
    const patch = event as { id: string; text?: string; pending?: boolean; redactedText?: string };
    const entry = transcript.find((e) => e.id === patch.id);
    if (entry) {
      // Assistant narration streams as deltas; everything else is replaced.
      if (patch.text !== undefined) entry.text = entry.role === "assistant" ? entry.text + patch.text : patch.text;
      if (patch.redactedText !== undefined) entry.redactedText = (entry.redactedText ?? "") + patch.redactedText;
      if (patch.pending !== undefined) entry.pending = patch.pending;
    }
  } else if (event.kind === "egress-payload") {
    egressPayloads.push(event.payload as EgressPayload);
    if (egressPayloads.length > MAX_EGRESS_PAYLOADS) egressPayloads.shift();
  } else if (event.kind === "run-stats") {
    lastRunStats = event.stats;
  } else if (event.kind === "experience") {
    pendingExperience = (event as { experience: Experience }).experience;
  }
  chrome.runtime.sendMessage(event).catch(() => {});
  notifyLauncher(launcherMessageFor(event, transcript));
}

function notifyLauncher(message: LauncherMessage | null): void {
  if (!message || launcherTabId === null) return;
  // A stopped run can still log a step while it unwinds; the launcher already shows it stopped.
  if (message.kind === "launcher-update" && message.running && !running) return;
  if (message.kind === "launcher-update") launcherState.update = message;
  else if (message.kind === "launcher-confirm") launcherState.confirm = message;
  else if (launcherState.confirm?.kind === "launcher-confirm" && launcherState.confirm.id === message.id) {
    launcherState.confirm = undefined;
  }
  chrome.tabs.sendMessage(launcherTabId, message).catch(() => {});
}

// Alt+Shift+P: open the page launcher, or the side panel where Chrome allows no
// content script (its own pages). No await before sidePanel.open: it needs the gesture.
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== "open-launcher" || !tab?.id) return;
  const tabId = tab.id;
  if (isRestrictedUrl(tab.url)) {
    chrome.sidePanel.open({ tabId }).catch(() => {});
    return;
  }
  chrome.tabs.sendMessage(tabId, { kind: "launcher-open" }).catch(() => chrome.sidePanel.open({ tabId }).catch(() => {}));
});

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
  if (record.timings) emit({ kind: "perf", timings: record.timings, backend: record.backend ?? "unknown" });
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
    .map((r) => ({
      original: r.original,
      redacted: r.redacted,
      timestamp: r.timestamp,
      // Per-shot facts for the screenshot inspector in ui-shell.js.
      redactedCount: r.redactedCount,
      labels: [...new Set(r.detections.map((d) => d.label || d.kind))],
      verified: r.verification ? r.verification.verified : null,
      regionsChecked: r.verification?.regionsChecked ?? 0,
      maskedBoxes: r.maskedBoxes ?? null,
    }));
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
        const last = [...transcript].reverse().find((e) => e.role === "assistant");
        const answer = last?.redactedText ?? last?.text ?? "";
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
        // Reflection is an outgoing request like any other: it goes through the
        // gate. The run's vault is already cleared, so there is nothing to swap back.
        const gated = gatePlanner(createPlanner(settings), {
          redact: (text) => text,
          isVerifiedImage: () => false,
          imagesAllowed: () => false,
          onBlock: (leaks) => logEgressBlock(leaks.map((leak) => leak.label)).catch(() => {}),
        });
        const lessons = await generateLessons(gated, experience);
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
  lastRunStats = null;
  const startedAt = runStartedAt;
  launcherTabId = tabId;
  launcherState = {};
  auditRecords = [];
  egressPayloads = [];
  emit({ kind: "status", running: true });
  emit({ kind: "entry", entry: { id: `u-${Date.now()}`, role: "user", text: task } });

  try {
    await runAgent(task, tabId, {
      settings,
      emit,
      askConfirm,
      signal: runController.signal,
      captureScreenshot: captureAndProcessScreenshot,
      recordAudit: (record) => {
        // Background captures can land after the run ended; drop them only if
        // a newer run has started, and republish the audit so the panel shows them.
        if (runStartedAt !== startedAt) return;
        recordAudit(record);
        if (!running) emitPrivacyAudit();
      },
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
    // Follow-ups go back to the model, so they use the tokenized wording.
    const answerForModel = answer?.redactedText ?? answer?.text;
    if (answerForModel) {
      priorExchanges.push({
        task: task.slice(0, PRIOR_TASK_CHARS),
        answer: answerForModel.slice(0, PRIOR_ANSWER_CHARS),
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    case "run": {
      // The side panel names the tab; the page launcher runs on its own tab.
      const tabId = message.tabId ?? sender.tab?.id;
      if (running || typeof tabId != "number") {
        sendResponse({ ok: false, reason: running ? "A task is already running." : "No tab to run on." });
        return false;
      }
      launcherOwnsRun = message.tabId === undefined;
      startRun(String(message.task ?? ""), tabId);
      sendResponse({ ok: true });
      return false;
    }

    case "launcher-collapsed":
      if (sender.tab?.id === launcherTabId) launcherState.collapsed = Boolean(message.collapsed);
      sendResponse({ ok: true });
      return false;

    case "launcher-state":
      // A launcher asking after a page load: the run may have navigated its tab.
      sendResponse(
        sender.tab?.id === launcherTabId ? { running, owned: launcherOwnsRun, ...launcherState } : { running: false },
      );
      return false;

    case "open-panel": {
      const tabId = sender.tab?.id;
      if (typeof tabId != "number") {
        sendResponse({ ok: false });
        return false;
      }
      chrome.sidePanel
        .open({ tabId })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    case "stop":
      runController?.abort();
      // Also cancel a page load the run started; aborting the loop does not.
      if (launcherTabId !== null) {
        chrome.scripting
          .executeScript({ target: { tabId: launcherTabId }, func: () => window.stop() })
          .catch(() => {});
      }
      declineAllConfirms();
      running = false;
      // Entry first, so the launcher's outcome for this status is "Stopped.".
      emit({ kind: "entry", entry: { id: `s-${Date.now()}`, role: "system", text: "Stopped." } });
      emit({ kind: "status", running: false });
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
      // Answered from the panel or the launcher: clear the prompt in both.
      notifyLauncher({ kind: "launcher-confirm-done", id: String(message.id) });
      chrome.runtime.sendMessage({ kind: "confirm-resolved", id: message.id }).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }

    case "get-state":
      sendResponse({ transcript, running, lastRunStats });
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

    case "get-egress-payloads":
      sendResponse({ payloads: egressPayloads });
      return false;

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
