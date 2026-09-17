import type { ToolDefinition } from "../providers/types";

const noParams = { type: "object", properties: {}, additionalProperties: false };

export const TOOLS: ToolDefinition[] = [
  {
    name: "read_page",
    description:
      "Re-read the current page and return a fresh list of elements with new ids. Element ids are only valid for the most recent read — call this after any navigation, or whenever an id you expected no longer resolves.",
    parameters: noParams,
  },
  {
    name: "click",
    description:
      "Click an element by its id from the most recent page read. Use this for links, buttons, checkboxes, tabs, and menu items.",
    parameters: {
      type: "object",
      properties: {
        element_id: { type: "number", description: "id from the latest page read" },
        reason: { type: "string", description: "One short phrase: why this click" },
      },
      required: ["element_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description:
      "Type text into a text field, replacing whatever is already there. Set submit to true to press Enter afterwards, which is usually how you run a search.",
    parameters: {
      type: "object",
      properties: {
        element_id: { type: "number" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter after typing" },
        reason: { type: "string" },
      },
      required: ["element_id", "text", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "select",
    description: "Choose an option in a <select> dropdown by its visible label or value.",
    parameters: {
      type: "object",
      properties: { element_id: { type: "number" }, option: { type: "string" }, reason: { type: "string" } },
      required: ["element_id", "option", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description:
      "Scroll the page. Elements marked offscreen in a page read are on the page but out of view — scroll toward them before clicking if a click misbehaves.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number", description: "Pixels; defaults to about one screen" },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "key",
    description: "Press a single key such as Enter, Escape, Tab, or ArrowDown.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "find_text",
    description:
      "Search the visible text of the page for a phrase. Cheaper than a full page read when you only need to confirm something is present.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "wait",
    description: "Pause for content to load. Use sparingly — most actions already wait.",
    parameters: {
      type: "object",
      properties: { ms: { type: "number", description: "Milliseconds, max 10000" } },
      required: ["ms"],
      additionalProperties: false,
    },
  },
  {
    name: "navigate",
    description: "Go to a URL in the current tab.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, reason: { type: "string" } },
      required: ["url", "reason"],
      additionalProperties: false,
    },
  },
  { name: "go_back", description: "Go back one entry in the tab's history.", parameters: noParams },
  {
    name: "open_tab",
    description: "Open a URL in a new tab and switch the agent's focus to it.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "list_tabs",
    description: "List the open tabs in this window with their ids, titles, and URLs.",
    parameters: noParams,
  },
  {
    name: "switch_tab",
    description: "Move the agent's focus to an existing tab by its id from list_tabs.",
    parameters: {
      type: "object",
      properties: { tab_id: { type: "number" } },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
  {
    name: "close_tab",
    description: "Close a tab the agent opened.",
    parameters: {
      type: "object",
      properties: { tab_id: { type: "number" } },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
];

/** Tools executed by the content script inside the page (the rest use chrome.tabs). */
export const IN_PAGE_TOOLS = new Set(["click", "type", "select", "scroll", "key", "find_text", "wait", "read_page"]);

/** One-line label for a step in the transcript. */
export function describeToolCall(name: string, input: Record<string, unknown>): string {
  const reason = typeof input.reason == "string" ? input.reason : "";
  switch (name) {
    case "click":
      return reason || `Click element ${input.element_id}`;
    case "type":
      return reason || `Type into element ${input.element_id}`;
    case "navigate":
      return `Go to ${input.url}`;
    case "open_tab":
      return `Open ${input.url} in a new tab`;
    case "read_page":
      return "Read the page";
    case "scroll":
      return `Scroll ${input.direction}`;
    case "find_text":
      return `Look for "${input.query}"`;
    default:
      return reason || name.replace(/_/g, " ");
  }
}
