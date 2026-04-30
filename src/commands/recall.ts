import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readConfig } from "../config.js";
import { loadBookIndexV2 } from "../digest/book-index-v2.js";
import { resolveProjectFromCwd } from "../project-resolve.js";
import { projectSlugFromPath } from "../slug.js";

/**
 * `vibebook recall` — three-stage progressive catalog.
 *
 * Stage 1 (default, ~2-5 KB): a project's TOPIC LIST plus 1-line
 * descriptions. The agent looks at this first to find which subsystem(s)
 * its task touches. Chronicles are NOT listed here — there are too many
 * (typical project: 50+ chronicles), and they aren't the right grain
 * for "is this relevant?" triage.
 *
 * Stage 2 (--topic <slug>, ~5-15 KB): for one chosen topic, list its
 * contributing CHRONICLES with frontmatter (title, files_touched,
 * commits, decisions, blockers, status). The agent reads the
 * frontmatter to decide which chronicles to fully Read.
 *
 * Stage 3: the agent uses the `Read` tool directly on a chronicle's
 * absolute path. No extra recall command needed.
 *
 * Memex integration (optional): when `memex` is on PATH, the stage-1
 * output additionally folds in memex categories from `memex read index`
 * so the agent sees the full atomic-card landscape too. Memex cards
 * are surfaced as `kind: "memex-card"` entries with `path: "memex:<slug>"`
 * so the agent knows to read them via `memex read <slug>`.
 */

export interface RecallEntry {
  /** topic | chronicle | memex-card.
   *  In stage 1 (default), only `topic` and `memex-card` entries appear.
   *  In stage 2 (--topic), `chronicle` entries appear with frontmatter. */
  kind: "topic" | "chronicle" | "memex-card";
  /** Project slug ("_memex" for memex-card entries). */
  project: string;
  /** Display title (frontmatter title → first `# heading` → slug). */
  title: string;
  /** Short summary — for topics: 1 sentence from the topic body.
   *  For chronicles: a synthesized line from frontmatter facts.
   *  For memex-card: the line memex's own index gave us. */
  summary: string;
  /** Absolute path the agent should pass to `Read`.
   *  For memex-card entries this is `memex:<slug>` — agent runs
   *  `memex read <slug>` instead of using the Read tool. */
  path: string;
  /** Stable id within its kind: topicSlug / threadId / cardSlug. */
  slug: string;
  /** Frontmatter facts that the agent triages on (chronicles only).
   *  Only populated in stage 2. */
  frontmatter?: ChronicleFrontmatter;
  /** ISO date — last write. */
  updatedAt: string;
  /** Tags from BookIndex / topic frontmatter. */
  tags: string[];
}

/** Subset of chronicle frontmatter the recall payload surfaces.
 *  Mirrors the AI-first fields documented in
 *  `skills/vibebook/references/chronicle-format.md`. */
export interface ChronicleFrontmatter {
  files_touched?: string[];
  commits?: string[];
  decisions?: string[];
  blockers?: string[];
  next_steps?: string[];
  status?: string;
}

export interface RecallPayload {
  /** "stage-1-topics" or "stage-2-articles". Tells the consumer how to
   *  interpret the entries. */
  stage: "stage-1-topics" | "stage-2-articles";
  /** Project the catalog scopes to (null when --all). */
  project: string | null;
  /** Topic slug being expanded in stage 2 (null otherwise). */
  topic: string | null;
  /** Absolute path the LLM should pass to `Read` for chronicle bodies. */
  repoPath: string;
  entries: RecallEntry[];
  meta: {
    topics: number;
    chronicles: number;
    memexCards?: number;
    cwdUnresolved?: boolean;
    memexQueried?: boolean;
    /** Hint shown by the recall skill when the agent should drill
     *  into a topic next. */
    nextStep?: string;
  };
}

