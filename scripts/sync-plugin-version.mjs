#!/usr/bin/env node
// Mirror package.json version into .claude-plugin/{plugin,marketplace}.json.
// Wired into npm's `version` lifecycle so every `npm version <bump>` keeps
// the Claude Code plugin manifest in lockstep with the npm package — the
// installed-but-stale plugin entry was a real surprise once and we don't
// want it to surprise us again.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
if (!version) {
  console.error("No version in package.json");
  process.exit(1);
}

function bump(relPath, mutate) {
  const path = join(root, relPath);
  const before = readFileSync(path, "utf8");
  const json = JSON.parse(before);
  mutate(json);
  // Preserve trailing newline; JSON.stringify drops it.
  const after = JSON.stringify(json, null, 2) + (before.endsWith("\n") ? "\n" : "");
  if (before === after) {
    console.log(`  unchanged ${relPath}`);
    return;
  }
  writeFileSync(path, after);
  console.log(`  bumped    ${relPath} → ${version}`);
}

bump(".claude-plugin/plugin.json", (j) => { j.version = version; });
bump(".claude-plugin/marketplace.json", (j) => {
  j.plugins?.forEach((p) => { p.version = version; });
});
