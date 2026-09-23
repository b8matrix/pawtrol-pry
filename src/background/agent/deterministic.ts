// Zero-LLM fast path: simple one-shot commands ("click Sign in", "go to github",
// "scroll down") are resolved against the page snapshot without calling a model.

import type { PageSnapshot, ToolAction } from "../../shared/types";

const SITE_SHORTCUTS: Record<string, string> = {
  youtube: "youtube.com",
  google: "google.com",
  github: "github.com",
  twitter: "twitter.com",
  reddit: "reddit.com",
  facebook: "facebook.com",
  instagram: "instagram.com",
  linkedin: "linkedin.com",
  amazon: "amazon.com",
  netflix: "netflix.com",
  spotify: "spotify.com",
  wikipedia: "wikipedia.org",
  stackoverflow: "stackoverflow.com",
  gmail: "gmail.com",
  outlook: "outlook.com",
  yahoo: "yahoo.com",
  bing: "bing.com",
  discord: "discord.com",
  slack: "slack.com",
  notion: "notion.so",
  figma: "figma.com",
  linear: "linear.app",
  vercel: "vercel.com",
  netlify: "netlify.com",
};

/** "github" → "github.com"; anything that is not a bare known site name → null. */
export function resolveSiteShortcut(name: string): string | null {
  const key = name.trim().replace(/^www\./i, "").toLowerCase();
  return /^[\w-]+$/.test(key) ? (SITE_SHORTCUTS[key] ?? null) : null;
}

export interface DeterministicResult {
  resolved: boolean;
  action?: ToolAction;
  explanation?: string;
}

const UNRESOLVED: DeterministicResult = { resolved: false };

export function resolveDeterministically(task: string, snapshot: PageSnapshot | null): DeterministicResult {
  // Navigation needs no page: it works from browser-internal pages too.
  if (!snapshot) return resolveNavigation(task) ?? UNRESOLVED;
  const command = task.toLowerCase().trim();

  const click = command.match(/^(?:click|tap|press|hit|select)\s+(?:on\s+|the\s+)?["']?(.+?)["']?\s*$/i);
  if (click) {
    const target = click[1].toLowerCase().trim();
    if (target) {
      const element = snapshot.elements.find((el) => {
        const name = (el.name || "").toLowerCase().trim();
        const role = (el.role || "").toLowerCase().trim();
        return !!(
          (name && (name === target || name.includes(target) || (target.length >= 3 && target.includes(name)))) ||
          (role && (role === target || (target.length >= 4 && target.includes(role))))
        );
      });
      if (element) {
        return {
          resolved: true,
          action: { name: "click", input: { element_id: element.id, reason: `Deterministic: matched "${element.name}"` } },
          explanation: `Found element [${element.id}] "${element.name}" matching "${click[1]}"`,
        };
      }
    }
  }

  // Values come from the original-case task: the legacy planner lowercased the
  // typed text, which also turned "<CRED_1>" into an unresolvable "<cred_1>".
  const fill = task.trim().match(/^(?:fill|type|enter|input|write)\s+(.+?)\s+(?:with|into|in|:)\s+(.+)$/i);
  if (fill) {
    const field = fill[1].toLowerCase().trim();
    const text = fill[2].trim();
    if (field) {
      const element = snapshot.elements.find((el) => {
        const name = (el.name || "").toLowerCase().trim();
        const role = (el.role || "").toLowerCase().trim();
        if (!name) return false;
        return (
          (name === field || name.includes(field) || (field.length >= 3 && field.includes(name))) &&
          (role === "textbox" || role === "password" || role === "combobox")
        );
      });
      if (element) {
        return {
          resolved: true,
          action: {
            name: "type",
            input: {
              element_id: element.id,
              text,
              reason: `Deterministic: fill "${element.name}" with "${text.slice(0, 30)}"`,
            },
          },
          explanation: `Found field [${element.id}] "${element.name}" matching "${fill[1]}"`,
        };
      }
    }
  }

  const scroll = command.match(/^scroll\s+(down|up|top|bottom)$/i);
  if (scroll) {
    const where = scroll[1].toLowerCase();
    if (where === "top") {
      return {
        resolved: true,
        action: { name: "scroll", input: { direction: "up", amount: snapshot.scroll.y } },
        explanation: "Scrolled to top of page",
      };
    }
    if (where === "bottom") {
      return {
        resolved: true,
        action: { name: "scroll", input: { direction: "down", amount: snapshot.scroll.maxY - snapshot.scroll.y } },
        explanation: "Scrolled to bottom of page",
      };
    }
    return { resolved: true, action: { name: "scroll", input: { direction: where } }, explanation: `Scrolled ${where}` };
  }

  const navigation = resolveNavigation(task);
  if (navigation) return navigation;

  const key = command.match(/^(?:press|hit)\s+(enter|escape|tab|space|backspace|delete|arrowdown|arrowup|arrowleft|arrowright)$/i);
  if (key) return { resolved: true, action: { name: "key", input: { key: key[1] } }, explanation: `Press ${key[1]}` };
  return UNRESOLVED;
}

/** "go to / open / visit X". Null when the task is not a navigation command. */
function resolveNavigation(task: string): DeterministicResult | null {
  // Original case: URL paths and queries are case-sensitive.
  const go = task.trim().match(/^(?:go to|open|navigate to|visit)\s+(.+)$/i);
  if (go) {
    const destination = go[1].trim();
    // Compound tasks ("open youtube and search…") need the planner.
    if (
      /\b(and|then|after|before|next|search|find|click|type|fill|read|play|watch|submit|send|post)\b/.test(
        destination.toLowerCase(),
      )
    ) {
      return UNRESOLVED;
    }
    const looksLikeUrl = /^(https?:\/\/|www\.|[\w-]+\.[\w.-]+(?:\/\S*)?$)/.test(destination);
    const shortcut = resolveSiteShortcut(destination);
    if (!looksLikeUrl && !shortcut) return UNRESOLVED;

    let url: string;
    if (/^https?:\/\//.test(destination)) {
      try {
        const parsed = new URL(destination);
        const host = parsed.hostname.toLowerCase();
        const hostShortcut = !host.includes(".") && host !== "localhost" ? resolveSiteShortcut(host) : null;
        if (hostShortcut) parsed.hostname = hostShortcut;
        url = parsed.toString();
      } catch {
        url = destination;
      }
    } else {
      url = shortcut ? `https://${shortcut}` : `https://${destination}`;
    }
    return {
      resolved: true,
      action: { name: "navigate", input: { url, reason: `Deterministic: navigate to "${url.slice(0, 50)}"` } },
      explanation: `Navigate to ${url.slice(0, 50)}`,
    };
  }
  return null;
}
