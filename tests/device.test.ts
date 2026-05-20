import { describe, it, expect } from "vitest";
import { sanitizeBranchName, deviceBranchFromHostname, isStableDeviceName } from "../src/device.js";

describe("sanitizeBranchName", () => {
  it("keeps alnum, dash, underscore, dot", () => {
    expect(sanitizeBranchName("yuedeMacBook-Pro-2.local")).toBe("yuedeMacBook-Pro-2.local");
  });
  it("replaces spaces and unsafe chars with dashes", () => {
    expect(sanitizeBranchName("Yue's iMac")).toBe("Yue-s-iMac");
  });
  it("collapses runs of dashes and trims leading/trailing", () => {
    expect(sanitizeBranchName("---foo   bar---")).toBe("foo-bar");
  });
  it("lowercases nothing (preserves case)", () => {
    expect(sanitizeBranchName("MacBook")).toBe("MacBook");
  });
  it("falls back to 'device' when empty after sanitize", () => {
    expect(sanitizeBranchName("///")).toBe("device");
  });
  it("truncates to 60 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeBranchName(long).length).toBe(60);
  });
  it("collapses consecutive dots (git rejects ..)", () => {
    expect(sanitizeBranchName("foo..bar")).toBe("foo.bar");
  });
  it("strips trailing .lock (git rejects refs ending in .lock)", () => {
    expect(sanitizeBranchName("my.lock")).toBe("my");
  });
  it("preserves underscores", () => {
    expect(sanitizeBranchName("my_host_01")).toBe("my_host_01");
  });
});

describe("deviceBranchFromHostname", () => {
  it("returns sanitized hostname", () => {
    const b = deviceBranchFromHostname();
    expect(b.length).toBeGreaterThan(0);
    expect(b).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("isStableDeviceName", () => {
  it("flags Bonjour / mDNS names (.local) as drift-prone", () => {
    expect(isStableDeviceName("Mac-mini-2.local")).toBe(false);
    expect(isStableDeviceName("yuedeMacBook-Pro-2.local")).toBe(false);
  });
  it("flags corp DHCP-style ALL-CAPS dotted names as drift-prone", () => {
    expect(isStableDeviceName("MIS-EV2-BB1.surfacescenarios.org")).toBe(false);
  });
  it("accepts physical-label style names as stable", () => {
    expect(isStableDeviceName("mini2")).toBe(true);
    expect(isStableDeviceName("work-laptop")).toBe(true);
    expect(isStableDeviceName("yue-mini2")).toBe(true);
  });
  it("accepts mixed-case names without a dot as stable", () => {
    expect(isStableDeviceName("yuedeMacBook-Pro-2")).toBe(true);
  });
});
