#!/usr/bin/env node
// Aggregate every device branch's book/ into main.
//
// Called from .github/workflows/vibebook-aggregate.yml — checked-in on main,
// runs on every push to a non-main branch. Purely mechanical; never touches
// an LLM. The LLM work happens in-session via the /vibebook skill on each
// device, then `vibebook publish` writes per-device chronicle/topic/card
// files into that device's branch. This script merges all those device
// branches into main.
//
// vibebook v0.2 schema (book index v2):
//
//   chronicles/  — thread-grain diary entries, INSERT-only on each device.
//                  Across devices, dedup by threadId (latest updatedAt wins).
//
//   topics/      — mid-grain knowledge pages, FULL-REWRITTEN per session.
//                  We CANNOT mechanically merge two devices' rewrites of the
//                  same topic — they diverge in voice and structure. So we
//                  preserve each as <topicSlug>.<device>.md.
//
//   cards/       — atomic insight cards, INSERT/UPDATE per slug per project.
//                  Across devices, union by (project, slug); slug collision
//                  resolves to latest updatedAt. _global/cards/ unioned
//                  unconditionally.
//
// Algorithm:
//   1. List remote device branches (refs/remotes/origin/*, minus main + HEAD).
//   2. For each, read its BookIndex v2 via `git show`. Skip if missing or v1.
//   3. Walk each per-device entries; bucket into 3 collections.
//   4. Apply per-collection merge rules; copy files from origin device branch.
//   5. Prune main-side files that no live device claims.
//   6. Regen book/index.md + book/_meta/timeline.md + per-project index pages.
//   7. git add book/ + commit (no-op if nothing changed).
//
// The caller (yaml step) takes care of `git push`.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const BOOK_INDEX_PATH = ".vibebook/index.book.json";
const SPOOL_INDEX_PATH = ".vibebook/index.json";
const AGGREGATED_INDEX_PATH = ".vibebook/index.aggregated.json";
const MEMORY_INDEX_PATH = ".vibebook/index.memory.json";
const ENTITY_INDEX_PATH = ".vibebook/index.entity.json";

/**
 * Guard against path-traversal attacks in memory entry paths.
 * A device's index.memory.json could (if malicious or corrupted) point
 * entry.path outside memory/ (e.g. ".github/workflows/foo.yml", "../../x").
 * Only allow relative paths that start with "memory/" and contain no ".."
 * segments or absolute-path markers.
 */
function isSafeMemoryPath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0")) return false;
  // must be a relative path under memory/, no traversal
  const norm = p.split("\\").join("/");
  if (norm.startsWith("/")) return false;
  if (!norm.startsWith("memory/")) return false;
  if (norm.split("/").some((seg) => seg === "..")) return false;
  return true;
}

/**
 * Guard against path-traversal attacks in entity entry paths.
 * Identical logic to isSafeMemoryPath but restricted to memory/entities/,
 * and further requires a .md suffix (entity prune only deletes *.md, so a
 * non-md file would persist). Entries that fail this check are logged and
 * skipped.
 */
function isSafeEntityPath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0")) return false;
  const norm = p.split("\\").join("/");
  if (norm.startsWith("/")) return false;
  if (!norm.startsWith("memory/entities/")) return false;
  if (norm.split("/").some((seg) => seg === "..")) return false;
  if (!norm.endsWith(".md")) return false;
  return true;
}

function sh(cmd, args) {
  return execSync([cmd, ...args].join(" "), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function shOk(cmd, args) {
  try {
    return { ok: true, stdout: sh(cmd, args) };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err.stderr ?? "") };
  }
}

