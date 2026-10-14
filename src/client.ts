import type { Configuration } from "./configuration.js";
import { RemoteSettings, type RemoteKind } from "./remote-settings.js";
import { buildNotice, type NoticeContext, type NoticePayload } from "./notice.js";
import { enrichBacktrace } from "./source-maps.js";
import { transactionPayload, type Transaction } from "./apm.js";
import { logLevelRank, normalizeLogLevel } from "./logs.js";
import { VERSION } from "./version.js";
import { currentTransactionId } from "./transaction-context.js";

import { Delivery, type DeliveryResult } from "./delivery.js";

export type { DeliveryResult } from "./delivery.js";

export interface LogOptions {
  source?: string;
  environment?: string;
  occurredAt?: string;
  sync?: boolean;
}

/** Told when an error is reported; returns what to call with its group id. */
export type ErrorObserver = (label: string) => (groupId?: string) => void;

const STORED_FATAL_KEY = "errorgap:pending-fatal-notice";

/** Which of the project's switches covers each kind of payload. */
const REMOTE_KINDS: Record<string, RemoteKind | undefined> = {
  notices: "errors",
  transactions: "apm",
  logs: "logs",
};

export class Client {
  private pending = new Set<Promise<unknown>>();
  /** What errorgap wants this app to send (the project's remote settings). */
  readonly remote = new RemoteSettings(() => this.configuration);
  private delivery = new Delivery(() => ({
    endpoint: this.configuration.endpoint,
    projectSlug: this.configuration.projectSlug,
    apiKey: this.configuration.apiKey,
    timeout: this.configuration.timeout,
    queueSize: this.configuration.queueSize,
    userAgent: `errorgap-react-native/${VERSION}`,
    warn: (message) => this.configuration.logger?.warn(message),
  }));
  private errorObserver: ErrorObserver | undefined;

  constructor(private configuration: Configuration) {}

  /** Session replay records each reported error, linked to its group. */
  observeErrors(observer: ErrorObserver | undefined): void {
    this.errorObserver = observer;
  }

  configure(configuration: Configuration): void {
    this.configuration = configuration;
  }

  async notify(
    error: unknown,
    options: NoticeContext & { sync?: boolean } = {},
  ): Promise<DeliveryResult> {
    // Tracked from the first moment, so `flush()` right after `notify()`
    // waits for the notice even while it is still being prepared.
    const operation = this.process(error, options);
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
    if (options.sync || !this.configuration.async) return operation;

    const early = await Promise.race([operation, Promise.resolve(undefined)]);
    return early ?? { queued: true, status: 202 };
  }

  private async process(error: unknown, options: NoticeContext): Promise<DeliveryResult> {
    try {
      this.configuration.validate();
      const err = coerceError(error);
      if (this.configuration.ignoredEnvironment()) return { status: 202, body: "ignored environment" };
      if (!this.remote.enabled("errors")) {
        return { status: 202, body: "errors are switched off for this project" };
      }
      const built = buildNotice(err, this.configuration, withTransaction(options));
      // A fatal error usually ends the app before the request finishes, so
      // the notice is kept (before anything asynchronous happens) until the
      // server has it.
      const fatal = options.isFatal === true;
      if (fatal) this.store(built);
      const notice = await this.runHook(built);
      if (!notice) {
        if (fatal) this.clearStored();
        return { status: 202, body: "dropped by beforeNotify" };
      }
      if (fatal && notice !== built) this.store(notice);
      const observed = this.observe(`${notice.errors[0]?.type ?? "Error"}: ${err.message}`);
      const result = await this.prepareAndDeliverNotice(notice);
      observed(groupIdOf(result));
      if (fatal && result.status !== undefined && result.status < 500) this.clearStored();
      return result;
    } catch (exception) {
      this.log(exception);
      return { error: exception };
    }
  }

  /** Deliver an APM transaction (web interaction or background job). */
  async notifyTransaction(
    transaction: Transaction,
    options: { sync?: boolean } = {},
  ): Promise<DeliveryResult> {
    try {
      this.configuration.validate();
    } catch (exception) {
      this.log(exception);
      return { error: exception };
    }
    if (!this.configuration.apmEnabled) {
      return { status: 204 };
    }
    const rate = this.configuration.apmSampleRate;
    if (!(rate >= 1 || (rate > 0 && Math.random() < rate))) {
      return { status: 204 };
    }
    const payload = transactionPayload(transaction, this.configuration);
    return this.submit("transactions", payload, options.sync);
  }

