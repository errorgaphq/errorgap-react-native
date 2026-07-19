export interface Logger {
  warn(message: string, ...args: unknown[]): void;
}

export interface ConfigurationInput {
  endpoint?: string;
  projectSlug?: string;
  projectId?: string;
  apiKey?: string;
  environment?: string;
  release?: string;
  async?: boolean;
  logger?: Logger | null;
  filterKeys?: string[];
  /**
   * Optional pre-captured device fingerprint (os, app version, build).
   * React Native callers typically supply this from `Platform.OS`,
   * `DeviceInfo.getVersion()`, etc.
   */
  deviceInfo?: Record<string, unknown>;
  /**
   * Resolve Metro bundle frames back to original source using the bundle's
   * source map. Applies when the stack carries absolute http(s) URLs (Metro
   * development bundles). Default true.
   */
  sourceMaps?: boolean;
  /** Enable APM transaction/span delivery. Default true. */
  apmEnabled?: boolean;
  /** Fraction (0..1) of transactions to deliver. Default 1. */
  apmSampleRate?: number;
  /** Enable structured log delivery. Default true. */
  logsEnabled?: boolean;
  /** Drop logs below this level (trace<debug<info<warn<error<fatal). Default "info". */
  minimumLogLevel?: string;
  /** Number of breadcrumbs retained and attached to notices. Default 25. */
  maxBreadcrumbs?: number;
}

const DEFAULT_FILTER_KEYS = [
  "password",
  "password_confirmation",
  "token",
  "secret",
  "api_key",
  "authorization",
  "cookie",
];

export class Configuration {
  endpoint: string;
  projectSlug: string | undefined;
  projectId: string | undefined;
  apiKey: string | undefined;
  environment: string;
  release: string | undefined;
  async: boolean;
  logger: Logger | null;
  filterKeys: string[];
  deviceInfo: Record<string, unknown>;
  sourceMaps: boolean;
  apmEnabled: boolean;
  apmSampleRate: number;
  logsEnabled: boolean;
  minimumLogLevel: string;
  maxBreadcrumbs: number;

  constructor(input: ConfigurationInput = {}) {
    this.endpoint = input.endpoint ?? "";
    this.projectSlug = input.projectSlug;
    this.projectId = input.projectId;
    this.apiKey = input.apiKey;
    this.environment = input.environment ?? "production";
    this.release = input.release;
    this.async = input.async ?? true;
    this.logger = input.logger === undefined ? safeConsole() : input.logger;
    this.filterKeys = input.filterKeys ?? [...DEFAULT_FILTER_KEYS];
    this.deviceInfo = input.deviceInfo ?? {};
    this.sourceMaps = input.sourceMaps ?? true;
    this.apmEnabled = input.apmEnabled ?? true;
    this.apmSampleRate = clampRate(input.apmSampleRate ?? 1);
    this.logsEnabled = input.logsEnabled ?? true;
    this.minimumLogLevel = input.minimumLogLevel ?? "info";
    this.maxBreadcrumbs = Math.max(0, Math.trunc(input.maxBreadcrumbs ?? 25));
  }

  validate(): void {
    if (!this.endpoint || this.endpoint.trim().length === 0) {
      throw new Error("Errorgap endpoint is required");
    }
    if (!this.projectSlug || this.projectSlug.trim().length === 0) {
      throw new Error("Errorgap projectSlug is required");
    }
  }
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(1, Math.max(0, rate));
}

function safeConsole(): Logger | null {
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    return console;
  }
  return null;
}
