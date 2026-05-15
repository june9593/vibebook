import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadForkRegistry,
  recordFork,
  lookupOrigin,
  rewriteSessionId,
} from "../../../src/commands/resume/fork.js";

describe("rewriteSessionId", () => {
  it("rewrites all quoted occurrences of the old id", () => {
    const input =
      `{"sessionId":"abc","other":"abc"}\n` +
      `{"parentSessionId":"abc"}\n`;
    const out = rewriteSessionId(input, "abc", "xyz");
    expect(out).toContain(`"sessionId":"xyz"`);
    expect(out).toContain(`"other":"xyz"`);
    expect(out).toContain(`"parentSessionId":"xyz"`);
    expect(out).not.toContain(`"abc"`);
  });

  it("does not rewrite an id appearing inside a longer string", () => {
    // The old id inside another id-like substring shouldn't match because
    // our boundary requires both quotes.
    const input = `{"sessionId":"abc-extra","short":"abc"}\n`;
    const out = rewriteSessionId(input, "abc", "xyz");
    expect(out).toContain(`"abc-extra"`); // unchanged
    expect(out).toContain(`"short":"xyz"`); // changed
  });

  it("returns input unchanged when id is not present", () => {
    const input = `{"sessionId":"other"}\n`;
    expect(rewriteSessionId(input, "missing", "xyz")).toBe(input);
  });
});

describe("fork registry", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vb-fork-"));
    path = join(dir, "resume-forks.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadForkRegistry returns empty when file is absent", () => {
    const reg = loadForkRegistry(path);
    expect(reg).toEqual({ version: 1, forks: {} });
  });

  it("recordFork writes and lookupOrigin reads back", () => {
    recordFork("new-1", "origin-1", "2026-05-14T00:00:00Z", path);
    expect(existsSync(path)).toBe(true);

    const got = lookupOrigin("new-1", path);
    expect(got).toEqual({ originSessionId: "origin-1", resumedAt: "2026-05-14T00:00:00Z" });
  });

  it("recordFork preserves prior entries (multi-fork session lifetime)", () => {
    recordFork("new-1", "origin-1", "2026-05-14T00:00:00Z", path);
    recordFork("new-2", "origin-2", "2026-05-14T01:00:00Z", path);
    const reg = loadForkRegistry(path);
    expect(Object.keys(reg.forks).sort()).toEqual(["new-1", "new-2"]);
  });

  it("lookupOrigin returns undefined for unknown ids", () => {
    expect(lookupOrigin("never-recorded", path)).toBeUndefined();
  });
});
