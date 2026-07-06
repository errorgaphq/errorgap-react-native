import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Configuration } from "../src/configuration.js";
import { Client } from "../src/client.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function installFakeFetch(): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | Headers | undefined;
    if (raw instanceof Headers) {
      raw.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else if (raw) {
      for (const [k, v] of Object.entries(raw)) {
        headers[k.toLowerCase()] = v;
      }
    }
    let body: unknown = init?.body;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { /* leave */ }
    }
    captured.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers,
      body,
    });
    return new Response('{"group_id":"g_1"}', {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return captured;
}

describe("Client", () => {
  let requests: CapturedRequest[];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    requests = installFakeFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /api/projects/:slug/notices with canonical headers", async () => {
    const cfg = new Configuration({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
    });
    const client = new Client(cfg);
    const result = await client.notify(new Error("boom"), { sync: true });
    expect(result.status).toBe(201);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://errorgap.example.com/api/projects/demo/notices");
    expect(req.headers["x-errorgap-project-key"]).toBe("flk_test");
    expect(req.headers["user-agent"]).toMatch(/^errorgap-react-native\//);
  });

  it("sends the notice envelope", async () => {
    const cfg = new Configuration({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
    });
    const client = new Client(cfg);
    await client.notify(new TypeError("kaboom"), { sync: true });
    const body = requests[0]!.body as Record<string, unknown>;
    expect(body).toHaveProperty("errors");
    expect(body).toHaveProperty("context");
  });

  it("returns error result when endpoint missing", async () => {
    const cfg = new Configuration({ projectSlug: "demo", logger: null });
    const client = new Client(cfg);
    const result = await client.notify(new Error("x"), { sync: true });
    expect(result.error).toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("async queues and flushes", async () => {
    const cfg = new Configuration({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      async: true,
    });
    const client = new Client(cfg);
    const result = await client.notify(new Error("x"));
    expect(result.queued).toBe(true);
    expect(result.status).toBe(202);
    await client.flush();
    expect(requests).toHaveLength(1);
  });
});
