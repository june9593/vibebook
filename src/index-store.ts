import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { IndexFile, IndexEntry, Tool } from "./types.js";
import { INDEX_REL, dataDirAbs } from "./repo-data-dir.js";

export function loadIndex(repoRoot: string): IndexFile {
  const p = join(repoRoot, INDEX_REL);
  if (!existsSync(p)) return { version: 1, entries: {} };
  const parsed = JSON.parse(readFileSync(p, "utf8")) as IndexFile;
  if (parsed.version !== 1) throw new Error(`unsupported index version: ${parsed.version}`);
  return parsed;
}

export function saveIndex(repoRoot: string, idx: IndexFile): void {
  const p = join(repoRoot, INDEX_REL);
  mkdirSync(dataDirAbs(repoRoot), { recursive: true });
  writeFileSync(p, JSON.stringify(idx, null, 2) + "\n");
}

export function keyFor(tool: Tool, sessionId: string): string {
  return `${tool}:${sessionId}`;
}

export function upsertEntry(idx: IndexFile, entry: IndexEntry): void {
  idx.entries[keyFor(entry.tool, entry.sessionId)] = entry;
}

export function hasUnchanged(
  idx: IndexFile,
  tool: Tool,
  sessionId: string,
  mtimeMs: number,
  sha256: string,
  repoRoot: string,
): boolean {
  const e = idx.entries[keyFor(tool, sessionId)];
  if (!e || e.sourceMtimeMs !== mtimeMs || e.sourceSha256 !== sha256) return false;
  // The index can survive branch switches that leave raw_sessions/ incomplete
  // — if the indexed file is missing from the working tree, treat it as stale
  // so the entry gets re-extracted. Otherwise the new branch would never
  // collect the file it's missing.
  if (!existsSync(join(repoRoot, e.relativePath))) return false;
  return true;
}
