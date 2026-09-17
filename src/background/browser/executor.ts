// Runs a (token-resolved) tool call. In-page tools go to the content script;
// navigation and tab tools use chrome.tabs. Tab tools can move the agent's
// focus, so the (possibly new) controller is returned with the result.

import type { ActionResult, ToolAction } from "../../shared/types";
import { IN_PAGE_TOOLS } from "../agent/tools";
import { resolveSiteShortcut } from "../agent/deterministic";
import { TabController } from "./tab-controller";

export interface ExecutionOutcome {
  result: ActionResult;
  controller: TabController;
}

/** Pages Chrome does not let extensions script. */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://") ||
    url.startsWith("https://chromewebstore.google.com")
  );
}

/** Turn model-supplied URLs (or bare words) into something navigable. */
export function normalizeNavigationUrl(input: string): string {
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      const host = url.hostname.toLowerCase();
      if (!host.includes(".") && host !== "localhost" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        const shortcut = resolveSiteShortcut(host);
        if (!shortcut) return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
        url.hostname = shortcut;
        return url.toString();
      }
    } catch {}
    return input;
  }
  if (/^[\w-]+(\.[\w-]+)+/.test(input)) {
    const shortcut = resolveSiteShortcut(input.replace(/^www\./i, ""));
    return shortcut ? `https://${shortcut}` : `https://${input}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

/** The error code from a chrome-error:// page, if the tab landed on one. */
export function browserErrorOf(url: string | undefined): string | undefined {
  if (!url || !url.startsWith("chrome-error://")) return undefined;
  const match = url.match(/[?&]error=([^&#]+)/i);
  return match ? decodeURIComponent(match[1]) : "browser error page";
}

const fail = (detail: string, controller: TabController): ExecutionOutcome => ({ result: { ok: false, detail }, controller });
const succeed = (detail: string, controller: TabController): ExecutionOutcome => ({ result: { ok: true, detail }, controller });

export async function executeAction(controller: TabController, action: ToolAction): Promise<ExecutionOutcome> {
  const { name, input } = action;

  if (IN_PAGE_TOOLS.has(name)) {
    const tab = await chrome.tabs.get(controller.tabId).catch(() => null);
    if (isRestrictedUrl(tab?.url)) {
      return fail(
        `This tab (${tab?.url ?? "unknown"}) is a browser-internal page that extensions cannot read. Navigate somewhere else first.`,
        controller,
      );
    }
    return { result: await controller.act(action), controller };
  }

  switch (name) {
    case "navigate": {
      const url = normalizeNavigationUrl(String(input.url ?? ""));
      await chrome.tabs.update(controller.tabId, { url });
      await controller.waitForLoad();
      const tab = await chrome.tabs.get(controller.tabId).catch(() => null);
      const error = browserErrorOf(tab?.url);
      if (error) {
        return fail(
          `Navigation failed — ${error} (${tab?.url ?? url}). The page never loaded; the URL may be malformed. Re-navigate with a corrected URL.`,
          controller,
        );
      }
      return succeed(`Navigated to ${url}.`, controller);
    }

    case "go_back": {
      await chrome.tabs.goBack(controller.tabId).catch(() => {});
      await controller.waitForLoad();
      const tab = await chrome.tabs.get(controller.tabId);
      const error = browserErrorOf(tab?.url);
      if (error) return fail(`Went back, but the page failed to load — ${error}.`, controller);
      return succeed(`Went back. Now on ${tab.url}.`, controller);
    }

    case "open_tab": {
      const url = normalizeNavigationUrl(String(input.url ?? ""));
      const created = await chrome.tabs.create({ url, active: true });
      const next = new TabController(created.id!);
      await next.waitForLoad();
      const tab = await chrome.tabs.get(created.id!).catch(() => null);
      const error = browserErrorOf(tab?.url);
      if (error) {
        return fail(
          `Opened ${url} in tab ${created.id}, but the page failed to load — ${error}. The URL may be malformed; re-navigate with a corrected URL.`,
          next,
        );
      }
      return succeed(`Opened ${url} in new tab ${created.id}. Agent focus moved there.`, next);
    }

    case "list_tabs": {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const lines = tabs.map(
        (tab) => `- id ${tab.id}${tab.id === controller.tabId ? " (current)" : ""}: ${tab.title} — ${tab.url}`,
      );
      return succeed(lines.join("\n"), controller);
    }

    case "switch_tab": {
      const tabId = Number(input.tab_id);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return fail(`No tab ${tabId}.`, controller);
      await chrome.tabs.update(tabId, { active: true });
      const next = new TabController(tabId);
      await next.waitForLoad();
      return succeed(`Switched to tab ${tabId}: ${tab.title}.`, next);
    }

    case "close_tab": {
      const tabId = Number(input.tab_id);
      if (tabId === controller.tabId) return fail("Refusing to close the tab the agent is working in.", controller);
      await chrome.tabs.remove(tabId).catch(() => {});
      return succeed(`Closed tab ${tabId}.`, controller);
    }

    default:
      return fail(`Unknown tool ${name}.`, controller);
  }
}
