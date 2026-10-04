import type { Configuration } from "./configuration.js";
import { newTransactionId } from "./transaction-context.js";

/** The header that links an API call to the server request answering it. */
export const TRACE_HEADER = "x-errorgap-trace";

export interface Span {
  kind: string;
  sql?: string;
  file?: string;
  line?: number;
  function?: string;
  durationMs: number;
  /**
   * For a traced `http` call: the id sent in its `x-errorgap-trace` header.
   * The server request that recorded the header links to it.
   */
  traceId?: string;
}

/** A traced outbound call in flight; see {@link SpanCollector.startCall}. */
export interface TracedCall {
  /** The id sent with the call. */
  readonly traceId: string;
  /** Headers to add to the request: `{ "x-errorgap-trace": traceId }`. */
  readonly headers: Record<string, string>;
  /** Record the call's span, timed from `startCall`. Idempotent. */
  finish(): void;
}

export interface SpanLocation {
  file?: string;
  line?: number;
  function?: string;
}

export function databaseSpan(
  sql: string,
  durationMs: number,
  location: SpanLocation = {},
): Span {
  return { kind: "db", sql: normalizeSql(sql), durationMs, ...location };
}

export function externalSpan(durationMs: number, location: SpanLocation = {}): Span {
  return { kind: "http", durationMs, ...location };
}

/** Collects spans recorded while a transaction or job is in flight. */
export class SpanCollector {
  private spans: Span[] = [];

  /**
   * The id of the transaction these spans belong to, for linking an error to
   * it explicitly: `notify(error, { context: { transaction_id: spans.transactionId } })`.
   */
  constructor(readonly transactionId?: string) {}

  add(span: Span): void {
    this.spans.push(span);
  }

  database(sql: string, durationMs: number, location: SpanLocation = {}): void {
    this.add(databaseSpan(sql, durationMs, location));
  }

  external(durationMs: number, location: SpanLocation = {}): void {
    this.add(externalSpan(durationMs, location));
  }

  /**
   * Start a traced API call. Send `call.headers` with the request and call
   * `call.finish()` when the response arrives: the `http` span records the
   * trace id, and a server SDK that records the header links the server
   * request to it.
   */
  startCall(label: string, location: SpanLocation = {}): TracedCall {
    const traceId = newTransactionId();
    const start = now();
    let finished = false;
    return {
      traceId,
      headers: { [TRACE_HEADER]: traceId },
      finish: () => {
        if (finished) return;
        finished = true;
        this.add({ ...externalSpan(now() - start, location), function: label, traceId });
      },
    };
  }

  /**
   * Time a traced API call: `fn` gets the headers to send and its result is
   * returned. The span is recorded even if `fn` throws.
   *
   * ```ts
   * const res = await spans.traceCall("GET /api/orders/7", (headers) =>
   *   fetch(`${API}/orders/7`, { headers }),
   * );
   * ```
   */
  async traceCall<T>(
    label: string,
    fn: (headers: Record<string, string>) => Promise<T> | T,
    location: SpanLocation = {},
  ): Promise<T> {
    const call = this.startCall(label, location);
    try {
      return await fn(call.headers);
    } finally {
      call.finish();
    }
  }

  snapshot(): Span[] {
    return [...this.spans];
  }
}

export interface Transaction {
  /** Links the errors raised during this transaction to it. */
  id?: string;
  /** "web" for screen/API interactions, "job" for background work. */
  kind?: string;
  method?: string;
  /** Normalized route template used for grouping, e.g. `/orders/{orderId}`. */
  path?: string;
  /** Concrete path for a single request, e.g. `/orders/123`. */
  pathRaw?: string;
  statusCode?: number;
  durationMs: number;
  environment?: string;
  /** ISO-8601. Defaults to now. */
  occurredAt?: string;
  spans?: Span[];
  jobClass?: string;
  queue?: string;
}

export function transactionPayload(
  transaction: Transaction,
  configuration: Configuration,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: transaction.kind ?? "web",
    duration_ms: transaction.durationMs,
    environment: transaction.environment ?? configuration.environment,
    occurred_at: transaction.occurredAt ?? new Date().toISOString(),
    spans: (transaction.spans ?? []).map(spanPayload),
  };
  if (transaction.id !== undefined) payload.id = transaction.id;
  if (transaction.method !== undefined) payload.method = transaction.method;
  if (transaction.path !== undefined) payload.path = transaction.path;
  if (transaction.pathRaw !== undefined) payload.path_raw = transaction.pathRaw;
  if (transaction.statusCode !== undefined) payload.status_code = transaction.statusCode;
  if (transaction.jobClass !== undefined) payload.job_class = transaction.jobClass;
  if (transaction.queue !== undefined) payload.queue = transaction.queue;
  return payload;
}

function spanPayload(span: Span): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: span.kind,
    duration_ms: span.durationMs,
  };
  if (span.sql !== undefined) payload.sql = span.sql;
  if (span.file !== undefined) payload.file = span.file;
  if (span.line !== undefined) payload.line = span.line;
  if (span.function !== undefined) payload.fn_name = span.function;
  if (span.traceId !== undefined) payload.trace_id = span.traceId;
  return payload;
}

/** Strip literals so query shapes aggregate: '…' and numbers become ?. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}