function listDeviceBranches() {
  const raw = sh("git", ["for-each-ref", "--format='%(refname:short)'", "refs/remotes/origin/"]);
  return raw
    .split("\n")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter(Boolean)
    .filter((ref) => ref !== "origin/HEAD" && ref !== "origin/main")
    .filter((ref) => !ref.includes("->"))
    .map((ref) => ({ ref, device: ref.replace(/^origin\//, "") }));
}

function readFileFromBranch(ref, path) {
  const r = shOk("git", ["show", `${ref}:${path}`]);
  return r.ok ? r.stdout : null;
}

function loadBookIndexFromBranch(ref) {
  const content = readFileFromBranch(ref, BOOK_INDEX_PATH);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed.version !== 2) {
      // Pre-v0.2 device — silently skip. The device just needs to upgrade
      // vibebook + run /vibebook once to get a v2 index.
      return null;
    }
    if (!parsed.chronicles || !parsed.topics || !parsed.cards) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read the device-side spool index (.vibebook/index.json). Keyed by
 *  `${tool}:${sessionId}`. Used by the raw_sessions aggregation pass
 *  added in 0.8.0 to union every device's raw .md files into main. */
function loadSpoolIndexFromBranch(ref) {
  const content = readFileFromBranch(ref, SPOOL_INDEX_PATH);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed.version !== 1 || !parsed.entries) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read the device-side memory index (.vibebook/index.memory.json).
 *  Added in 0.8.6 to union typed memory entries across devices. */
function loadMemoryIndexFromBranch(ref) {
  const content = readFileFromBranch(ref, MEMORY_INDEX_PATH);
  if (content === null) return null;
  try {
    const idx = JSON.parse(content);
    if (!idx || idx.version !== 1 || !idx.entries) return null;
    return idx;
  } catch {
    return null;
  }
}

/** Read the device-side entity index (.vibebook/index.entity.json).
 *  Mirrors loadMemoryIndexFromBranch — unions entity wiki pages across devices. */
function loadEntityIndexFromBranch(ref) {
  const content = readFileFromBranch(ref, ENTITY_INDEX_PATH);
  if (content === null) return null;
  try {
    const idx = JSON.parse(content);
    if (!idx || idx.version !== 1 || !idx.entries) return null;
    return idx;
  } catch {
    return null;
  }
}

function writeRel(relPath, content) {
  const abs = join(REPO_ROOT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------- main ----------------

function main() {
  const branches = listDeviceBranches();
  if (branches.length === 0) {
    console.log("no device branches found — nothing to aggregate");
    return;
  }
  console.log(`found ${branches.length} device branch(es): ${branches.map((b) => b.device).join(", ")}`);

  const perDevice = [];
  for (const { ref, device } of branches) {
    const bookIndex = loadBookIndexFromBranch(ref);
    if (!bookIndex) {
      console.log(`  ${device}: no v2 .vibebook/index.book.json (book aggregation skipped for this device; raw_sessions still aggregated below)`);
      continue;
    }
    perDevice.push({ ref, device, bookIndex });
  }
  // 0.8.3: don't early-return when no device has a BookIndex — the
  // raw_sessions aggregation pass below works off `.vibebook/index.json`
  // (the spool index, separate from index.book.json) and is useful
  // even before any device has run /vibebook digest. Pre-0.8.3 this
  // gated raw_sessions on books existing, so cross-device resume was
  // silently disabled until someone ran /vibebook.

  // -------- chronicles: dedup by threadId, latest updatedAt wins --------
  const chronicleByThread = new Map(); // threadId -> { ref, device, entry }
  for (const { ref, device, bookIndex } of perDevice) {
    for (const c of Object.values(bookIndex.chronicles)) {
      if (c.skip || !c.path) continue;
      const existing = chronicleByThread.get(c.threadId);
      if (!existing || c.updatedAt > existing.entry.updatedAt) {
        chronicleByThread.set(c.threadId, { ref, device, entry: c });
      }
    }
  }
  const keptChroniclePaths = [];
  for (const { ref, entry } of chronicleByThread.values()) {
    const body = readFileFromBranch(ref, entry.path);
    if (body === null) {
      console.log(`  warn: ${ref}:${entry.path} missing despite index ref; skipping`);
      continue;
    }
    writeRel(entry.path, body);
    keptChroniclePaths.push(entry.path);
  }
  console.log(`chronicles: kept ${keptChroniclePaths.length} unique threads`);

  // -------- topics: each device's rewrite preserved as <slug>.<device>.md --------
  // We never overwrite "the" topic file because two devices' rewrites diverge
  // in narrative structure and merging mechanically would garble both.
  const keptTopicPaths = [];
  for (const { ref, device, bookIndex } of perDevice) {
    for (const t of Object.values(bookIndex.topics)) {
      const body = readFileFromBranch(ref, t.path);
      if (body === null) continue;
      // book/<project>/topics/<slug>.<device>.md
      const targetPath = `book/${t.project}/topics/${t.topicSlug}.${device}.md`;
      writeRel(targetPath, body);
      keptTopicPaths.push(targetPath);
    }
  }
  console.log(`topics: wrote ${keptTopicPaths.length} per-device topic files`);

  // -------- cards: union by (project, slug); collision → latest updatedAt --------
  // _global/cards/ same rule (project="_global").
  const cardByKey = new Map(); // "<project>/<slug>" -> { ref, entry }
  for (const { ref, bookIndex } of perDevice) {
    for (const c of Object.values(bookIndex.cards)) {
      const k = `${c.project}/${c.cardSlug}`;
      const existing = cardByKey.get(k);
      if (!existing || c.updatedAt > existing.entry.updatedAt) {
        cardByKey.set(k, { ref, entry: c });
      }
    }
  }
  const keptCardPaths = [];
  for (const { ref, entry } of cardByKey.values()) {
    const body = readFileFromBranch(ref, entry.path);
    if (body === null) continue;
    writeRel(entry.path, body);
    keptCardPaths.push(entry.path);
  }
  console.log(`cards: kept ${keptCardPaths.length} unique slugs (incl. _global)`);

  // -------- raw_sessions: union by tool:sessionId, latest sourceMtimeMs wins --------
  // P7 (0.8.0): cross-device raw_sessions aggregation. Devices push only their
  // own raw_sessions/ to their device branch; main holds the union so any
  // device can `vibebook resume <id>` against any other device's session.
  // Pure copy of the (potentially encrypted) blob — CI doesn't have the
  // git-crypt smudge filter installed, so `git show` yields ciphertext as-is,
  // and we write ciphertext to main. Decryption happens on each device's
  // local checkout via the smudge filter wired in `vibebook crypt init`.
  const rawByKey = new Map(); // "tool:sessionId" -> { ref, device, entry }
  // 0.8.3: iterate `branches` (ALL device branches) instead of `perDevice`
  // (only those with v2 BookIndex). raw_sessions doesn't require book/ to
  // exist — both indices are independent.
  for (const { ref, device } of branches) {
    const spoolIdx = loadSpoolIndexFromBranch(ref);
    if (!spoolIdx) {
      console.log(`  ${device}: no v1 .vibebook/index.json — no raw_sessions to aggregate`);
      continue;
    }
    for (const e of Object.values(spoolIdx.entries)) {
      if (!e || !e.tool || !e.sessionId || !e.relativePath) continue;
      const k = `${e.tool}:${e.sessionId}`;
      const existing = rawByKey.get(k);
      if (!existing || (e.sourceMtimeMs ?? 0) > (existing.entry.sourceMtimeMs ?? 0)) {
        rawByKey.set(k, { ref, device, entry: e });
      }
    }
  }
  const keptRawPaths = [];
  const aggregatedEntries = {};
  for (const [k, { ref, device, entry }] of rawByKey.entries()) {
    const body = readFileFromBranch(ref, entry.relativePath);
    if (body === null) {
      console.log(`  warn: ${ref}:${entry.relativePath} missing despite spool index; skipping`);
      continue;
    }
    writeRel(entry.relativePath, body);
    keptRawPaths.push(entry.relativePath);
    aggregatedEntries[k] = { ...entry, originDevice: device };
  }
  console.log(`raw_sessions: kept ${keptRawPaths.length} unique sessions from ${branches.length} device branch(es)`);

  // Write the union index ONLY when at least one device had spool data.
  // Skipping the file on book-only repos (no `vibebook sync` ever run yet)
  // keeps the test's "no aggregated artifacts when no spool" guarantee.
  if (keptRawPaths.length > 0) {
    writeRel(
      AGGREGATED_INDEX_PATH,
      JSON.stringify({ version: 1, entries: aggregatedEntries }, null, 2) + "\n",
    );
  }

  // -------- memory: union by id, latest updatedAt wins (0.8.6) --------
  const memByKey = new Map(); // id -> { ref, device, entry }
  let anyMemoryIndexSeen = false;
  for (const { ref, device } of branches) {
    const memIdx = loadMemoryIndexFromBranch(ref);
    if (!memIdx) continue;
    anyMemoryIndexSeen = true;
    for (const e of Object.values(memIdx.entries)) {
      if (!e || !e.id || !e.path) continue;
      if (!isSafeMemoryPath(e.path)) {
        console.log(`memory: skipping entry ${e.id} with unsafe path ${JSON.stringify(e.path)}`);
        continue;
      }
      const relPath = e.path.split("\\").join("/");
      if (relPath.startsWith("memory/entities/")) continue;   // entity pass owns this subtree
      const existing = memByKey.get(e.id);
      if (!existing || (e.updatedAt ?? "") > (existing.entry.updatedAt ?? "")) {
        memByKey.set(e.id, { ref, device, entry: e });
      }
    }
  }
  const keptMemoryPaths = [];
  const aggregatedMemory = {};
  for (const [id, { ref, device, entry }] of memByKey.entries()) {
    const relPath = entry.path.split("\\").join("/");
    const body = readFileFromBranch(ref, relPath);
    if (body === null) continue;
    writeRel(relPath, body);
    keptMemoryPaths.push(relPath);
    aggregatedMemory[id] = { ...entry, path: relPath, originDevice: device };
  }

  // prune stale aggregated memory md (entries removed on all devices)
  // Scoped to memory/ but skips memory/_primer/ (generated, not indexed)
  // and memory/entities/ (managed by the entity pass below).
  // GUARD: only run the prune when at least one device contributed a memory
  // index this run. If anyMemoryIndexSeen is false we have no authoritative
  // view of what should exist, so wiping main's memory/ would be data loss
  // (e.g. a device that hasn't upgraded yet has no index.memory.json).
  if (anyMemoryIndexSeen) {
    const keptSet = new Set(keptMemoryPaths);
    const memDir = join(REPO_ROOT, "memory");
    if (existsSync(memDir)) {
      const stack = [memDir];
      while (stack.length) {
        const cur = stack.pop();
        let ents;
        try { ents = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const d of ents) {
          const abs = join(cur, d.name);
          if (d.isDirectory()) { stack.push(abs); continue; }
          if (!d.name.endsWith(".md")) continue;
          const rel = relative(REPO_ROOT, abs).split("\\").join("/");
          // never prune generated primers; only prune indexed memory md
          if (rel.startsWith("memory/_primer/")) continue;
          // entity files are managed exclusively by the entity pass below
          if (rel.startsWith("memory/entities/")) continue;
          if (!keptSet.has(rel)) { try { unlinkSync(abs); } catch {} }
        }
      }
    }
  }

  // Always rewrite the index when at least one device had a memory index,
  // so a fully-removed entry set produces an empty index rather than a stale one.
  if (anyMemoryIndexSeen) {
    writeRel(MEMORY_INDEX_PATH, JSON.stringify({ version: 1, entries: aggregatedMemory }, null, 2) + "\n");
  }
  console.log(`memory: kept ${keptMemoryPaths.length} entries from ${branches.length} device branch(es)`);

  // -------- entities: union by id, latest updatedAt wins --------
  // Mirrors the memory pass 1:1 but scoped to memory/entities/ and
  // reading from .vibebook/index.entity.json on each device branch.
  const entityByKey = new Map(); // id -> { ref, device, entry }
  let anyEntityIndexSeen = false;
  for (const { ref, device } of branches) {
    const entityIdx = loadEntityIndexFromBranch(ref);
    if (!entityIdx) continue;
    anyEntityIndexSeen = true;
    for (const e of Object.values(entityIdx.entries)) {
      if (!e || !e.id || !e.path) continue;
      if (!isSafeEntityPath(e.path)) {
        console.log(`entities: skipping entry ${e.id} with unsafe path ${JSON.stringify(e.path)}`);
        continue;
      }
      const existing = entityByKey.get(e.id);
      if (!existing || (e.updatedAt ?? "") > (existing.entry.updatedAt ?? "")) {
        entityByKey.set(e.id, { ref, device, entry: e });
      }
    }
  }
  const keptEntityPaths = [];
  const aggregatedEntities = {};
  for (const [id, { ref, device, entry }] of entityByKey.entries()) {
    const relPath = entry.path.split("\\").join("/");
    const body = readFileFromBranch(ref, relPath);
    if (body === null) continue;
    writeRel(relPath, body);
    keptEntityPaths.push(relPath);
    aggregatedEntities[id] = { ...entry, path: relPath, originDevice: device };
  }

  // prune stale entity md (entries removed on all devices)
  // Scoped exclusively to memory/entities/ — the memory pass above never touches this subtree.
  // GUARD: only run the prune when at least one device contributed an entity
  // index this run. If anyEntityIndexSeen is false, keptEntityPaths is empty
  // and running the prune would wipe ALL of main's memory/entities/ — data loss
  // (e.g. a device that hasn't upgraded yet has no index.entity.json).
  if (anyEntityIndexSeen) {
    const keptEntitySet = new Set(keptEntityPaths);
    const entityDir = join(REPO_ROOT, "memory", "entities");
    if (existsSync(entityDir)) {
      const stack = [entityDir];
      while (stack.length) {
        const cur = stack.pop();
        let ents;
        try { ents = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const d of ents) {
          const abs = join(cur, d.name);
          if (d.isDirectory()) { stack.push(abs); continue; }
          if (!d.name.endsWith(".md")) continue;
          const rel = relative(REPO_ROOT, abs).split("\\").join("/");
          if (!keptEntitySet.has(rel)) { try { unlinkSync(abs); } catch {} }
        }
      }
    }
  }

  // Always rewrite the index when at least one device had an entity index.
  if (anyEntityIndexSeen) {
    writeRel(ENTITY_INDEX_PATH, JSON.stringify({ version: 1, entries: aggregatedEntities }, null, 2) + "\n");
  }
  console.log(`entities: kept ${keptEntityPaths.length} entries from ${branches.length} device branch(es)`);

  // -------- prune --------
  pruneStale(keptChroniclePaths, keptTopicPaths, keptCardPaths, perDevice);
  pruneRawSessions(keptRawPaths);

  // -------- regen catalog --------
  // Skip when no books were aggregated — otherwise an empty book/index.md
  // gets written and the "no v2 BookIndex anywhere" test fails on a stray
  // book/ directory.
  let catalogPaths = [];
  if (perDevice.length > 0) {
    catalogPaths = regenCatalog({
      chronicles: [...chronicleByThread.values()].map((x) => x.entry),
      topics: [...perDevice.flatMap(({ device, bookIndex }) =>
        Object.values(bookIndex.topics).map((t) => ({ ...t, device }))
      )],
      cards: [...cardByKey.values()].map((x) => x.entry),
      devices: perDevice.map((x) => x.device),
    });
    console.log(`catalog: wrote ${catalogPaths.length} files`);
  }

  // -------- commit --------
  // Build add list dynamically: book/, raw_sessions/, and
  // .vibebook/index.aggregated.json each only exist when at least one
  // device contributed to the corresponding aggregation. `git add` on a
  // non-existent path is a hard error, so we gate per-path.
  const addPaths = [];
  if (existsSync(join(REPO_ROOT, "book"))) addPaths.push("book/");
  if (existsSync(join(REPO_ROOT, "raw_sessions"))) addPaths.push("raw_sessions/");
  if (existsSync(join(REPO_ROOT, AGGREGATED_INDEX_PATH))) addPaths.push(AGGREGATED_INDEX_PATH);
  if (existsSync(join(REPO_ROOT, "memory"))) addPaths.push("memory/");
  if (existsSync(join(REPO_ROOT, MEMORY_INDEX_PATH))) addPaths.push(MEMORY_INDEX_PATH);
  if (existsSync(join(REPO_ROOT, ENTITY_INDEX_PATH))) addPaths.push(ENTITY_INDEX_PATH);
  if (addPaths.length === 0) {
    console.log("nothing to aggregate (no books, no raw_sessions)");
    return;
  }
  sh("git", ["add", ...addPaths]);
  const status = sh("git", ["status", "--porcelain"]);
  if (!status.trim()) {
    console.log("no changes to commit");
    return;
  }
  const msg = `vibebook aggregate: ${chronicleByThread.size} chronicles, ${keptTopicPaths.length} topic-versions, ${cardByKey.size} cards, ${keptRawPaths.length} raw_sessions, +${keptMemoryPaths.length} memory, +${keptEntityPaths.length} entities across ${branches.length} device(s)`;
  sh("git", ["commit", "-m", JSON.stringify(msg)]);
  console.log(`committed: ${msg}`);
}

// ---------------- pruning ----------------

/**
 * Remove main-side files no live device claims.
 *
 * Without pruning, deleting a chronicle / topic / card on a device wouldn't
 * propagate to main — files would accumulate as ghosts. We rebuild the
 * "live" set from the kept paths above, then walk main's book/<proj>/
 * subdirs and delete anything not in that set.
 *
 * For per-device topic files (<slug>.<device>.md), we additionally delete
 * topic files whose device suffix isn't in the current `liveDevices` list,
 * so retiring a device cleans up its old topic forks.
 */
function pruneStale(chroniclePaths, topicPaths, cardPaths, perDevice) {
  const liveSet = new Set([...chroniclePaths, ...topicPaths, ...cardPaths]);
  const liveDevices = new Set(perDevice.map((d) => d.device));
  const bookRoot = join(REPO_ROOT, "book");
  if (!existsSync(bookRoot)) return;

  for (const projectName of readdirSync(bookRoot)) {
    if (projectName === "_meta") continue;
    const projDir = join(bookRoot, projectName);
    if (!statSync(projDir).isDirectory()) continue;

    pruneSubdir(projDir, "chronicle", liveSet);
    pruneSubdir(projDir, "cards", liveSet);
    // For topics, also enforce device suffix: <slug>.<device>.md
    pruneTopicsDir(projDir, liveSet, liveDevices, projectName);
  }
}

function pruneSubdir(projDir, sub, liveSet) {
  const dir = join(projDir, sub);
  if (!existsSync(dir)) return;
  const proj = projDir.split("/").pop();
  for (const name of readdirSync(dir)) {
    const rel = `book/${proj}/${sub}/${name}`;
    if (!liveSet.has(rel)) {
      rmSync(join(dir, name), { force: true });
    }
  }
}

/**
 * Walk raw_sessions/ on main and remove any .md not in the kept set. Same
 * intent as pruneStale but for the cross-device raw_sessions aggregation
 * (P7). Sweeps now-empty parent directories so a device retiring
 * doesn't leave its <tool>/<project>/<date>/ skeleton behind.
 */
function pruneRawSessions(keptRawPaths) {
  const liveSet = new Set(keptRawPaths);
  const rawRoot = join(REPO_ROOT, "raw_sessions");
  if (!existsSync(rawRoot)) return;
  const dirsTouched = new Set();
  const stack = [rawRoot];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        const rel = abs.slice(REPO_ROOT.length + 1);
        if (!liveSet.has(rel)) {
          rmSync(abs, { force: true });
          dirsTouched.add(dirname(abs));
        }
      }
    }
  }
  // Sweep empty dirs upward from each touched dir.
  for (const d of dirsTouched) {
    let cur = d;
    while (cur.startsWith(rawRoot) && cur !== rawRoot) {
      let entries = [];
      try { entries = readdirSync(cur); } catch { break; }
      if (entries.length > 0) break;
      try { rmSync(cur, { recursive: false, force: true }); } catch { break; }
      cur = dirname(cur);
    }
  }
}

function pruneTopicsDir(projDir, liveSet, _liveDevices, projectName) {
  const dir = join(projDir, "topics");
  if (!existsSync(dir)) return;
  // liveSet already encodes which <slug>.<device>.md files this run produced;
  // anything else (retired-device leftovers, stale slugs) is stale. Don't
  // pattern-match the device suffix — device names contain dots ("Mac.lan").
  for (const name of readdirSync(dir)) {
    const rel = `book/${projectName}/topics/${name}`;
    if (!liveSet.has(rel)) rmSync(join(dir, name), { force: true });
  }
}

// ---------------- catalog regen ----------------

/**
 * Render book/index.md + book/_meta/timeline.md + book/<project>/index.md.
 *
 * Logically duplicates src/digest/book-catalog.ts but lives here so the CI
 * yaml only needs node 20 + this file (no npm install of vibebook on every
 * workflow run).
 */
function regenCatalog({ chronicles, topics, cards, devices }) {
  const written = [];

  const chrsByProj = bucketBy(chronicles, (c) => c.project);
  const topsByProj = bucketBy(topics, (t) => t.project);
  const crdsByProj = bucketBy(cards, (c) => c.project);

  const projectSet = new Set();
  for (const p of chrsByProj.keys()) projectSet.add(p);
  for (const p of topsByProj.keys()) projectSet.add(p);
  for (const p of crdsByProj.keys()) projectSet.add(p);
  const projects = [...projectSet].sort((a, b) => {
    if (a === "_global") return 1;
    if (b === "_global") return -1;
    return a.localeCompare(b);
  });

  // Front page.
  writeRel("book/index.md", renderFront({
    projects, chrsByProj, topsByProj, crdsByProj,
    latestUpdate: latestUpdate({ chronicles, topics, cards }),
    devices,
  }));
  written.push("book/index.md");

  // Global timeline.
  writeRel("book/_meta/timeline.md", renderTimeline({ chronicles, topics, cards }));
  written.push("book/_meta/timeline.md");

  // Per-project index pages.
  for (const p of projects) {
    const path = `book/${p}/index.md`;
    writeRel(path, renderProjectIndex(p, {
      chronicles: chrsByProj.get(p) ?? [],
      topics: topsByProj.get(p) ?? [],
      cards: crdsByProj.get(p) ?? [],
    }));
    written.push(path);
  }

  return written;
}

function renderFront({ projects, chrsByProj, topsByProj, crdsByProj, latestUpdate, devices }) {
  const totalChrs = sumMap(chrsByProj);
  const totalTops = sumMap(topsByProj);
  const totalCrds = sumMap(crdsByProj);
  const t = strings();
  const lines = [];
  lines.push("---");
  lines.push(`title: ${t.notebook}`);
  lines.push(`updated: ${latestUpdate}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${t.notebook}`);
  lines.push("");
  lines.push(t.aggregatedFrom(devices.length, latestUpdate));
  lines.push("");
  lines.push(t.totals(projects.length, totalChrs, totalTops, totalCrds));
  lines.push("");
  lines.push("> Generated by `scripts/merge-books.mjs` in CI. Don't edit by hand.");
  lines.push("");
  lines.push(`**${t.devicesLabel}**: ${devices.map((d) => `\`${d}\``).join(", ")}`);
  lines.push("");
  lines.push(`## ${t.projects}`);
  lines.push("");
  for (const p of projects) {
    const chrs = chrsByProj.get(p) ?? [];
    const tops = topsByProj.get(p) ?? [];
    const crds = crdsByProj.get(p) ?? [];
    if (chrs.length === 0 && tops.length === 0 && crds.length === 0) continue;
    lines.push(`### [${p}](${p}/index.md)`);
    if (chrs.length > 0) lines.push(`- ${chrs.length} ${t.chronicles}`);
    if (tops.length > 0) {
      const slugs = [...new Set(tops.map((t) => t.topicSlug))];
      lines.push(`- ${slugs.length} ${t.topics} (${tops.length} ${t.deviceVersions})`);
    }
    if (crds.length > 0) lines.push(`- ${crds.length} ${t.cards}`);
    lines.push("");
  }
  lines.push("---");
  lines.push(`- [${t.globalTimeline}](_meta/timeline.md)`);
  lines.push("");
  return lines.join("\n");
}

function renderTimeline({ chronicles, topics, cards }) {
  const events = [];
  for (const c of chronicles) {
    events.push({ ts: c.updatedAt, line: `📝 [${c.title}](../${c.path}) — _${c.project}_ chronicle` });
  }
  for (const t of topics) {
    events.push({ ts: t.updatedAt, line: `📚 ${t.topicSlug} — _${t.project}_ topic by ${t.device}` });
  }
  for (const c of cards) {
    events.push({ ts: c.updatedAt, line: `💡 [${c.cardSlug}](../${c.path}) — _${c.project}_ ${c.type} card` });
  }
  events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const t = strings();
  const lines = [];
  lines.push(`# ${t.globalTimeline}`);
  lines.push("");
  lines.push("Newest first across every project + device.");
  lines.push("");
  let lastDate = "";
  for (const e of events) {
    const date = (e.ts || "").slice(0, 10);
    if (date !== lastDate) { lines.push(""); lines.push(`## ${date}`); lines.push(""); lastDate = date; }
    lines.push(`- ${e.line}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Pick a locale-specific string table for the rendered book pages.
 * Driven by VIBEBOOK_LOCALE env var (set by the workflow from config.bookLocale).
 * Defaults to "en". Falls back to "en" on any unknown locale.
 */
function strings() {
  const locale = (process.env.VIBEBOOK_LOCALE || "en").toLowerCase();
  if (locale === "zh") return STRINGS_ZH;
  return STRINGS_EN;
}

const STRINGS_EN = {
  notebook: "notebook",
  aggregatedFrom: (n, ts) => `Aggregated from ${n} device${n === 1 ? "" : "s"} · updated ${ts}`,
  totals: (p, ch, tp, cd) =>
    `${p} project${p === 1 ? "" : "s"} · ${ch} chronicle${ch === 1 ? "" : "s"} · ${tp} topic${tp === 1 ? "" : "s"} · ${cd} card${cd === 1 ? "" : "s"}`,
  devicesLabel: "Devices",
  projects: "Projects",
  chronicles: "chronicle(s)",
  topics: "topic(s)",
  deviceVersions: "device-version(s)",
  cards: "card(s)",
  globalTimeline: "Global timeline",
};

const STRINGS_ZH = {
  notebook: "笔记本",
  aggregatedFrom: (n, ts) => `聚合自 ${n} 台设备 · 更新于 ${ts}`,
  totals: (p, ch, tp, cd) => `${p} 项目 · ${ch} 篇流水账 · ${tp} 个 topic · ${cd} 张卡片`,
  devicesLabel: "设备",
  projects: "项目",
  chronicles: "篇流水账",
  topics: "个 topic",
  deviceVersions: "个 device-versions",
  cards: "张卡片",
  globalTimeline: "全局时间线",
};

function renderProjectIndex(project, args) {
  const chrs = (args.chronicles ?? []).filter((c) => !c.skip && c.path);
  const tops = args.topics ?? [];
  const crds = args.cards ?? [];
  const lines = [];
  lines.push("---");
  lines.push(`title: ${project}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${project}`);
  lines.push("");
  lines.push(`${chrs.length} chronicles · ${new Set(tops.map((t) => t.topicSlug)).size} topics · ${crds.length} cards`);
  lines.push("");
  if (tops.length > 0) {
    const bySlug = bucketBy(tops, (t) => t.topicSlug);
    lines.push("## Topics (per-device versions)");
    lines.push("");
    for (const [slug, list] of [...bySlug.entries()].sort()) {
      const versions = list.map((v) => `[${v.device}](topics/${slug}.${v.device}.md)`).join(" · ");
      lines.push(`- **${slug}**: ${versions}`);
    }
    lines.push("");
  }
  if (chrs.length > 0) {
    lines.push("## Chronicles (newest first)");
    lines.push("");
    for (const c of [...chrs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))) {
      lines.push(`- [${c.title}](chronicle/${baseName(c.path)}) — ${c.updatedAt}`);
    }
    lines.push("");
  }
  if (crds.length > 0) {
    lines.push("## Cards");
    lines.push("");
    const byType = bucketBy(crds, (c) => c.type);
    for (const [type, list] of [...byType.entries()].sort()) {
      lines.push(`### ${type}`);
      for (const c of list.sort((a, b) => a.cardSlug.localeCompare(b.cardSlug))) {
        lines.push(`- [${c.cardSlug}](cards/${c.cardSlug}.md)`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function bucketBy(xs, key) {
  const m = new Map();
  for (const x of xs) {
    const k = key(x);
    let arr = m.get(k);
    if (!arr) { arr = []; m.set(k, arr); }
    arr.push(x);
  }
  return m;
}

function sumMap(m) {
  let n = 0;
  for (const list of m.values()) n += list.length;
  return n;
}

function latestUpdate({ chronicles, topics, cards }) {
  const ts = [];
  for (const c of chronicles) ts.push(c.updatedAt);
  for (const t of topics) ts.push(t.updatedAt);
  for (const c of cards) ts.push(c.updatedAt);
  if (ts.length === 0) return "—";
  ts.sort();
  return ts[ts.length - 1].slice(0, 10);
}

function baseName(path) {
  const ix = path.lastIndexOf("/");
  return ix < 0 ? path : path.slice(ix + 1);
}

main();
