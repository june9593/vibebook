import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "../../src/commands/sync.js";
import { loadIndex } from "../../src/index-store.js";

const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures");

describe("runSync", () => {
  let repo: string;
  let claudeRoot: string;
  let vscodeRoot: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "memvc-repo-"));
    claudeRoot = mkdtempSync(join(tmpdir(), "memvc-claude-"));
    // put the claude fixture under claudeRoot/<project>
    const proj = join(claudeRoot, "-Users-yueliu-edge-memvc");
    mkdirSync(proj, { recursive: true });
    cpSync(join(fixturesDir, "claude-session.jsonl"), join(proj, "abc12345.jsonl"));
    // empty vscode root
    vscodeRoot = mkdtempSync(join(tmpdir(), "memvc-vscode-"));
  });

  it("extracts new sessions, writes files, updates index", async () => {
    const result = await runSync({
      repoPath: repo, claudeRoot, vscodeRoot, encrypt: false,
    });
    expect(result.newCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    const idx = loadIndex(repo);
    expect(Object.keys(idx.entries).length).toBe(1);
    const entry = Object.values(idx.entries)[0]!;
    expect(existsSync(join(repo, entry.relativePath))).toBe(true);
    // Markdown sibling exists
    const mdPath = entry.relativePath.replace(".raw.json", ".md");
    expect(existsSync(join(repo, mdPath))).toBe(true);
  });

  it("skips unchanged sessions on second run", async () => {
    await runSync({ repoPath: repo, claudeRoot, vscodeRoot, encrypt: false });
    const result2 = await runSync({ repoPath: repo, claudeRoot, vscodeRoot, encrypt: false });
    expect(result2.newCount).toBe(0);
    expect(result2.skippedCount).toBe(1);
  });
});
