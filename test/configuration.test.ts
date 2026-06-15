import { describe, it, expect } from "vitest";
import { Configuration } from "../src/configuration.js";

describe("Configuration", () => {
  it("uses defaults when nothing is provided", () => {
    const cfg = new Configuration();
    expect(cfg.environment).toBe("production");
    expect(cfg.async).toBe(true);
    expect(cfg.filterKeys).toContain("password");
  });

  it("validate throws when endpoint missing", () => {
    const cfg = new Configuration({ projectSlug: "demo" });
    expect(() => cfg.validate()).toThrow(/endpoint/);
  });

  it("validate throws when projectSlug missing", () => {
    const cfg = new Configuration({ endpoint: "https://e.example.com" });
    expect(() => cfg.validate()).toThrow(/projectSlug/);
  });

  it("validate passes with both endpoint and projectSlug", () => {
    const cfg = new Configuration({ endpoint: "https://e.example.com", projectSlug: "demo" });
    expect(() => cfg.validate()).not.toThrow();
  });

  it("merges deviceInfo into notice environment via Configuration field", () => {
    const cfg = new Configuration({ deviceInfo: { os_name: "iOS", app_version: "1.0" } });
    expect(cfg.deviceInfo).toEqual({ os_name: "iOS", app_version: "1.0" });
  });
});
