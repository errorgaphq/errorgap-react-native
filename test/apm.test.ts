import { describe, it, expect } from "vitest";
import { Configuration } from "../src/configuration.js";
import {
  SpanCollector,
  databaseSpan,
  externalSpan,
  normalizeSql,
  transactionPayload,
} from "../src/apm.js";

describe("normalizeSql", () => {
  it("replaces string and numeric literals with placeholders", () => {
    expect(normalizeSql("SELECT * FROM orders WHERE id = 42 AND name = 'alice'")).toBe(
      "SELECT * FROM orders WHERE id = ? AND name = ?",
    );
  });

  it("collapses whitespace", () => {
    expect(normalizeSql("SELECT\n  1\n  FROM   t")).toBe("SELECT ? FROM t");
  });
});

describe("span builders", () => {
  it("builds a normalized db span", () => {
    const span = databaseSpan("SELECT * FROM t WHERE id = 7", 12.5, {
      file: "OrderRepo.ts",
      line: 20,
      function: "OrderRepo.load",
    });
    expect(span).toMatchObject({
      kind: "db",
      sql: "SELECT * FROM t WHERE id = ?",
      durationMs: 12.5,
      file: "OrderRepo.ts",
      line: 20,
      function: "OrderRepo.load",
    });
  });

  it("builds an external http span", () => {
    const span = externalSpan(88, { function: "PaymentGateway.charge" });
    expect(span.kind).toBe("http");
    expect(span.durationMs).toBe(88);
    expect(span.sql).toBeUndefined();
  });
});

describe("transactionPayload", () => {
  const cfg = new Configuration({
    endpoint: "https://e.example.com",
    projectSlug: "demo",
    environment: "production",
  });

  it("maps a web transaction with spans to the ingest shape", () => {
    const collector = new SpanCollector();
    collector.database("SELECT 1", 3, { function: "Repo.q" });
    collector.external(50, { function: "Api.call" });
    const payload = transactionPayload(
      {
        kind: "web",
        method: "POST",
        path: "/orders/{orderId}",
        pathRaw: "/orders/123",
        statusCode: 500,
        durationMs: 120,
        spans: collector.snapshot(),
      },
      cfg,
    );
    expect(payload).toMatchObject({
      kind: "web",
      method: "POST",
      path: "/orders/{orderId}",
      path_raw: "/orders/123",
      status_code: 500,
      duration_ms: 120,
      environment: "production",
    });
    const spans = payload.spans as Array<Record<string, unknown>>;
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ kind: "db", sql: "SELECT ?", fn_name: "Repo.q" });
    expect(spans[1]).toMatchObject({ kind: "http", fn_name: "Api.call" });
    expect(payload.occurred_at).toBeTypeOf("string");
  });

  it("maps a background job transaction", () => {
    const payload = transactionPayload(
      { kind: "job", jobClass: "ReceiptJob", queue: "mailers", durationMs: 40 },
      cfg,
    );
    expect(payload).toMatchObject({
      kind: "job",
      job_class: "ReceiptJob",
      queue: "mailers",
      duration_ms: 40,
    });
  });
});

describe("traced calls", () => {
  it("records the trace id it sends on the call's http span", async () => {
    const spans = new SpanCollector();
    let sent: Record<string, string> = {};
    const result = await spans.traceCall("GET /api/orders/7", async (headers) => {
      sent = headers;
      return "ok";
    });
    expect(result).toBe("ok");
    const [span] = spans.snapshot();
    expect(span!.kind).toBe("http");
    expect(span!.function).toBe("GET /api/orders/7");
    expect(span!.traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sent).toEqual({ "x-errorgap-trace": span!.traceId });
  });

  it("records the span when the call throws, once", async () => {
    const spans = new SpanCollector();
    await expect(spans.traceCall("POST /api/pay", () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    const call = spans.startCall("GET /api/menu");
    call.finish();
    call.finish();
    expect(spans.snapshot().map((s) => s.function)).toEqual(["POST /api/pay", "GET /api/menu"]);
  });

  it("sends trace_id in the transaction payload", () => {
    const spans = new SpanCollector();
    spans.startCall("GET /x").finish();
    const payload = transactionPayload({ durationMs: 1, spans: spans.snapshot() }, new Configuration({ projectSlug: "demo" }));
    const [span] = payload.spans as Array<Record<string, unknown>>;
    expect(span!.trace_id).toBe(spans.snapshot()[0]!.traceId);
    expect(span!.fn_name).toBe("GET /x");
  });
});
