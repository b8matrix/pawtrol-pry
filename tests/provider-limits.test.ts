import { describe, expect, it } from "vitest";
import { parseDurationMs } from "../src/background/providers/types";

describe("parseDurationMs", () => {
  it("reads Groq and Retry-After formats", () => {
    expect(parseDurationMs("7")).toBe(7000);
    expect(parseDurationMs("6.225s")).toBe(6225);
    expect(parseDurationMs("577ms")).toBe(577);
    expect(parseDurationMs("1m30.5s")).toBe(90500);
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("soon")).toBeNull();
    expect(parseDurationMs(null)).toBeNull();
  });
});