export interface RecallOptions {
  cwd?: string;
  project?: string;
  /** Stage 2: list chronicles for this topic (project must also be set
   *  or resolvable from cwd). */
  topic?: string;
  /** Catalog every project (no filter). Use sparingly — at scale this
   *  blows past the 30 KB stage-1 budget. */
  all?: boolean;
  /** Skip the memex source even if memex is available. */
  noMemex?: boolean;
}

export function buildRecallPayload(opts: RecallOptions = {}): RecallPayload {
  const cfg = readConfig();
  const bookIndex = loadBookIndexV2(cfg.repoPath);

  let projectFilter: string | null = opts.project?.trim() || null;
  let cwdUnresolved = false;
  if (!projectFilter && !opts.all && opts.cwd) {
    projectFilter = resolveProjectFromCwd(opts.cwd, cfg.repoPath);
    if (!projectFilter) {
      cwdUnresolved = true;
    }
  }

  // Stage 2 — chronicle list for one topic.
  if (opts.topic) {
    return buildStage2(cfg.repoPath, bookIndex, projectFilter, opts.topic, opts.noMemex !== true && !cwdUnresolved);
  }

  // Stage 1 — topic list (+ optional memex).
  return buildStage1(cfg.repoPath, bookIndex, projectFilter, cwdUnresolved, opts.noMemex !== true);
}

// ---------- stage 1: topic list ----------

function buildStage1(
  repoPath: string,
  bookIndex: ReturnType<typeof loadBookIndexV2>,
  projectFilter: string | null,
  cwdUnresolved: boolean,
  queryMemex: boolean,
): RecallPayload {
  const entries: RecallEntry[] = [];

  for (const t of Object.values(bookIndex.topics)) {
    const project = t.project || projectFromPath(t.path);
    if (!project) continue;
    if (projectFilter && project !== projectFilter) continue;
    entries.push({
      kind: "topic",
      project,
      title: titleForArtifact(repoPath, t.path, t.topicSlug),
      summary: summaryFor(repoPath, t.path),
      path: t.path,
      slug: t.topicSlug,
      updatedAt: t.updatedAt,
      tags: [],
    });
  }

  let memexQueried = false;
  if (queryMemex) {
    const memexEntries = loadMemexCatalog();
    if (memexEntries !== null) {
      memexQueried = true;
      entries.push(...memexEntries);
    }
  }

  // Sort: memex-cards first (zero-cost recall when an agent already knows
  // the gotcha exists), then topics (newest first).
  const kindOrder: Record<RecallEntry["kind"], number> = {
    "memex-card": 0, topic: 1, chronicle: 2,
  };
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return kindOrder[a.kind] - kindOrder[b.kind];
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });

  const topicCount = entries.filter((e) => e.kind === "topic").length;
  const memexCount = entries.filter((e) => e.kind === "memex-card").length;
  return {
    stage: "stage-1-topics",
    project: projectFilter,
    topic: null,
    repoPath,
    entries,
    meta: {
      topics: topicCount,
      chronicles: 0,
      ...(memexQueried ? { memexQueried, memexCards: memexCount } : {}),
      ...(cwdUnresolved ? { cwdUnresolved: true } : {}),
      nextStep: topicCount > 0
        ? `Pick a relevant topic, then run: vibebook recall --project <slug> --topic <topicSlug>`
        : "No topics yet for this project.",
    },
  };
}

// ---------- stage 2: chronicle list for one topic ----------

