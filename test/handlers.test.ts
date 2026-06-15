import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Errorgap } from "../src/index.js";

interface CapturedRequest {
  body: Record<string, unknown>;
}

function installFakeFetch(): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    let body: unknown = init?.body;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { /* leave */ }
    }
    captured.push({ body: body as Record<string, unknown> });
    return new Response('{"group_id":"g_1"}', {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return captured;
}

describe("ErrorUtils integration", () => {
  let requests: CapturedRequest[];
  const originalFetch = globalThis.fetch;
  let installedHandler: ((error: Error, isFatal?: boolean) => void) | undefined;

  beforeEach(() => {
    requests = installFakeFetch();
    installedHandler = undefined;
    (globalThis as Record<string, unknown>).ErrorUtils = {
      setGlobalHandler: vi.fn((handler: (error: Error, isFatal?: boolean) => void) => {
        installedHandler = handler;
      }),
      getGlobalHandler: vi.fn(() => undefined),
    };
    Errorgap.init({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
      captureGlobals: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as Record<string, unknown>).ErrorUtils;
    Errorgap.init({ captureGlobals: false });
  });

  it("installs a global handler via ErrorUtils.setGlobalHandler", () => {
    expect(installedHandler).toBeDefined();
  });

  it("reports errors passed to the installed handler", async () => {
    installedHandler?.(new Error("from-rn"), true);
    await Errorgap.flush();
    expect(requests).toHaveLength(1);
    const body = requests[0]!.body;
    const errors = body.errors as Array<{ message: string }>;
    expect(errors[0]?.message).toBe("from-rn");
    expect((body.context as Record<string, unknown>).source).toBe("ErrorUtils.setGlobalHandler");
    expect((body.context as Record<string, unknown>).is_fatal).toBe(true);
  });
});
