import type { Configuration } from "./configuration.js";

/**
 * Session replay for React Native: a timeline of the app session (start,
 * screens, failed API calls, reported errors, backgrounding). Mobile sessions
 * are timeline only: no screenshots or view snapshots are taken.
 *
 * The project's replay settings decide whether a session is recorded: the
 * recorder reads them when a session starts and records a sampled share of
 * sessions while replay is on.
 */

/** The parts of React Native's `AppState` the recorder uses. */
export interface AppStateLike {
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void } | void;
}

/** The parts of React Native's `Platform` the recorder uses. */
export interface PlatformLike {
  OS?: string;
  Version?: string | number;
  isPad?: boolean;
}

export interface ReplayOptions {
  /** How often recorded events are sent, in ms. Defaults to 10 000. */
  flushIntervalMs?: number;
  /** The app's name, shown with its release as the session's "browser". */
  appName?: string;
  /** Defaults to `AppState` from `react-native`. */
  appState?: AppStateLike;
  /** Defaults to `Platform` from `react-native`. */
  platform?: PlatformLike;
}

export interface ReplayEvent {
  t: number;
  type: string;
  label: string;
  group_id?: string;
}

type FetchInput = Parameters<typeof fetch>[0];

/** A session ends once the app has been in the background this long. */
export const BACKGROUND_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_BATCH_EVENTS = 200;
const MAX_BUFFERED_EVENTS = 1000;
const MAX_LABEL = 200;

/**
 * Per session: `pending` while the project's settings are read (events are
 * buffered), then `recording` or `skipped`. `stopped` is the recorder shut
 * down by a later `init`.
 */
type State = "pending" | "recording" | "skipped" | "stopped";

export class ReplayRecorder {
  private state: State = "pending";
  private sessionId = "";
  private startedAt = 0;
  private hadError = false;
  private events: ReplayEvent[] = [];
  private lastScreen: string | undefined;
  private backgroundAt: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private restore: Array<() => void> = [];
  private readonly originalFetch: typeof fetch | undefined;
  private readonly base: string;
  private readonly platform: PlatformLike;
  private readonly appState: AppStateLike | undefined;

  constructor(
    private configuration: Configuration,
    private options: ReplayOptions = {},
  ) {
    this.originalFetch = typeof fetch === "function" ? fetch.bind(globalThis) : undefined;
    this.base = `${configuration.endpoint.replace(/\/+$/, "")}/api/projects/${configuration.projectSlug}`;
    const rn = options.appState && options.platform ? undefined : reactNative();
    this.platform = options.platform ?? rn?.Platform ?? {};
    this.appState = options.appState ?? rn?.AppState;
  }

  get recording(): boolean {
    return this.state === "recording";
  }

  start(): void {
    this.watchRequests();
    if (this.appState) this.watchAppState(this.appState);
    this.newSession("App started");
  }

  stop(): void {
    this.clearTimer();
    for (const undo of this.restore.splice(0).reverse()) undo();
    this.state = "stopped";
    this.events = [];
  }

  /** A screen is now showing (`Errorgap.trackScreen`). */
  screen(name: string): void {
    if (!name || name === this.lastScreen) return;
    this.lastScreen = name;
    this.push({ type: "navigation", label: `Opened ${name}` });
  }

  /** An error is being reported; call the result with its group id once answered. */
  errorStarted(label: string): (groupId?: string) => void {
    if (!this.active()) return () => undefined;
    const t = this.offset();
    const session = this.sessionId;
    this.hadError = true;
    let done = false;
    return (groupId?: string) => {
      if (done || session !== this.sessionId) return;
      done = true;
      this.push({ t, type: "error", label, ...(groupId ? { group_id: groupId } : {}) });
      this.flush(false);
    };
  }

