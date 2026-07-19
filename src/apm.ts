import type { Configuration } from "./configuration.js";

export interface Span {
  kind: string;
  sql?: string;
  file?: string;
  line?: number;
  function?: string;
  durationMs: number;
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

  add(span: Span): void {
    this.spans.push(span);
  }

  database(sql: string, durationMs: number, location: SpanLocation = {}): void {
    this.add(databaseSpan(sql, durationMs, location));
  }

  external(durationMs: number, location: SpanLocation = {}): void {
    this.add(externalSpan(durationMs, location));
  }

  snapshot(): Span[] {
    return [...this.spans];
  }
}

export interface Transaction {
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
