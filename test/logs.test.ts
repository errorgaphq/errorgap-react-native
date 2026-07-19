import { describe, it, expect } from "vitest";
import { normalizeLogLevel, logLevelRank } from "../src/logs.js";

describe("normalizeLogLevel", () => {
  it("canonicalizes aliases", () => {
    expect(normalizeLogLevel("WARNING")).toBe("warn");
    expect(normalizeLogLevel("warn")).toBe("warn");
    expect(normalizeLogLevel("severe")).toBe("error");
    expect(normalizeLogLevel("finest")).toBe("debug");
  });

  it("passes through canonical levels and defaults unknowns to info", () => {
    expect(normalizeLogLevel("fatal")).toBe("fatal");
    expect(normalizeLogLevel("nonsense")).toBe("info");
  });
});

describe("logLevelRank", () => {
  it("orders severities", () => {
    expect(logLevelRank("trace")).toBeLessThan(logLevelRank("debug"));
    expect(logLevelRank("info")).toBeLessThan(logLevelRank("warn"));
    expect(logLevelRank("warn")).toBeLessThan(logLevelRank("error"));
    expect(logLevelRank("error")).toBeLessThan(logLevelRank("fatal"));
  });
});
