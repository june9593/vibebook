import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { IndexFile, IndexEntry, Tool } from "./types.js";

const REL = ".memvc/index.json";

export function loadIndex(repoRoot: string): IndexFile {
  const p = join(repoRoot, REL);
  if (!existsSync(p)) return { version: 1, entries: {} };
  const parsed = JSON.parse(readFileSync(p, "utf8")) as IndexFile;
  if (parsed.version !== 1) throw new Error(`unsupported index version: ${parsed.version}`);
  return parsed;
}

export function saveIndex(repoRoot: string, idx: IndexFile): void {
  const p = join(repoRoot, REL);
  mkdirSync(join(repoRoot, ".memvc"), { recursive: true });
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
): boolean {
  const e = idx.entries[keyFor(tool, sessionId)];
  return !!e && e.sourceMtimeMs === mtimeMs && e.sourceSha256 === sha256;
}
