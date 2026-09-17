// Talks to the content script in one tab, re-injecting it when the page was
// loaded before the extension (or the script was torn down by navigation).

import type { ActionResult, PageSnapshot, ToolAction } from "../../shared/types";

const PAGE_RESPONSE_TIMEOUT_MS = 30_000;

export class TabController {
  constructor(readonly tabId: number) {}

  async send<T = any>(message: { kind: string; [key: string]: unknown }): Promise<T> {
    const kind = message.kind;
    const attempt = () =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `The page did not respond to ${kind} within ${Math.round(PAGE_RESPONSE_TIMEOUT_MS / 1000)}s — the tab may be busy or the content script stopped. Try the task again on a freshly loaded page.`,
              ),
            ),
          PAGE_RESPONSE_TIMEOUT_MS,
        );
        chrome.tabs.sendMessage(this.tabId, message).then(
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

    try {
      return await attempt();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const scriptMissing = /Receiving end does not exist|Could not establish connection|No tab with id/i.test(text);
      if (!scriptMissing || text.startsWith("The page did not respond")) throw error;
      await this.inject();
      return attempt();
    }
  }

  async inject(): Promise<void> {
    await chrome.scripting.executeScript({ target: { tabId: this.tabId }, files: ["content.js"] });
  }

  async waitForLoad(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(this.tabId).catch(() => null);
      if (!tab) return;
      if (tab.status === "complete") {
        await new Promise((r) => setTimeout(r, 400));
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async snapshot(): Promise<PageSnapshot | undefined> {
    const response = await this.send<{ snapshot?: PageSnapshot }>({ kind: "snapshot" }).catch(() => undefined);
    return response?.snapshot;
  }

  async act(action: ToolAction): Promise<ActionResult> {
    return this.send<ActionResult>({ kind: "act", action });
  }
}
