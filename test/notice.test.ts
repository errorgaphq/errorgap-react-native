import { describe, it, expect } from "vitest";
import { Configuration } from "../src/configuration.js";
import { buildNotice } from "../src/notice.js";
import { VERSION } from "../src/version.js";

describe("buildNotice", () => {
  const cfg = new Configuration({
    endpoint: "https://e.example.com",
    projectSlug: "demo",
    projectId: "p_1",
    environment: "test",
    release: "1.2.3",
    deviceInfo: { os_name: "iOS", os_version: "17.0", device_model: "iPhone 15" },
  });

  it("captures type and message from an Error", () => {
    const notice = buildNotice(new TypeError("boom"), cfg);
    expect(notice.errors[0]?.type).toBe("TypeError");
    expect(notice.errors[0]?.message).toBe("boom");
  });

  it("includes notifier identification and release in context", () => {
    const notice = buildNotice(new Error("x"), cfg);
    expect(notice.context.notifier).toBe("errorgap-react-native");
    expect(notice.context.notifier_version).toBe(VERSION);
    expect(notice.context.environment).toBe("test");
    expect(notice.context.release).toBe("1.2.3");
  });

  it("merges deviceInfo into notice environment", () => {
    const notice = buildNotice(new Error("x"), cfg);
    expect(notice.environment.os_name).toBe("iOS");
    expect(notice.environment.device_model).toBe("iPhone 15");
  });

  it("filters sensitive params", () => {
    const notice = buildNotice(new Error("x"), cfg, {
      params: { username: "alice", password: "hunter2" },
    });
    expect(notice.params.username).toBe("alice");
    expect(notice.params.password).toBe("[FILTERED]");
  });

  it("records is_fatal in context", () => {
    const notice = buildNotice(new Error("x"), cfg, { isFatal: true });
    expect(notice.context.is_fatal).toBe(true);
  });
});

describe("buildNotice cause chains", () => {
  const cfg = new Configuration({ endpoint: "https://e.example.com", projectSlug: "demo" });

  it("records nested causes in context and merges their frames", () => {
    const root = new Error("db connection refused");
    root.name = "ConnectionError";
    const mid = new Error("failed to load order", { cause: root });
    mid.name = "RepositoryError";
    const top = new Error("checkout failed", { cause: mid });
    top.name = "CheckoutError";

    const notice = buildNotice(top, cfg);
    expect(notice.errors[0]?.type).toBe("CheckoutError");
    expect(notice.errors[0]?.message).toBe("checkout failed");
    const causes = notice.context.causes as Array<{ type: string; message: string }>;
    expect(causes).toEqual([
      { type: "RepositoryError", message: "failed to load order" },
      { type: "ConnectionError", message: "db connection refused" },
    ]);
    // frames from all three links are merged and re-indexed contiguously
    const frames = notice.errors[0]!.backtrace;
    expect(frames.length).toBeGreaterThan(0);
    frames.forEach((frame, i) => expect(frame.index).toBe(i));
  });

  it("omits causes when there is no cause chain", () => {
    const notice = buildNotice(new Error("solo"), cfg);
    expect(notice.context.causes).toBeUndefined();
  });

  it("tolerates cyclic cause references", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    const notice = buildNotice(a, cfg);
    expect((notice.context.causes as unknown[]).length).toBe(1);
  });
});

describe("buildNotice breadcrumbs", () => {
  const cfg = new Configuration({ endpoint: "https://e.example.com", projectSlug: "demo" });

  it("attaches provided breadcrumbs to context", () => {
    const notice = buildNotice(new Error("x"), cfg, {
      breadcrumbs: [
        { message: "navigated to Cart", category: "navigation", timestamp: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const crumbs = notice.context.breadcrumbs as Array<{ message: string }>;
    expect(crumbs[0]?.message).toBe("navigated to Cart");
  });

  it("omits breadcrumbs key when none provided", () => {
    const notice = buildNotice(new Error("x"), cfg);
    expect(notice.context.breadcrumbs).toBeUndefined();
  });
});
