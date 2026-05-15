/**
 * Fork bookkeeping for cross-device resume.
 *
 * When laptop B runs `vibebook resume <id>` on a session created on laptop A,
 * we treat the resume as a fork: B gets a fresh sessionId so both devices
 * can continue the same starting context independently. Once B's resumed
 * session syncs back into the spool, the spool's IndexEntry should carry an
 * `originSessionId` pointing at A's id, so plugin-side digest can reason
 * about same-source threads.
 *
 * Design: keep the rewritten jsonl Claude-pure (id substitution only, no
 * unknown record types). Provenance is recorded in a sidecar registry at
 * ~/.vibebook/resume-forks.json and stamped onto the IndexEntry on next sync.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const REGISTRY_PATH_REL = ".vibebook/resume-forks.json";

export interface ForkRecord {
  originSessionId: string;
  resumedAt: string;
}

export interface ForkRegistry {
  version: 1;
  /** key = newSessionId */
  forks: Record<string, ForkRecord>;
}

export function registryPath(): string {
  return join(homedir(), REGISTRY_PATH_REL);
}

export function loadForkRegistry(path: string = registryPath()): ForkRegistry {
  if (!existsSync(path)) return { version: 1, forks: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ForkRegistry;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported resume-forks.json version: ${parsed.version}`);
  }
  return parsed;
}

export function recordFork(
  newSessionId: string,
  originSessionId: string,
  resumedAt: string = new Date().toISOString(),
  path: string = registryPath(),
): void {
  const reg = loadForkRegistry(path);
  reg.forks[newSessionId] = { originSessionId, resumedAt };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(reg, null, 2) + "\n");
}

export function lookupOrigin(
  newSessionId: string,
  path: string = registryPath(),
): ForkRecord | undefined {
  return loadForkRegistry(path).forks[newSessionId];
}

/**
 * Rewrite every embedded reference to oldSessionId in the jsonl to point at
 * newSessionId. Boundary-aware (the id must be inside JSON quotes) so a UUID
 * prefix doesn't accidentally rewrite a longer string starting with it.
 */
export function rewriteSessionId(
  sourceJsonl: string,
  oldSessionId: string,
  newSessionId: string,
): string {
  const escaped = oldSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(["])${escaped}(["])`, "g");
  return sourceJsonl.replace(re, `$1${newSessionId}$2`);
}
