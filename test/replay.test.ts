import { afterEach, describe, expect, it, vi } from "vitest";
import { Errorgap } from "../src/index.js";
import { BACKGROUND_TIMEOUT_MS, type AppStateLike } from "../src/replay.js";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

const ENDPOINT = "https://errorgap.example.com";
const SESSIONS = `${ENDPOINT}/api/projects/app/sessions`;
const originalFetch = globalThis.fetch;

function fakeServer(config: { enabled?: boolean; sample_rate?: number }, apiStatus = 200): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    sent.push({ url, method: init?.method ?? "GET", headers, body });
    if (url.includes("/sessions/config")) {
      return new Response(JSON.stringify({ enabled: true, sample_rate: 1, ...config }), { status: 200 });
    }
    if (url.endsWith("/notices")) return new Response('{"group_id":"group-9"}', { status: 201 });
    if (url === SESSIONS) return new Response(null, { status: 201 });
    return new Response("{}", { status: apiStatus });
  }) as typeof fetch;
  return sent;
}

function fakeAppState(): AppStateLike & { emit(state: string): void } {
  const listeners: Array<(s: string) => void> = [];
  return {
    addEventListener: (_type, listener) => {
      listeners.push(listener);
      return { remove: () => listeners.splice(listeners.indexOf(listener), 1) };
    },
    emit: (state) => listeners.slice().forEach((l) => l(state)),
  };
}

function init(appState = fakeAppState()) {
  Errorgap.init({
    endpoint: ENDPOINT,
    projectSlug: "app",
    apiKey: "egp_key",
    release: "2.3.0",
    captureGlobals: false,
    async: false,
    replay: { appState, platform: { OS: "ios", Version: "17.6" }, appName: "Acme" },
  });
  return appState;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const batches = (sent: Sent[]) => sent.filter((s) => s.url === SESSIONS);
const events = (sent: Sent[]) => batches(sent).flatMap((b) => b.body.events as Array<Record<string, unknown>>);

afterEach(() => {
  Errorgap.init({ captureGlobals: false, replay: false });
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("React Native session replay", () => {
  it("records nothing while replay is off for the project", async () => {
    const sent = fakeServer({ enabled: false });
    const appState = init();
    await settle();
    Errorgap.trackScreen("Checkout");
    appState.emit("background");
    await settle();

    expect(sent.map((s) => s.url)).toEqual([`${SESSIONS}/config?api_key=egp_key`]);
  });

  it("records the app start, screens, failed calls and errors linked to their group", async () => {
    const sent = fakeServer({}, 503);
    init();
    await settle();

    const ref = { getCurrentRoute: () => ({ name: "Checkout" }) };
    const onStateChange = Errorgap.errorgapNavigationListener(ref);
    onStateChange();
    onStateChange(); // same screen: recorded once
    await fetch("https://api.acme.example/orders?id=7", { method: "post" });
    await Errorgap.notify(new TypeError("token is undefined"), { sync: true });
    await settle();

    const [first] = batches(sent);
    expect(first!.headers["x-errorgap-project-key"]).toBe("egp_key");
    expect(first!.body.session).toMatchObject({ browser: "Acme 2.3.0", os: "iOS 17.6", device: "Mobile" });
    expect(events(sent).map((e) => `${e.type}:${e.label}`)).toEqual([
      "page_load:App started",
      "navigation:Opened Checkout",
      "api_error:POST https://api.acme.example/orders → 503",
      "error:TypeError: token is undefined",
    ]);
    expect(events(sent).find((e) => e.type === "error")).toMatchObject({ group_id: "group-9" });
    expect(batches(sent).slice(-1)[0]!.body.session.outcome).toBe("error");
  });

  it("ends the batch on background and starts a new session after 30 minutes away", async () => {
    const sent = fakeServer({});
    const appState = init();
    await settle();

    appState.emit("background");
    await settle();
    const firstId = batches(sent)[0]!.body.session.id;
    expect(events(sent).slice(-1)[0]).toMatchObject({ type: "exit", label: "App went to the background" });
    expect(batches(sent).slice(-1)[0]!.body.session.outcome).toBe("completed");

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + BACKGROUND_TIMEOUT_MS + 1000);
    appState.emit("active");
    await settle();
    vi.restoreAllMocks();
    Errorgap.trackScreen("Home");
    await Errorgap.notify(new Error("boom"), { sync: true });
    await settle();

    const ids = new Set(batches(sent).map((b) => b.body.session.id));
    expect(ids.size).toBe(2);
    const second = batches(sent).find((b) => b.body.session.id !== firstId)!;
    expect(second.body.events[0]).toMatchObject({ type: "page_load", label: "App opened" });
  });

  it("returns to the same session after a short background", async () => {
    const sent = fakeServer({});
    const appState = init();
    await settle();
    appState.emit("background");
    appState.emit("active");
    await Errorgap.notify(new Error("boom"), { sync: true });
    await settle();

    expect(new Set(batches(sent).map((b) => b.body.session.id)).size).toBe(1);
    expect(events(sent).map((e) => e.label)).toContain("Returned to the app");
  });

  it("stops recording the session when the server refuses it", async () => {
    const sent = fakeServer({});
    let refuse = false;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await inner(input, init);
      return refuse && String(input) === SESSIONS ? new Response(null, { status: 204 }) : res;
    }) as typeof fetch;
    init();
    await settle();
    refuse = true;
    await Errorgap.notify(new Error("first"), { sync: true });
    await settle();
    const before = batches(sent).length;
    await Errorgap.notify(new Error("second"), { sync: true });
    await settle();

    expect(batches(sent).length).toBe(before);
  });
});
