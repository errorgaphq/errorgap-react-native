import type { Configuration } from "./configuration.js";
import { buildNotice, type NoticeContext, type NoticePayload } from "./notice.js";
import { enrichBacktrace } from "./source-maps.js";
import { transactionPayload, type Transaction } from "./apm.js";
import { logLevelRank, normalizeLogLevel } from "./logs.js";
import { VERSION } from "./version.js";
import { currentTransactionId } from "./transaction-context.js";

export interface DeliveryResult {
  status?: number;
  body?: string;
  error?: unknown;
  queued?: boolean;
}

export interface LogOptions {
  source?: string;
  environment?: string;
  occurredAt?: string;
  sync?: boolean;
}

export class Client {
  private pending = new Set<Promise<unknown>>();

  constructor(private configuration: Configuration) {}

  configure(configuration: Configuration): void {
    this.configuration = configuration;
  }

  async notify(
    error: unknown,
    options: NoticeContext & { sync?: boolean } = {},
  ): Promise<DeliveryResult> {
    try {
      this.configuration.validate();
      const err = coerceError(error);
      const notice = buildNotice(err, this.configuration, withTransaction(options));

      if (options.sync || !this.configuration.async) {
        const p = this.prepareAndDeliverNotice(notice);
        this.track(p);
        return await p;
      }

      this.track(this.prepareAndDeliverNotice(notice));
      return { queued: true, status: 202 };
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
    payload: Record<string, unknown>,
    sync = false,
  ): Promise<DeliveryResult> {
    if (sync || !this.configuration.async) {
      const p = this.deliver(resource, payload);
      this.track(p);
      return await p;
    }
    this.track(this.deliver(resource, payload));
    return { queued: true, status: 202 };
  }

  async deliver(resource: string, payload: unknown): Promise<DeliveryResult> {
    const url = resourceUrl(this.configuration, resource);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": `errorgap-react-native/${VERSION}`,
    };
    if (this.configuration.apiKey) {
      headers["x-errorgap-project-key"] = this.configuration.apiKey;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const body = await safeBody(response);
      return { status: response.status, body };
    } catch (exception) {
      this.log(exception);
      return { error: exception };
    }
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(Array.from(this.pending));
    }
  }

  private track(promise: Promise<unknown>): void {
    const wrapped = promise.catch(() => undefined);
    this.pending.add(wrapped);
    void wrapped.finally(() => this.pending.delete(wrapped));
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

function resourceUrl(configuration: Configuration, resource: string): string {
  const base = configuration.endpoint.endsWith("/")
    ? configuration.endpoint.slice(0, -1)
    : configuration.endpoint;
  return `${base}/api/projects/${configuration.projectSlug}/${resource}`;
}

async function safeBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
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