function buildStage2(
  repoPath: string,
  bookIndex: ReturnType<typeof loadBookIndexV2>,
  projectFilter: string | null,
  topicSlug: string,
  queryMemex: boolean,
): RecallPayload {
  const entries: RecallEntry[] = [];

  // Find the topic so we know which contributing chronicles to surface.
  const topic = Object.values(bookIndex.topics).find((t) => {
    const proj = t.project || projectFromPath(t.path);
    return t.topicSlug === topicSlug && (!projectFilter || proj === projectFilter);
  });

  if (topic) {
    const contributing = new Set(topic.contributingThreads ?? []);
    for (const c of Object.values(bookIndex.chronicles)) {
      if (c.skip) continue;
      if (!contributing.has(c.threadId)) continue;
      const project = c.project || projectFromPath(c.path) || "_unknown";
      const fm = readChronicleFrontmatter(repoPath, c.path);
      entries.push({
        kind: "chronicle",
        project,
        title: titleForArtifact(repoPath, c.path, c.title || c.threadId),
        summary: summarizeFrontmatter(fm),
        path: join(repoPath, c.path),
        slug: c.threadId,
        frontmatter: fm,
        updatedAt: c.updatedAt,
        tags: c.tags ?? [],
      });
    }
  }

  let memexQueried = false;
  if (queryMemex) {
    const memexEntries = loadMemexCatalog();
    if (memexEntries !== null) {
      memexQueried = true;
      // In stage 2 we still surface memex cards because they may be the
      // most relevant atomic insight for the topic at hand. Filter to
      // those whose category matches the topic loosely; if no match,
      // surface all (don't drop info just to keep payload small).
      const filtered = memexEntries.filter((m) =>
        m.tags.some((tag) => tag.toLowerCase().includes(topicSlug.toLowerCase())),
      );
      entries.push(...(filtered.length > 0 ? filtered : memexEntries));
    }
  }

  // Sort chronicles newest first; keep memex cards separate at top.
  const kindOrder: Record<RecallEntry["kind"], number> = {
    "memex-card": 0, chronicle: 1, topic: 2,
  };
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return kindOrder[a.kind] - kindOrder[b.kind];
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });

  return {
    stage: "stage-2-articles",
    project: projectFilter,
    topic: topicSlug,
    repoPath,
    entries,
    meta: {
      topics: 0,
      chronicles: entries.filter((e) => e.kind === "chronicle").length,
      ...(memexQueried ? { memexQueried, memexCards: entries.filter((e) => e.kind === "memex-card").length } : {}),
      nextStep: "Read full bodies via the Read tool on entry.path. For memex cards: `memex read <slug>`.",
    },
  };
}

// ---------- helpers ----------

function projectFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "book") return null;
  return parts[1] || null;
}

function titleForArtifact(repoPath: string, repoRel: string, fallback: string): string {
  const abs = join(repoPath, repoRel);
  if (!existsSync(abs)) return fallback;
  const head = readFileSync(abs, "utf8").slice(0, 1024);
  const hMatch = head.match(/^#\s+(.+?)\s*$/m);
  if (hMatch) return hMatch[1].trim();
  const fmMatch = head.match(/^---[\s\S]*?\ntitle:\s*(.+?)\s*\n[\s\S]*?---/);
  if (fmMatch) return fmMatch[1].replace(/^["']|["']$/g, "").trim();
  return fallback;
}

function summaryFor(repoPath: string, repoRel: string): string {
  const abs = join(repoPath, repoRel);
  if (!existsSync(abs)) return "";
  const body = readFileSync(abs, "utf8");
  const stripped = body.replace(/^---[\s\S]*?---\s*\n/, "");
  const lines = stripped.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith("---")) continue;
    if (line.startsWith("- ") || line.startsWith("* ")) continue;
    if (line.startsWith(">") || line.startsWith("```")) continue;
    const plain = line
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
    return plain.length > 200 ? plain.slice(0, 200) + "…" : plain;
  }
  return "";
}

/** Parse the AI-first frontmatter fields out of a chronicle md.
 *  Tiny line-based YAML subset parser: supports `key: scalar` and
 *  `key:\n  - item\n  - item` shapes. Avoids pulling in a full YAML
 *  dep just for the recall payload's narrow needs. */
function readChronicleFrontmatter(repoPath: string, repoRel: string): ChronicleFrontmatter {
  const abs = join(repoPath, repoRel);
  if (!existsSync(abs)) return {};
  const body = readFileSync(abs, "utf8");
  const m = body.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};

  const lines = m[1].split("\n");
  const result: ChronicleFrontmatter = {};
  const lists: Record<string, string[]> = {};
  let currentList: string | null = null;

  // Walk line-by-line so list items only attach to the key whose block
  // they're under (regex-only approach over-matched into sibling keys).
  for (const raw of lines) {
    const line = raw;
    if (line.match(/^\s+-\s+/)) {
      // List item: belongs to currentList if we're under one.
      if (currentList) {
        const item = line.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, "");
        if (item) lists[currentList]!.push(item);
      }
      continue;
    }
    // Top-level key.
    const m2 = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!m2) {
      currentList = null;
      continue;
    }
    const key = m2[1];
    const after = m2[2].trim();
    if (after === "") {
      // List or block scalar.
      currentList = key;
      lists[key] = [];
    } else {
      currentList = null;
      // Scalar value.
      const cleaned = after.replace(/^["']|["']$/g, "");
      if (key === "status") result.status = cleaned;
    }
  }

  if (lists.files_touched) result.files_touched = lists.files_touched;
  if (lists.commits) result.commits = lists.commits;
  if (lists.decisions) result.decisions = lists.decisions;
  if (lists.blockers) result.blockers = lists.blockers;
  if (lists.next_steps) result.next_steps = lists.next_steps;
  return result;
}

