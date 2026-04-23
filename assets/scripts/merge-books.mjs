#!/usr/bin/env node
// Aggregate every device branch's book/ into main.
//
// Called from .github/workflows/vibebook-aggregate.yml — checked-in on main,
// runs on every push to a non-main branch. Purely mechanical; never touches
// an LLM. The LLM work happens locally on each device's `vibebook sync`.
//
// Algorithm:
//   1. List remote device branches (refs/remotes/origin/*, minus main and HEAD).
//   2. For each, read its BookIndex (.vibebook/index.book.json) via `git show`.
//      Skip branches that don't have one.
//   3. Collect every publishable article (ok && !skip && articlePath). Group
//      by threadId; keep the latest-updatedAt version per thread.
//   4. For each kept article, `git show <branch>:<articlePath>` → write to
//      main's worktree at the same path. Prune any book/<project>/articles/*
//      files in main that don't appear in the merged set.
//   5. For each (branch, project) chapter.md, copy to
//      book/<project>/chapter.<device>.md so readers can see each device's
//      take on the project without one overwriting another.
//   6. Regenerate book/index.md + book/_meta/timeline.md from the merged data.
//   7. git add book/ + commit (no-op if nothing changed).
//
// The caller (yaml step) takes care of `git push`.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const BOOK_INDEX_PATH = ".vibebook/index.book.json";

function sh(cmd, args) {
  // Returns stdout as a string; throws on non-zero exit.
  return execSync([cmd, ...args].join(" "), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function shOk(cmd, args) {
  // Returns { ok, stdout } — doesn't throw.
  try {
    return { ok: true, stdout: sh(cmd, args) };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err.stderr ?? "") };
  }
}

