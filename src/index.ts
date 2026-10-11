import { Configuration, type ConfigurationInput } from "./configuration.js";
import { Client, type DeliveryResult, type LogOptions } from "./client.js";
import { installGlobalHandlers, uninstallGlobalHandlers } from "./handlers.js";
import { BreadcrumbBuffer, type BreadcrumbInput } from "./breadcrumbs.js";
import { SpanCollector, type Transaction } from "./apm.js";
import { ReplayRecorder, type ReplayOptions } from "./replay.js";
import type { NoticeContext } from "./notice.js";
import { VERSION } from "./version.js";
import {
  beginTransaction,
  currentTransactionId,
  endTransaction,
  newTransactionId,
} from "./transaction-context.js";

export type { ConfigurationInput, Logger } from "./configuration.js";
export type { NoticeContext, NoticePayload, NoticeCause } from "./notice.js";
export type { BacktraceFrame, SourceExcerpt } from "./backtrace.js";
export type { DeliveryResult, LogOptions } from "./client.js";
export type { Breadcrumb, BreadcrumbInput } from "./breadcrumbs.js";
export type { Span, SpanLocation, TracedCall, Transaction } from "./apm.js";
export type { ReplayOptions, AppStateLike, PlatformLike } from "./replay.js";
export { Configuration } from "./configuration.js";
export { Client } from "./client.js";
export {
  SpanCollector,
  databaseSpan,
  externalSpan,
  normalizeSql,
  TRACE_HEADER,
} from "./apm.js";
export { BreadcrumbBuffer } from "./breadcrumbs.js";
export { currentTransactionId, newTransactionId } from "./transaction-context.js";
export { VERSION };

let configuration = new Configuration();
let client = new Client(configuration);
let breadcrumbs = new BreadcrumbBuffer(configuration.maxBreadcrumbs);
let replay: ReplayRecorder | undefined;

export interface InitOptions extends ConfigurationInput {
  /** Install ErrorUtils.setGlobalHandler + unhandledRejection. Default true. */
  captureGlobals?: boolean;
  /**
   * Session replay (timeline only). On by default, but it records only what
   * the project's replay settings allow (Settings → Session replay). `false`
   * turns it off in this app whatever the settings say.
   */
  replay?: boolean | ReplayOptions;
}

function init(options: InitOptions = {}): void {
  const { captureGlobals = true, replay: replayOption = true, ...rest } = options;
  configuration = new Configuration(rest);
  client.configure(configuration);
  breadcrumbs = new BreadcrumbBuffer(configuration.maxBreadcrumbs);
  if (captureGlobals) {
    installGlobalHandlers(client, breadcrumbs);
  } else {
    uninstallGlobalHandlers();
  }
  replay?.stop();
  replay = undefined;
  client.observeErrors(undefined);
  if (replayOption) {
    try {
      configuration.validate();
      const recorder = new ReplayRecorder(configuration, replayOption === true ? {} : replayOption);
      replay = recorder;
      client.observeErrors((label) => recorder.errorStarted(label));
      recorder.start();
    } catch (error) {
      configuration.logger?.warn(
        `[errorgap] session replay not started: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Record the screen now showing in the session replay timeline. Call it from
 * your navigator, or use `errorgapNavigationListener` with React Navigation.
 */
function trackScreen(name: string): void {
  replay?.screen(name);
}

/**
 * For React Navigation: pass as both `onReady` and `onStateChange` of
 * `NavigationContainer`, with the container's ref, to record each screen.
 */
function errorgapNavigationListener(navigationRef: {
  getCurrentRoute?: () => { name?: string } | undefined;
}): () => void {
  return () => {
    const name = navigationRef.getCurrentRoute?.()?.name;
    if (name) trackScreen(name);
  };
}

function notify(
  error: unknown,
  options: NoticeContext & { sync?: boolean } = {},
): Promise<DeliveryResult> {
  return client.notify(error, {
    breadcrumbs: breadcrumbs.snapshot(),
    ...options,
  });
}

/** Record a diagnostic breadcrumb attached to subsequent notices. */
function addBreadcrumb(message: string, input: BreadcrumbInput = {}): void {
  breadcrumbs.add(message, input);
}

function clearBreadcrumbs(): void {
  breadcrumbs.clear();
}

/** Deliver a structured log line at the given level. */
function log(
  message: string,
  level = "info",
  options: LogOptions = {},
): Promise<DeliveryResult> {
  return client.notifyLog(message, level, options);
}

/** Deliver an APM transaction (web interaction or background job). */
function notifyTransaction(
  transaction: Transaction,
  options: { sync?: boolean } = {},
): Promise<DeliveryResult> {
  return client.notifyTransaction(transaction, options);
}

/**
 * Time an async web interaction and deliver it as a transaction. The callback
 * receives a `SpanCollector` for recording DB/HTTP spans.
 */
async function trackTransaction<T>(
  meta: Omit<Transaction, "durationMs" | "spans" | "kind"> & { kind?: string },
  operation: (spans: SpanCollector) => Promise<T> | T,
): Promise<T> {
  const id = meta.id ?? newTransactionId();
  const spans = new SpanCollector(id);
  const startedAt = new Date().toISOString();
  const start = Date.now();
  beginTransaction(id);
  try {
    return await operation(spans);
  } finally {
    endTransaction(id);
    void notifyTransaction({
      kind: meta.kind ?? "web",
      ...meta,
      id,
      occurredAt: meta.occurredAt ?? startedAt,
      durationMs: Date.now() - start,
      spans: spans.snapshot(),
    });
  }
}

/**
 * Time a background job and deliver it as a `job` transaction. The callback
 * receives a `SpanCollector` for recording DB/HTTP spans.
 */
async function trackJob<T>(
  jobClass: string,
  operation: (spans: SpanCollector) => Promise<T> | T,
  meta: { queue?: string; environment?: string } = {},
): Promise<T> {
  const id = newTransactionId();
  const spans = new SpanCollector(id);
  const startedAt = new Date().toISOString();
  const start = Date.now();
  beginTransaction(id);
  try {
    return await operation(spans);
  } finally {
    endTransaction(id);
    void notifyTransaction({
      id,
      kind: "job",
      jobClass,
      queue: meta.queue ?? "default",
      environment: meta.environment,
      occurredAt: startedAt,
      durationMs: Date.now() - start,
      spans: spans.snapshot(),
    });
  }
}

function flush(): Promise<void> {
  return client.flush();
}

function getConfiguration(): Configuration {
  return configuration;
}

function getClient(): Client {
  return client;
}

export const Errorgap = {
  init,
  notify,
  currentTransactionId,
  addBreadcrumb,
  clearBreadcrumbs,
  log,
  notifyTransaction,
  trackTransaction,
  trackJob,
  flush,
  trackScreen,
  errorgapNavigationListener,
  configuration: getConfiguration,
  client: getClient,
  VERSION,
};

export {
  init,
  notify,
  addBreadcrumb,
  clearBreadcrumbs,
  log,
  notifyTransaction,
  trackTransaction,
  trackJob,
  flush,
  trackScreen,
  errorgapNavigationListener,
};
