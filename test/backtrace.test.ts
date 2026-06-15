import { describe, it, expect } from "vitest";
import { parseBacktrace } from "../src/backtrace.js";

describe("parseBacktrace", () => {
  it("returns empty array when stack missing", () => {
    const err = new Error("x");
    err.stack = undefined as unknown as string;
    expect(parseBacktrace(err)).toEqual([]);
  });

  it("parses V8-style frames", () => {
    const err = new Error("x");
    err.stack = [
      "Error: x",
      "    at handler (App.js:42:10)",
      "    at index.js:9:5",
    ].join("\n");
    const frames = parseBacktrace(err);
    expect(frames.length).toBe(2);
    expect(frames[0]?.function).toBe("handler");
    expect(frames[0]?.line).toBe(42);
  });

  it("parses Hermes-style frames", () => {
    const err = new Error("x");
    err.stack = [
      "handler@App.js:42:10",
      "render@/path/to/component.js:9:5",
    ].join("\n");
    const frames = parseBacktrace(err);
    expect(frames.length).toBe(2);
    expect(frames[0]?.function).toBe("handler");
    expect(frames[0]?.file).toBe("App.js");
  });

  it("marks node_modules frames as not in_app", () => {
    const err = new Error("x");
    err.stack = "at fn (/app/node_modules/react/index.js:1:1)";
    const frames = parseBacktrace(err);
    expect(frames[0]?.in_app).toBe(false);
  });
});