/** List device branches on origin, excluding main and HEAD. */
function listDeviceBranches() {
  const raw = sh("git", ["for-each-ref", "--format='%(refname:short)'", "refs/remotes/origin/"]);
  return raw
    .split("\n")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter(Boolean)
    .filter((ref) => ref !== "origin/HEAD" && ref !== "origin/main")
    .filter((ref) => !ref.includes("->"))  // skip "origin/HEAD -> origin/main" style
    .map((ref) => ({
      ref,
      device: ref.replace(/^origin\//, ""),
    }));
}

/** Read a file from a branch via `git show`. Returns null if it doesn't exist. */
function readFileFromBranch(ref, path) {
  const r = shOk("git", ["show", `${ref}:${path}`]);
  return r.ok ? r.stdout : null;
}

/** Parse BookIndex from a branch. Returns null if missing / malformed. */
function loadBookIndexFromBranch(ref) {
  const content = readFileFromBranch(ref, BOOK_INDEX_PATH);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed.version !== 1 || !parsed.threads || !parsed.chapters) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Publishable = ok and not skipped and has a path. */
function isPublishable(entry) {
  return entry.articleStatus === "ok" && !entry.skip && entry.articlePath && entry.articlePath !== "";
}

/** Group entries by threadId across devices; keep the latest by updatedAt. */
function dedupeByThreadLatestWins(perDevice) {
  const best = new Map(); // threadId -> { entry, device, ref }
  for (const { ref, device, bookIndex } of perDevice) {
    for (const entry of Object.values(bookIndex.threads)) {
      if (!isPublishable(entry)) continue;
      const existing = best.get(entry.threadId);
      if (!existing || entry.updatedAt > existing.entry.updatedAt) {
        best.set(entry.threadId, { entry, device, ref });
      }
    }
  }
  return [...best.values()];
}

/** Write content to repoRoot/relPath, creating dirs as needed. */
function writeRel(relPath, content) {
  const abs = join(REPO_ROOT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Delete any book/<project>/articles/* files in main that are NOT in keepPaths. */
function pruneStaleArticles(keepPaths) {
  const keepSet = new Set(keepPaths);
  const articlesRoot = join(REPO_ROOT, "book");
  if (!existsSync(articlesRoot)) return;
  for (const project of readdirSync(articlesRoot)) {
    const projDir = join(articlesRoot, project);
    if (project === "_meta" || !statSync(projDir).isDirectory()) continue;
    const articlesDir = join(projDir, "articles");
    if (!existsSync(articlesDir)) continue;
    for (const name of readdirSync(articlesDir)) {
      const relPath = join("book", project, "articles", name).replace(/\\/g, "/");
      if (!keepSet.has(relPath)) {
        rmSync(join(articlesDir, name), { force: true });
      }
    }
  }
}

/** Delete chapter.<device>.md files that no longer correspond to a live device. */
function pruneStaleChapters(liveDevices) {
  const liveSet = new Set(liveDevices);
  const bookRoot = join(REPO_ROOT, "book");
  if (!existsSync(bookRoot)) return;
  for (const project of readdirSync(bookRoot)) {
    if (project === "_meta") continue;
    const projDir = join(bookRoot, project);
    if (!statSync(projDir).isDirectory()) continue;
    for (const name of readdirSync(projDir)) {
      const m = name.match(/^chapter\.(.+)\.md$/);
      if (!m) continue;
      if (!liveSet.has(m[1])) {
        rmSync(join(projDir, name), { force: true });
      }
    }
  }
}

/** Render book/index.md from the merged view. */
function renderBookIndex({ projects, articleCountByProject, chapterDevicesByProject, totalArticles, totalDevices, latestUpdatedAt }) {
  const lines = [];
  lines.push("# Book index");
  lines.push("");
  lines.push(`Aggregated across ${totalDevices} device(s). ${totalArticles} articles across ${projects.length} project(s). Last updated: ${latestUpdatedAt}.`);
  lines.push("");
  lines.push("> Generated by `scripts/merge-books.mjs` in GitHub Actions. Do not edit by hand.");
  lines.push("");
  lines.push("## Chapters");
  lines.push("");
  for (const p of projects) {
    const n = articleCountByProject.get(p) ?? 0;
    const devices = chapterDevicesByProject.get(p) ?? [];
    const chapterLinks = devices.length > 0
      ? devices.map((d) => `[${d}](./${p}/chapter.${d}.md)`).join(", ")
      : "_(no chapter)_";
    lines.push(`- **${p}** — ${n} article(s) • chapter by: ${chapterLinks}`);
  }
  lines.push("");
  lines.push("See [`_meta/timeline.md`](./_meta/timeline.md) for the global timeline.");
  lines.push("");
  return lines.join("\n");
}

/** Render book/_meta/timeline.md from all kept entries, newest first. */
function renderGlobalTimeline(entries) {
  const lines = [];
  lines.push("# Timeline");
  lines.push("");
  lines.push("Every article across every device, newest first.");
  lines.push("");
  const sorted = [...entries].sort((a, b) => (a.entry.updatedAt < b.entry.updatedAt ? 1 : -1));
  let lastDate = "";
  for (const { entry, device } of sorted) {
    const date = entry.updatedAt.slice(0, 10);
    if (date !== lastDate) {
      lines.push("");
      lines.push(`## ${date}`);
      lines.push("");
      lastDate = date;
    }
    const title = escapeMd(entry.title || entry.threadId);
    const path = entry.articlePath;
    lines.push(`- [${title}](../${relative("book", path).replace(/\\/g, "/")}) — _${entry.project}_ • ${device}`);
  }
  lines.push("");
  return lines.join("\n");
}

function escapeMd(s) {
  return String(s).replace(/([\[\]\\])/g, "\\$1");
}

// -------------------- main --------------------

function main() {
  const branches = listDeviceBranches();
  if (branches.length === 0) {
    console.log("no device branches found — nothing to aggregate");
    return;
  }
  console.log(`found ${branches.length} device branch(es):`, branches.map((b) => b.device).join(", "));

  const perDevice = [];
  for (const { ref, device } of branches) {
    const bookIndex = loadBookIndexFromBranch(ref);
    if (!bookIndex) {
      console.log(`  skip ${device}: no .vibebook/index.book.json`);
      continue;
    }
    perDevice.push({ ref, device, bookIndex });
  }
  if (perDevice.length === 0) {
    console.log("no device branch had a BookIndex — nothing to aggregate");
    return;
  }

  // Step 3: dedupe articles by threadId, latest updatedAt wins.
  const kept = dedupeByThreadLatestWins(perDevice);
  console.log(`merged to ${kept.length} unique article(s)`);

  // Step 4: copy article files + prune stale.
  const keepPaths = [];
  for (const { ref, entry } of kept) {
    const body = readFileFromBranch(ref, entry.articlePath);
    if (body === null) {
      console.log(`  warn: ${ref}:${entry.articlePath} missing despite BookEntry; skipping`);
      continue;
    }
    writeRel(entry.articlePath, body);
    keepPaths.push(entry.articlePath);
  }
  pruneStaleArticles(keepPaths);

  // Step 5: per-device chapters.
  const liveDevices = [];
  const chapterDevicesByProject = new Map();
  const projectSet = new Set();
  for (const { ref, device, bookIndex } of perDevice) {
    liveDevices.push(device);
    for (const project of Object.keys(bookIndex.chapters)) {
      projectSet.add(project);
      const chapterBody = readFileFromBranch(ref, `book/${project}/chapter.md`);
      if (chapterBody === null) continue;
      writeRel(`book/${project}/chapter.${device}.md`, chapterBody);
      const arr = chapterDevicesByProject.get(project) ?? [];
      arr.push(device);
      chapterDevicesByProject.set(project, arr);
    }
    // Add projects found via article entries too, even if there's no chapter.
    for (const e of Object.values(bookIndex.threads)) {
      if (isPublishable(e)) projectSet.add(e.project);
    }
  }
  pruneStaleChapters(liveDevices);

  // Step 6: regen book/index.md + book/_meta/timeline.md.
  const projects = [...projectSet].sort();
  const articleCountByProject = new Map();
  for (const p of projects) articleCountByProject.set(p, 0);
  for (const { entry } of kept) {
    articleCountByProject.set(entry.project, (articleCountByProject.get(entry.project) ?? 0) + 1);
  }
  let latestUpdatedAt = "—";
  for (const { entry } of kept) {
    if (entry.updatedAt > latestUpdatedAt) latestUpdatedAt = entry.updatedAt;
  }
  writeRel("book/index.md", renderBookIndex({
    projects,
    articleCountByProject,
    chapterDevicesByProject,
    totalArticles: kept.length,
    totalDevices: perDevice.length,
    latestUpdatedAt,
  }));
  writeRel("book/_meta/timeline.md", renderGlobalTimeline(kept));

  // Step 7: commit.
  sh("git", ["add", "book/"]);
  const statusOut = sh("git", ["status", "--porcelain"]);
  if (!statusOut.trim()) {
    console.log("no changes to commit");
    return;
  }
  const msg = `vibebook aggregate: ${kept.length} articles across ${perDevice.length} device(s)`;
  sh("git", ["commit", "-m", JSON.stringify(msg)]);
  console.log(`committed: ${msg}`);
}

main();
