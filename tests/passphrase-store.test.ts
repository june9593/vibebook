import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("passphrase-store", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "memvc-pp-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("readPassphraseFile returns undefined when no file", async () => {
    const m = await import("../src/passphrase-store.js");
    expect(m.readPassphraseFile()).toBeUndefined();
  });

  it("writePassphraseFile creates file with mode 0600", async () => {
    const m = await import("../src/passphrase-store.js");
    m.writePassphraseFile("secret");
    const p = m.passphrasePath();
    const s = statSync(p);
    expect(s.mode & 0o777).toBe(0o600);
    expect(m.readPassphraseFile()).toBe("secret");
  });

  it("writePassphraseFile overwrites and re-chmods existing file", async () => {
    mkdirSync(join(tmpHome, ".vibebook"), { recursive: true });
    const p = join(tmpHome, ".vibebook", "passphrase");
    writeFileSync(p, "old\n", { mode: 0o644 });
    const m = await import("../src/passphrase-store.js");
    m.writePassphraseFile("new");
    expect(m.readPassphraseFile()).toBe("new");
    const s = statSync(p);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("readPassphraseFile trims whitespace and returns undefined on empty", async () => {
    const m = await import("../src/passphrase-store.js");
    m.writePassphraseFile("  ");
    expect(m.readPassphraseFile()).toBeUndefined();
  });

  it("config.getPassphrase prefers env over file", async () => {
    const m = await import("../src/passphrase-store.js");
    m.writePassphraseFile("from-file");
    vi.stubEnv("VIBEBOOK_PASSPHRASE", "from-env");
    const cfg = await import("../src/config.js");
    expect(cfg.getPassphrase()).toBe("from-env");
  });

  it("config.getPassphrase falls back to file when env missing", async () => {
    const m = await import("../src/passphrase-store.js");
    m.writePassphraseFile("from-file");
    vi.stubEnv("VIBEBOOK_PASSPHRASE", "");
    const cfg = await import("../src/config.js");
    expect(cfg.getPassphrase()).toBe("from-file");
  });

  it("config.getPassphrase throws when neither env nor file set", async () => {
    vi.stubEnv("VIBEBOOK_PASSPHRASE", "");
    const cfg = await import("../src/config.js");
    expect(() => cfg.getPassphrase()).toThrow(/encryption is on/);
  });
});
