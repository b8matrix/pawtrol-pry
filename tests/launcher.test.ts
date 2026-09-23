import { describe, expect, it } from "vitest";
import { resolveDeterministically } from "../src/background/agent/deterministic";
import { launcherMessageFor } from "../src/background/launcher";
import type { TranscriptEntry } from "../src/shared/types";

const entry = (role: TranscriptEntry["role"], text: string): TranscriptEntry => ({ id: `${role}-${text}`, role, text });

describe("launcher messages", () => {
  it("mirrors steps and confirmations, not narration", () => {
    expect(launcherMessageFor({ kind: "entry", entry: entry("step", "Click element 4") }, [])).toEqual({
      kind: "launcher-update",
      running: true,
      tone: "step",
      text: "Click element 4",
    });
    expect(launcherMessageFor({ kind: "entry", entry: entry("assistant", "Clicking.") }, [])).toBeNull();
    expect(launcherMessageFor({ kind: "confirm", id: "e9", summary: "Submit the form" }, [])).toEqual({
      kind: "launcher-confirm",
      id: "e9",
      summary: "Submit the form",
    });
    expect(launcherMessageFor({ kind: "egress", bytes: 10 }, [])).toBeNull();
  });

  it("reports the outcome of the latest run only", () => {
    const transcript = [
      entry("user", "old task"),
      entry("assistant", "old answer"),
      entry("user", "new task"),
      entry("step", "Go to example.com"),
      entry("assistant", "The price is 20."),
      entry("system", "Token vault cleared"),
    ];
    expect(launcherMessageFor({ kind: "status", running: false }, transcript)).toMatchObject({
      running: false,
      tone: "answer",
      text: "The price is 20.",
    });
    expect(launcherMessageFor({ kind: "status", running: false }, [...transcript, entry("system", "Stopped.")])).toMatchObject({
      tone: "info",
      text: "Stopped.",
    });
    expect(launcherMessageFor({ kind: "status", running: false }, [entry("user", "t"), entry("error", "No API key")])).toMatchObject({
      tone: "error",
      text: "No API key",
    });
    expect(launcherMessageFor({ kind: "status", running: false }, [entry("user", "t")])).toMatchObject({ text: "Stopped." });
  });
});

describe("runs that start on a browser-internal page", () => {
  it("navigation commands resolve without a page snapshot", () => {
    expect(resolveDeterministically("open youtube", null)).toMatchObject({
      resolved: true,
      action: { name: "navigate", input: { url: "https://youtube.com" } },
    });
    expect(resolveDeterministically("go to github.com/Anthropics", null).action?.input.url).toBe("https://github.com/Anthropics");
    expect(resolveDeterministically("open youtube and play music", null).resolved).toBe(false);
    expect(resolveDeterministically("click Sign in", null).resolved).toBe(false);
  });
});
