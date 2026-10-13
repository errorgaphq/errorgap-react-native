import type { Configuration } from "./configuration.js";
import { parseBacktrace, type BacktraceFrame } from "./backtrace.js";
import type { Breadcrumb } from "./breadcrumbs.js";
import { cleanRecord, filterParams, truncateString } from "./filter.js";
import { VERSION } from "./version.js";

const MAX_CAUSE_DEPTH = 10;

/** Who the request or job was acting for; sent as `session.user_id` / `session.user_email`. */
export interface NoticeUser {
  id?: string | number;
  email?: string;
}

const MAX_MESSAGE_LENGTH = 8192;

export interface NoticeContext {
  user?: NoticeUser | null;
  context?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  session?: Record<string, unknown>;
  params?: Record<string, unknown>;
  isFatal?: boolean;
  breadcrumbs?: Breadcrumb[];
}

export interface NoticeCause {
  type: string;
  message: string;
}

export interface NoticePayload {
  project_id?: string;
  received_at: string;
  errors: Array<{
    type: string;
    message: string;
    backtrace: BacktraceFrame[];
  }>;
  context: Record<string, unknown>;
  environment: Record<string, unknown>;
  session: Record<string, unknown>;
  params: Record<string, unknown>;
}

export function buildNotice(
  error: Error,
  configuration: Configuration,
  options: NoticeContext = {},
): NoticePayload {
  const causes = collectCauses(error);
  const backtrace = flattenBacktrace(error);
  const breadcrumbs = options.breadcrumbs ?? [];

  return {
    project_id: configuration.projectId,
    received_at: new Date().toISOString(),
    errors: [
      {
        type: errorType(error),
        message: truncateString(String(error.message ?? ""), MAX_MESSAGE_LENGTH),
        backtrace,
      },
    ],
    context: {
      notifier: "errorgap-react-native",
      notifier_version: VERSION,
      environment: configuration.environment,
      release: configuration.release,
      ...(causes.length > 0 ? { causes } : {}),
      ...(breadcrumbs.length > 0 ? { breadcrumbs } : {}),
      ...(options.isFatal !== undefined ? { is_fatal: options.isFatal } : {}),
      ...cleanRecord(options.context),
    },
    environment: {
      ...configuration.deviceInfo,
      ...(options.environment ?? {}),
    },
    session: filterParams(
      { ...userSession(options.user), ...(options.session ?? {}) },
      configuration.filterKeys,
    ),
    params: filterParams(options.params ?? {}, configuration.filterKeys),
  };
}

/**
 * Walk `error.cause` (ES2022) and merge each cause's frames into a single
 * backtrace, re-indexing so the dashboard renders the full chain in one view.
 */
function flattenBacktrace(error: Error): BacktraceFrame[] {
  const frames: BacktraceFrame[] = [];
  let index = 0;
  for (const link of errorChain(error)) {
    for (const frame of parseBacktrace(link)) {
      frames.push({ ...frame, index: index++ });
    }
  }
  return frames;
}

function collectCauses(error: Error): NoticeCause[] {
  const chain = errorChain(error);
  return chain.slice(1).map((link) => ({
    type: errorType(link),
    message: truncateString(String(link.message ?? ""), MAX_MESSAGE_LENGTH),
  }));
}

function errorChain(error: Error): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (
    current instanceof Error &&
    !seen.has(current) &&
    chain.length < MAX_CAUSE_DEPTH
  ) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function errorType(error: Error): string {
  if (typeof error.name === "string" && error.name.length > 0) {
    return error.name;
  }
  return error.constructor?.name ?? "Error";
}

function userSession(user: NoticeUser | null | undefined): Record<string, unknown> {
  const session: Record<string, unknown> = {};
  if (user?.id !== undefined && user.id !== null && String(user.id) !== "") {
    session.user_id = String(user.id);
  }
  if (user?.email) session.user_email = String(user.email);
  return session;
}
