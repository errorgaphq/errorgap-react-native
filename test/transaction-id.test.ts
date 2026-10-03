import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Errorgap, currentTransactionId } from "../src/index.js";

interface Captured {
  url: string;
  body: Record<string, any>;
}

describe("transaction ids", () => {
  const originalFetch = globalThis.fetch;
  let requests: Captured[];

  beforeEach(() => {
    requests = [];
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    Errorgap.init({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "egp_test",
      async: false,
      captureGlobals: false,
      sourceMaps: false,
      apmEnabled: true,
      apmSampleRate: 1,
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("an error during the only running transaction carries its id", async () => {
    let id: string | undefined;
    await Errorgap.trackTransaction({ method: "GET", path: "/orders/{id}" }, async (spans) => {
      id = spans.transactionId;
      await Errorgap.notify(new Error("card declined"), { sync: true });
    });
    await Errorgap.notify(new Error("after"), { sync: true });
    await Errorgap.flush();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const transaction = requests.find((r) => r.url.endsWith("/transactions"))!;
    expect(transaction.body.id).toBe(id);
    const inside = requests.find((r) => r.body.errors?.[0]?.message === "card declined")!;
    const after = requests.find((r) => r.body.errors?.[0]?.message === "after")!;
    expect(inside.body.context.transaction_id).toBe(id);
    expect(after.body.context.transaction_id).toBeUndefined();
    expect(currentTransactionId()).toBeUndefined();
  });

  it("overlapping transactions attach no id rather than a wrong one; the explicit id still links", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = Errorgap.trackTransaction({ path: "/a" }, () => gate);
    let explicit: string | undefined;
    const second = Errorgap.trackTransaction({ path: "/b" }, async (spans) => {
      explicit = spans.transactionId;
      await Errorgap.notify(new Error("ambiguous"), { sync: true });
      await Errorgap.notify(new Error("linked"), { context: { transaction_id: spans.transactionId }, sync: true });
    });
    await second;
    release();
    await first;

    const ambiguous = requests.find((r) => r.body.errors?.[0]?.message === "ambiguous")!;
    const linked = requests.find((r) => r.body.errors?.[0]?.message === "linked")!;
    expect(ambiguous.body.context.transaction_id).toBeUndefined();
    expect(linked.body.context.transaction_id).toBe(explicit);
  });
});