function summarizeFrontmatter(fm: ChronicleFrontmatter): string {
  const bits: string[] = [];
  if (fm.status) bits.push(`status=${fm.status}`);
  if (fm.files_touched?.length) bits.push(`${fm.files_touched.length} files`);
  if (fm.commits?.length) bits.push(`${fm.commits.length} commits`);
  if (fm.decisions?.length) bits.push(`${fm.decisions.length} decisions`);
  if (fm.blockers?.length) bits.push(`${fm.blockers.length} blockers`);
  return bits.join(" · ") || "(no AI-first frontmatter — legacy chronicle)";
}

function typeFromSlug(slug: string): "gotcha" | "pattern" | "decision" | "howto" | "tool" | "other" {
  const m = slug.match(/^(gotcha|pattern|decision|howto|tool)-/);
  if (m) return m[1] as "gotcha" | "pattern" | "decision" | "howto" | "tool";
  return "other";
}

function prettifySlug(slug: string): string {
  const stripped = slug.replace(/^(gotcha|pattern|decision|howto|tool)-/, "");
  const spaced = stripped.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** CLI entry: print payload as JSON to stdout. */
export async function recallCmd(opts: RecallOptions): Promise<void> {
  const payload = buildRecallPayload(opts);
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

void projectSlugFromPath;
void typeFromSlug;  // exported through parseMemexIndex via memex-card type

// ---------- memex source ----------

function loadMemexCatalog(): RecallEntry[] | null {
  const r = spawnSync("memex", ["read", "index"], {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error || r.status !== 0) return null;
  return parseMemexIndex(r.stdout);
}

export function parseMemexIndex(md: string): RecallEntry[] {
  const out: RecallEntry[] = [];
  const today = new Date().toISOString().slice(0, 10);
  let category = "_memex";
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const catMatch = line.match(/^##\s+(.+?)\s*$/);
    if (catMatch) {
      category = catMatch[1].trim();
      continue;
    }
    const linkMatch = line.match(/^[-*]\s+\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\](?:\s*[—\-:]\s*(.+))?\s*$/);
    if (!linkMatch) continue;
    const slug = linkMatch[1].trim();
    const altText = linkMatch[2]?.trim();
    const summary = (linkMatch[3] ?? "").trim();
    out.push({
      kind: "memex-card",
      project: "_memex",
      title: altText || prettifySlug(slug),
      summary,
      path: `memex:${slug}`,
      slug,
      updatedAt: today,
      tags: category && category !== "_memex" ? [category] : [],
    });
  }
  return out;
}
