import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichBacktrace } from "../src/source-maps.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("source-map backtraces", () => {
  it("maps a Metro bundle frame back to original source with an excerpt", async () => {
    const map = {
      version: 3,
      file: "index.bundle",
      sources: ["../src/CheckoutScreen.tsx"],
      sourcesContent: ["const ready = true;\nthrow new CheckoutFailure();\nrender();"],
      names: [],
      mappings: "AAAA;AACA;AACA",
    };
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith(".map")) {
        return new Response(JSON.stringify(map), { status: 200 });
      }
      return new Response(
        "bundle();\n//# sourceMappingURL=index.bundle.map",
        { status: 200 },
      );
    }) as typeof fetch;

    const [frame] = await enrichBacktrace([
      {
        file: "http://10.0.2.2:8081/index.bundle?platform=android",
        line: 2,
        column: 1,
        in_app: true,
        index: 0,
      },
    ]);

    expect(frame).toMatchObject({
      file: "src/CheckoutScreen.tsx",
      line: 2,
      column: 1,
      in_app: true,
      source: {
        start_line: 1,
        lines: ["const ready = true;", "throw new CheckoutFailure();", "render();"],
      },
    });
  });

  it("classifies mapped dependency frames as vendor code", async () => {
    const map = {
      version: 3,
      sources: ["../node_modules/react-native/Libraries/Core.js"],
      sourcesContent: ["export function render() {}"],
      names: [],
      mappings: "AAAA",
    };
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith(".map")) {
        return new Response(JSON.stringify(map), { status: 200 });
      }
      return new Response("vendor();\n//# sourceMappingURL=index.bundle.map", { status: 200 });
    }) as typeof fetch;

    const [frame] = await enrichBacktrace([
      { file: "http://10.0.2.2:8081/index.bundle", line: 1, column: 1, in_app: true, index: 0 },
    ]);

    expect(frame?.in_app).toBe(false);
    expect(frame?.file).toContain("node_modules/react-native");
  });

  it("leaves non-URL frames untouched", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const input = [
      { file: "InternalBytecode.js", line: 1, in_app: false, index: 0 },
      { file: "[native code]", in_app: false, index: 1 },
    ];
    const output = await enrichBacktrace(input);
    expect(output).toEqual(input);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the original frame when the map cannot be fetched", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as typeof fetch;
    const input = [
      { file: "http://10.0.2.2:8081/index.bundle", line: 3, column: 1, in_app: true, index: 0 },
    ];
    const frames = await enrichBacktrace(input);
    expect(frames[0]).toEqual(input[0]);
  });
});
