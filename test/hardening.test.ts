import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "../src/client.js";
import { Configuration, type NoticeStorage } from "../src/configuration.js";
import { RateLimitedError } from "../src/delivery.js";

const originalFetch = globalThis.fetch;
let bodies: any[];
let respond: () => Response;

beforeEach(() => {
  bodies = [];
  respond = () => new Response('{"group_id":"g"}', { status: 201 });
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return respond();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(overrides: Record<string, unknown> = {}): Client {
  return new Client(
    new Configuration({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      logger: null,
      sourceMaps: false,
      ...overrides,
    }),
  );
}

function memoryStorage(): NoticeStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => void items.set(key, value),
    removeItem: async (key) => void items.delete(key),
  };
}

describe("notices", () => {
  it("mask nested keys, carry the user and survive unserializable params", async () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    await client({ filterKeys: ["password", /^ssn$/] }).notify(new Error("x"), {
      sync: true,
      user: { id: 7, email: "ada@example.com" },
      params: { users: [{ password: "p", ssn: "1" }], loop, big: 10n },
    });
    expect(bodies[0].params.users[0]).toEqual({ password: "[FILTERED]", ssn: "[FILTERED]" });
    expect(bodies[0].params.loop.self).toBe("[CIRCULAR]");
    expect(bodies[0].session).toEqual({ user_id: "7", user_email: "ada@example.com" });
  });

  it("can be dropped or changed by beforeNotify and are skipped in ignored environments", async () => {
    const dropped = await client({ beforeNotify: () => false }).notify(new Error("a"), { sync: true });
    expect(dropped.body).toBe("dropped by beforeNotify");
    await client({
      beforeNotify: (notice: any) => {
        notice.context.team = "billing";
      },
    }).notify(new Error("b"), { sync: true });
    await client({ environment: "test", ignoreEnvironments: ["test"] }).notify(new Error("c"), { sync: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].context.team).toBe("billing");
  });

  it("stop being sent after a 429 until Retry-After has passed", async () => {
    respond = () => new Response("{}", { status: 429, headers: { "retry-after": "120" } });
    const sdk = client();
    expect((await sdk.notify(new Error("one"), { sync: true })).status).toBe(429);
    expect((await sdk.notify(new Error("two"), { sync: true })).error).toBeInstanceOf(RateLimitedError);
    expect(bodies).toHaveLength(1);
  });
});

describe("fatal errors", () => {
  it("are kept until delivered, and sent on the next launch when the app died first", async () => {
    const storage = memoryStorage();
    // The request never completes: the app is gone.
    globalThis.fetch = (() => new Promise(() => undefined)) as unknown as typeof fetch;
    void client({ storage }).notify(new Error("fatal crash"), { isFatal: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(storage.items.size).toBe(1);

    // Next launch.
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    const result = await client({ storage }).sendStored();
    expect(result?.status).toBe(201);
    expect(bodies[0].errors[0].message).toBe("fatal crash");
    expect(storage.items.size).toBe(0);
  });

  it("are not kept once the server has them", async () => {
    const storage = memoryStorage();
    await client({ storage }).notify(new Error("fatal but delivered"), { isFatal: true, sync: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(storage.items.size).toBe(0);
  });
});
