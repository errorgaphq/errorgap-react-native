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

function safeConsole(): Logger | null {
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    return console;
  }
  return null;
}
