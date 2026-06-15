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
