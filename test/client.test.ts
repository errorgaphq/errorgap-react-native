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

describe("Client logs and transactions", () => {
  let requests: CapturedRequest[];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    requests = installFakeFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function cfg(overrides: Record<string, unknown> = {}) {
    return new Configuration({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
      ...overrides,
    });
  }

  it("POSTs a structured log to /logs", async () => {
    const client = new Client(cfg());
    const result = await client.notifyLog("gateway timeout", "error", {
      source: "payments",
      sync: true,
    });
    expect(result.status).toBe(201);
    const req = requests[0]!;
    expect(req.url).toBe("https://errorgap.example.com/api/projects/demo/logs");
    expect(req.body).toMatchObject({ message: "gateway timeout", level: "error", source: "payments" });
  });

  it("drops logs below the minimum level without delivering", async () => {
    const client = new Client(cfg({ minimumLogLevel: "warn" }));
    const result = await client.notifyLog("chatty", "info", { sync: true });
    expect(result.status).toBe(204);
    expect(requests).toHaveLength(0);
  });

  it("POSTs an APM transaction to /transactions", async () => {
    const client = new Client(cfg());
    const result = await client.notifyTransaction(
      { kind: "web", method: "GET", path: "/orders/{id}", pathRaw: "/orders/1", durationMs: 10 },
      { sync: true },
    );
    expect(result.status).toBe(201);
    const req = requests[0]!;
    expect(req.url).toBe("https://errorgap.example.com/api/projects/demo/transactions");
    expect(req.body).toMatchObject({ kind: "web", path: "/orders/{id}", path_raw: "/orders/1", duration_ms: 10 });
  });

  it("skips transactions when APM is disabled", async () => {
    const client = new Client(cfg({ apmEnabled: false }));
    const result = await client.notifyTransaction({ durationMs: 5 }, { sync: true });
    expect(result.status).toBe(204);
    expect(requests).toHaveLength(0);
  });

  it("drops transactions when the sample rate is zero", async () => {
    const client = new Client(cfg({ apmSampleRate: 0 }));
    const result = await client.notifyTransaction({ durationMs: 5 }, { sync: true });
    expect(result.status).toBe(204);
    expect(requests).toHaveLength(0);
  });
});
