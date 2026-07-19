import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Errorgap } from "../src/index.js";

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function installFakeFetch(): Captured[] {
  const captured: Captured[] = [];
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        /* leave */
      }
    }
    captured.push({ url: typeof input === "string" ? input : input.toString(), body });
    return new Response('{"group_id":"g_1"}', { status: 201 });
  }) as unknown as typeof fetch;
  return captured;
}

describe("Errorgap top-level API", () => {
  let requests: Captured[];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    requests = installFakeFetch();
    Errorgap.init({
      endpoint: "https://errorgap.example.com",
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
      captureGlobals: false,
      sourceMaps: false,
    });
    Errorgap.clearBreadcrumbs();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("attaches recorded breadcrumbs to notices", async () => {
    Errorgap.addBreadcrumb("opened Cart", { category: "navigation" });
    Errorgap.addBreadcrumb("tapped Checkout", { category: "ui" });
    await Errorgap.notify(new Error("checkout failed"), { sync: true });
    const notice = requests.find((r) => r.url.endsWith("/notices"))!;
    const crumbs = (notice.body.context as Record<string, unknown>).breadcrumbs as Array<{
      message: string;
    }>;
    expect(crumbs.map((c) => c.message)).toEqual(["opened Cart", "tapped Checkout"]);
  });

  it("trackTransaction times an operation and records its spans", async () => {
    await Errorgap.trackTransaction(
      { method: "GET", path: "/orders/{orderId}", pathRaw: "/orders/7" },
      async (spans) => {
        spans.database("SELECT * FROM orders WHERE id = 7", 4, { function: "Repo.load" });
        spans.external(30, { function: "Gateway.fetch" });
      },
    );
    await Errorgap.flush();
    const txn = requests.find((r) => r.url.endsWith("/transactions"))!;
    expect(txn.body).toMatchObject({ kind: "web", path: "/orders/{orderId}", path_raw: "/orders/7" });
    expect(txn.body.duration_ms).toBeTypeOf("number");
    expect((txn.body.spans as unknown[]).length).toBe(2);
  });

  it("trackJob delivers a background job transaction", async () => {
    await Errorgap.trackJob("ReceiptJob", async (spans) => {
      spans.database("SELECT 1", 2);
    }, { queue: "mailers" });
    await Errorgap.flush();
    const txn = requests.find((r) => r.url.endsWith("/transactions"))!;
    expect(txn.body).toMatchObject({ kind: "job", job_class: "ReceiptJob", queue: "mailers" });
  });

  it("log delivers a structured log line", async () => {
    await Errorgap.log("payment captured", "info", { source: "payments" });
    await Errorgap.flush();
    const log = requests.find((r) => r.url.endsWith("/logs"))!;
    expect(log.body).toMatchObject({ message: "payment captured", level: "info", source: "payments" });
  });
});