  /** Deliver a structured log line. */
  async notifyLog(
    message: string,
    level = "info",
    options: LogOptions = {},
  ): Promise<DeliveryResult> {
    try {
      this.configuration.validate();
    } catch (exception) {
      this.log(exception);
      return { error: exception };
    }
    const normalizedLevel = normalizeLogLevel(level);
    if (
      !this.configuration.logsEnabled ||
      logLevelRank(normalizedLevel) <
        logLevelRank(normalizeLogLevel(this.configuration.minimumLogLevel))
    ) {
      return { status: 204 };
    }
    const payload: Record<string, unknown> = {
      message,
      level: normalizedLevel,
      environment: options.environment ?? this.configuration.environment,
      occurred_at: options.occurredAt ?? new Date().toISOString(),
    };
    if (options.source) payload.source = options.source;
    return this.submit("logs", payload, options.sync);
  }

  private observe(label: string): (groupId?: string) => void {
    try {
      return this.errorObserver?.(label) ?? (() => undefined);
    } catch {
      return () => undefined;
    }
  }

  private async prepareAndDeliverNotice(notice: NoticePayload): Promise<DeliveryResult> {
    if (this.configuration.sourceMaps) {
      try {
        for (const error of notice.errors) {
          error.backtrace = await enrichBacktrace(error.backtrace);
        }
      } catch {
        // Source-map enrichment is best-effort; deliver the raw frames.
      }
    }
    return this.deliver("notices", notice);
  }

  private async submit(
    resource: string,
    payload: unknown,
    sync?: boolean,
  ): Promise<DeliveryResult> {
    if (this.configuration.ignoredEnvironment()) return { status: 204 };
    const kind = REMOTE_KINDS[resource];
    if (kind && !this.remote.enabled(kind)) return { status: 204 };
    if (sync || !this.configuration.async) return await this.delivery.send(resource, payload);
    return this.delivery.enqueue(resource, payload);
  }

  deliver(resource: string, payload: unknown): Promise<DeliveryResult> {
    return this.delivery.send(resource, payload);
  }

  /** Await everything queued or being sent. Use during graceful shutdown. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(Array.from(this.pending).map((p) => p.catch(() => undefined)));
    }
    await this.delivery.flush();
  }

  /**
   * Send the fatal error the previous launch could not deliver, if there is
   * one. Called from `init`; needs `storage`.
   */
  async sendStored(): Promise<DeliveryResult | undefined> {
    const storage = this.configuration.storage;
    if (!storage) return undefined;
    try {
      const stored = await storage.getItem(STORED_FATAL_KEY);
      if (!stored) return undefined;
      const result = await this.delivery.send("notices", JSON.parse(stored));
      // Kept only while the server could not be reached.
      if (result.status !== undefined && result.status < 500) await storage.removeItem(STORED_FATAL_KEY);
      return result;
    } catch (exception) {
      this.log(exception);
      return { error: exception };
    }
  }

  private store(notice: NoticePayload): void {
    try {
      void this.configuration.storage
        ?.setItem(STORED_FATAL_KEY, JSON.stringify(notice))
        .catch(() => undefined);
    } catch {
      // Storage is best-effort.
    }
  }

  private clearStored(): void {
    try {
      void this.configuration.storage?.removeItem(STORED_FATAL_KEY).catch(() => undefined);
    } catch {
      // Storage is best-effort.
    }
  }

  /**
   * A hook that throws is logged and skipped: a bug in a filter must not
   * lose the error it was filtering.
   */
  private async runHook(notice: NoticePayload): Promise<NoticePayload | null> {
    const hook = this.configuration.beforeNotify;
    if (!hook) return notice;
    try {
      const result = await hook(notice);
      if (result === false || result === null) return null;
      return result && typeof result === "object" && Array.isArray(result.errors) ? result : notice;
    } catch (exception) {
      this.log(exception);
      return notice;
    }
  }

  private log(exception: unknown): void {
    const logger = this.configuration.logger;
    if (!logger) return;
    const message =
      exception instanceof Error
        ? `${exception.name}: ${exception.message}`
        : String(exception);
    logger.warn(`[errorgap] ${message}`);
  }
}

function coerceError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  if (error && typeof error === "object") {
    const obj = error as { message?: unknown; name?: unknown };
    const err = new Error(
      typeof obj.message === "string" ? obj.message : JSON.stringify(error),
    );
    if (typeof obj.name === "string") err.name = obj.name;
    return err;
  }
  return new Error(String(error));
}

/**
 * The transaction this error was raised in (when that is unambiguous), unless
 * the caller set one, so errorgap links the two.
 */
function withTransaction<T extends NoticeContext>(options: T): T {
  const id = currentTransactionId();
  if (!id || (options.context && "transaction_id" in options.context)) return options;
  return { ...options, context: { ...(options.context ?? {}), transaction_id: id } };
}

function groupIdOf(result: DeliveryResult): string | undefined {
  if (!result.body) return undefined;
  try {
    const parsed = JSON.parse(result.body) as { group_id?: unknown };
    return typeof parsed.group_id === "string" ? parsed.group_id : undefined;
  } catch {
    return undefined;
  }
}