  flush(final: boolean): void {
    if (this.state !== "recording") return;
    do {
      const events = this.events.splice(0, MAX_BATCH_EVENTS);
      if (events.length === 0 && !final) return;
      this.send(this.batch(events, final));
      final = false;
    } while (this.events.length > 0);
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  private newSession(label: string): void {
    this.clearTimer();
    this.state = "pending";
    this.sessionId = uuid();
    this.startedAt = Date.now();
    this.hadError = false;
    this.events = [];
    this.lastScreen = undefined;
    this.push({ type: "page_load", label });
    void this.decide(this.sessionId);
  }

  private async decide(session: string): Promise<void> {
    const key = this.configuration.apiKey ? `?api_key=${encodeURIComponent(this.configuration.apiKey)}` : "";
    let record = false;
    try {
      const res = await this.originalFetch?.(`${this.base}/sessions/config${key}`);
      if (res && res.ok) {
        const config = (await res.json()) as { enabled?: boolean; sample_rate?: number };
        const rate = typeof config.sample_rate === "number" ? config.sample_rate : 0;
        record = config.enabled === true && Math.random() < rate;
      }
    } catch {
      // Settings unreadable (offline, wrong key): this session is not recorded.
    }
    if (session !== this.sessionId || this.state !== "pending") return;
    if (!record) {
      this.skip();
      return;
    }
    this.state = "recording";
    this.timer = setInterval(() => this.flush(false), this.options.flushIntervalMs ?? 10_000);
    this.flush(false);
  }

  private skip(): void {
    this.clearTimer();
    this.state = "skipped";
    this.events = [];
  }

  private active(): boolean {
    return this.state === "pending" || this.state === "recording";
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private push(event: Omit<ReplayEvent, "t"> & { t?: number }): void {
    if (!this.active() || this.events.length >= MAX_BUFFERED_EVENTS) return;
    const label = event.label.length > MAX_LABEL ? `${event.label.slice(0, MAX_LABEL - 1)}…` : event.label;
    this.events.push({ ...event, t: event.t ?? this.offset(), label });
  }

  private watchAppState(appState: AppStateLike): void {
    const subscription = appState.addEventListener("change", (next) => {
      if (this.state === "stopped") return;
      const now = Date.now();
      if (next === "background" && this.backgroundAt === undefined) {
        this.backgroundAt = now;
        this.push({ type: "exit", label: "App went to the background" });
        this.flush(true);
      } else if (next === "active" && this.backgroundAt !== undefined) {
        const away = now - this.backgroundAt;
        this.backgroundAt = undefined;
        if (away >= BACKGROUND_TIMEOUT_MS) {
          this.newSession("App opened");
        } else {
          this.push({ type: "navigation", label: "Returned to the app" });
        }
      }
    });
    if (subscription && typeof subscription.remove === "function") {
      this.restore.push(() => subscription.remove());
    }
  }

  private watchRequests(): void {
    if (typeof globalThis.fetch !== "function") return;
    const original = globalThis.fetch;
    const recorder = this;
    globalThis.fetch = function (input: FetchInput, init?: RequestInit) {
      const url = urlOf(input);
      if (!url || url.startsWith(`${recorder.base}/`)) return original(input, init);
      const method = (
        init?.method ?? (typeof input === "object" && input && "method" in input ? String(input.method) : "GET")
      ).toUpperCase();
      return original(input, init).then(
        (response) => {
          if (response.status >= 500) recorder.apiError(method, url, response.status);
          return response;
        },
        (error: unknown) => {
          recorder.apiError(method, url, 0);
          throw error;
        },
      );
    } as typeof fetch;
    this.restore.push(() => {
      globalThis.fetch = original;
    });
  }

  private apiError(method: string, url: string, status: number): void {
    this.push({ type: "api_error", label: `${method} ${stripQuery(url)} → ${status === 0 ? "failed" : status}` });
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  private batch(events: ReplayEvent[], final: boolean): string {
    const now = Date.now();
    const os =
      this.platform.OS === "ios" ? "iOS" : this.platform.OS === "android" ? "Android" : this.platform.OS ?? "";
    const version = os && this.platform.Version !== undefined ? ` ${this.platform.Version}` : "";
    const app = this.options.appName ?? "App";
    return JSON.stringify({
      session: {
        id: this.sessionId,
        handle: null,
        browser: this.configuration.release ? `${app} ${this.configuration.release}` : app,
        os: `${os}${version}`,
        device: this.platform.isPad ? "Tablet" : "Mobile",
        started_at: new Date(this.startedAt).toISOString(),
        ended_at: new Date(now).toISOString(),
        duration_sec: this.offset(now),
        outcome: this.hadError ? "error" : final ? "completed" : "abandoned",
      },
      events,
      snapshots: [],
    });
  }

  private send(body: string): void {
    const session = this.sessionId;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.configuration.apiKey) headers["x-errorgap-project-key"] = this.configuration.apiKey;
    void this.originalFetch?.(`${this.base}/sessions`, { method: "POST", headers, body })
      .then((res) => {
        // Replay switched off, or the session belongs elsewhere: stop this session.
        const refused = [204, 401, 404, 409].includes(res.status);
        if (refused && session === this.sessionId && this.state === "recording") this.skip();
      })
      .catch(() => undefined);
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private offset(now: number = Date.now()): number {
    return Math.max(0, Math.round((now - this.startedAt) / 1000));
  }
}

function reactNative(): { AppState?: AppStateLike; Platform?: PlatformLike } | undefined {
  try {
    // Optional peer dependency: absent outside React Native.
    return typeof require === "function"
      ? (require("react-native") as { AppState?: AppStateLike; Platform?: PlatformLike })
      : undefined;
  } catch {
    return undefined;
  }
}

function urlOf(input: FetchInput): string | undefined {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.href;
  if (typeof input === "object" && input && "url" in input) return String(input.url);
  return undefined;
}

function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
