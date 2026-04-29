import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readConfig } from "../config.js";
import { loadBookIndexV2 } from "../digest/book-index-v2.js";
import { resolveProjectFromCwd } from "../project-resolve.js";
import { projectSlugFromPath } from "../slug.js";

/**
 * `vibebook recall` — emit a *lightweight catalog* of the current project's
 * book artifacts so an in-session Claude (in any project repo) can decide
 * "do I have notes that bear on this work?" without slurping every
 * chronicle/topic/card body into context.
 *
 * Two modes:
 *   - cwd-mode (default): catalog the project matching the user's cwd.
 *     Includes `_global` cards because they apply everywhere.
 *   - --all: emit every project's catalog (rare; for "I want to grep my
 *     entire history" workflows).
 *
 * The payload is intentionally compact: title + 1-line summary + path
 * + tags + type + updatedAt. ~100-300 bytes per artifact. The caller
 * (a recall skill, or `/vibebook-recall` slash command) reads this, picks
 * relevant entries, then `Read`s the full md for the ones it needs.
 *
 * Why not just dump every body? A typical project has 50-150 artifacts;
 * full bodies = 200K-1M tokens, which would dominate the in-session
 * Claude's context. Catalog + selective Read is the right shape.
 */

export interface RecallEntry {
  /** chronicle | topic | card | memex-card.
   *  memex-card entries come from the optional memex CLI when it's
   *  installed; everything else from vibebook's BookIndex. */
  kind: "chronicle" | "topic" | "card" | "memex-card";
  /** Project slug ("_global" for cross-project cards; "_memex" for entries
   *  sourced from memex's flat or category-prefixed slug tree). */
  project: string;
  /** Display title (frontmatter title → first `# heading` → slug). */
  title: string;
  /** First non-heading paragraph, ~200 chars max. The "is this relevant?"
   *  preview the LLM looks at before deciding to Read. */
  summary: string;
  /** Repo-relative path so the LLM knows what to pass to `Read`.
   *  For memex-card entries this is the absolute memex card path
   *  (e.g. ~/.memex/cards/foo-bar.md) — the LLM should `Read` it directly. */
  path: string;
  /** Stable id within its kind: threadId / topicSlug / cardSlug. */
  slug: string;
  /** card type when kind === "card", else undefined. */
  cardType?: "gotcha" | "pattern" | "decision" | "howto" | "tool" | "other";
  /** ISO date — last write. */
  updatedAt: string;
  /** Free-form tags from BookIndex. */
  tags: string[];
}

export interface RecallPayload {
  /** Project the catalog scopes to (null when --all). */
  project: string | null;
  /** Absolute path the LLM should pass to `Read`. */
  repoPath: string;
  /** All matching artifacts. Sorted: cards (most useful for quick recall)
   *  first, then topics, then chronicles, each by updatedAt desc within. */
  entries: RecallEntry[];
  meta: {
    chronicles: number;
    topics: number;
    cards: number;
    /** Memex-card count, only populated when memex was detected. */
    memexCards?: number;
    /** True when we couldn't resolve cwd → project. */
    cwdUnresolved?: boolean;
    /** True when the optional memex source was queried (regardless of
     *  whether it returned any entries). Lets the skill say
     *  "checked memex too — nothing matched" vs "memex unavailable". */
    memexQueried?: boolean;
  };
}

export interface RecallOptions {
  /** Catalog the project matching this cwd. Mutually exclusive with --all. */
  cwd?: string;
  /** Override project slug directly (bypass cwd resolution). */
  project?: string;
  /** Catalog every project (no filter). Use sparingly. */
  all?: boolean;
  /** Include the user's `_global` cards in the project-scoped catalog
   *  (default true — _global cards by definition apply across projects). */
  includeGlobalCards?: boolean;
  /** Skip the memex source even if memex is available. Useful when the
   *  caller wants only vibebook artifacts (e.g. to count what vibebook
   *  itself has produced without the memex layer in the way). */
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
      // Don't throw — return an empty catalog with a hint flag. The skill
      // can show the user "no notes for this cwd" gracefully.
    }
  }

  const includeGlobal = opts.includeGlobalCards !== false;
  const entries: RecallEntry[] = [];

  // --- chronicles ---
  for (const c of Object.values(bookIndex.chronicles)) {
    if (c.skip) continue;
    const project = c.project || projectFromPath(c.path);
    if (!project) continue;
    if (projectFilter && project !== projectFilter) continue;
    entries.push({
      kind: "chronicle",
      project,
      title: titleForArtifact(cfg.repoPath, c.path, c.title || c.threadId),
      summary: summaryFor(cfg.repoPath, c.path),
      path: c.path,
      slug: c.threadId,
      updatedAt: c.updatedAt,
      tags: c.tags ?? [],
    });
  }

  // --- topics ---
  for (const t of Object.values(bookIndex.topics)) {
    const project = t.project || projectFromPath(t.path);
    if (!project) continue;
    if (projectFilter && project !== projectFilter) continue;
    entries.push({
      kind: "topic",
      project,
      title: titleForArtifact(cfg.repoPath, t.path, t.topicSlug),
      summary: summaryFor(cfg.repoPath, t.path),
      path: t.path,
      slug: t.topicSlug,
      updatedAt: t.updatedAt,
      tags: [],
    });
  }

  // --- cards (per-project + optionally _global) ---
  for (const c of Object.values(bookIndex.cards)) {
    const project = c.project || projectFromPath(c.path);
    if (!project) continue;
    const isGlobal = project === "_global";
    if (projectFilter) {
      if (!(project === projectFilter || (isGlobal && includeGlobal))) continue;
    }
    entries.push({
      kind: "card",
      project,
      title: titleForArtifact(cfg.repoPath, c.path, prettifySlug(c.cardSlug)),
      summary: summaryFor(cfg.repoPath, c.path),
      path: c.path,
      slug: c.cardSlug,
      cardType: c.type || (typeFromSlug(c.cardSlug) as RecallEntry["cardType"]),
      updatedAt: c.updatedAt,
      tags: c.tags ?? [],
    });
  }

  // --- memex cards (optional, only when memex is on PATH) ---
  // Pulled into the same RecallPayload so the in-session Claude sees ONE
  // catalog, not two. Memex is the second-source-of-truth for atomic
  // insights — it has its own better-fitted slug conventions, archive,
  // organize loop, etc. We just borrow its catalog as a read.
  let memexQueried = false;
  if (!opts.noMemex) {
    const memexEntries = loadMemexCatalog();
    if (memexEntries !== null) {
      memexQueried = true;
      entries.push(...memexEntries);
    }
  }

  // Sort: cards first (most useful for "did I solve this before?"), then
  // memex-cards (also card-grain, but lower-priority because they may not
  // be project-scoped), then topics (subsystem context), then chronicles
  // (full diary). Within each kind, newest first.
  const kindOrder: Record<RecallEntry["kind"], number> = {
    card: 0, "memex-card": 1, topic: 2, chronicle: 3,
  };
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return kindOrder[a.kind] - kindOrder[b.kind];
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });

  const meta = {
    chronicles: entries.filter((e) => e.kind === "chronicle").length,
    topics: entries.filter((e) => e.kind === "topic").length,
    cards: entries.filter((e) => e.kind === "card").length,
    ...(memexQueried ? {
      memexQueried: true,
      memexCards: entries.filter((e) => e.kind === "memex-card").length,
    } : {}),
    ...(cwdUnresolved ? { cwdUnresolved: true } : {}),
  };

  return {
    project: projectFilter,
    repoPath: cfg.repoPath,
    entries,
    meta,
  };
}

// ---------- helpers ----------

function projectFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "book") return null;
  return parts[1] || null;
}

/** Read the artifact md and extract its display title. Prefers the first
 *  `# heading` (most chronicles + topics) then YAML frontmatter `title`,
 *  falls back to the caller's default. */
function titleForArtifact(repoPath: string, repoRel: string, fallback: string): string {
  const abs = join(repoPath, repoRel);
  if (!existsSync(abs)) return fallback;
  const head = readFileSync(abs, "utf8").slice(0, 1024);
  // # heading
  const hMatch = head.match(/^#\s+(.+?)\s*$/m);
  if (hMatch) return hMatch[1].trim();
  // YAML frontmatter title:
  const fmMatch = head.match(/^---[\s\S]*?\ntitle:\s*(.+?)\s*\n[\s\S]*?---/);
  if (fmMatch) return fmMatch[1].replace(/^["']|["']$/g, "").trim();
  return fallback;
}

/** Pull a 1-paragraph summary from the artifact body — the first non-empty
 *  line that isn't a heading, frontmatter, or list bullet, capped at ~200
 *  chars. Falls back to a slug-derived label. */
function summaryFor(repoPath: string, repoRel: string): string {
  const abs = join(repoPath, repoRel);
  if (!existsSync(abs)) return "";
  const body = readFileSync(abs, "utf8");
  // Strip YAML frontmatter if present.
  const stripped = body.replace(/^---[\s\S]*?---\s*\n/, "");
  const lines = stripped.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;       // heading
    if (line.startsWith("---")) continue;     // hr
    if (line.startsWith("- ") || line.startsWith("* ")) continue;  // bullet
    if (line.startsWith(">")) continue;       // blockquote
    if (line.startsWith("```")) continue;     // code fence
    // Strip wikilinks + markdown links → plain text for preview.
    const plain = line
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
    return plain.length > 200 ? plain.slice(0, 200) + "…" : plain;
  }
  return "";
}

function typeFromSlug(slug: string): RecallEntry["cardType"] {
  const m = slug.match(/^(gotcha|pattern|decision|howto|tool)-/);
  if (m) return m[1] as RecallEntry["cardType"];
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

void projectSlugFromPath; // re-exposed for downstream callers if needed

// ---------- memex source ----------

/**
 * Optional second-source catalog from the memex CLI.
 * (memex = https://github.com/iamtouchskyer/memex — purpose-built atomic
 * Zettelkasten cards with proactive Stop-hook reminders.)
 *
 * We deliberately don't depend on memex as an npm package: it has its own
 * release cadence and ships a separate Claude Code plugin. We just shell
 * out to its `read index` command if it happens to be on PATH. Returns:
 *   - `null` when memex isn't available (timeout / not in PATH / errored)
 *   - `[]` when memex is there but has zero cards
 *   - the catalog otherwise
 *
 * This is intentionally fail-open — vibebook recall must keep working
 * even when memex is broken.
 */
function loadMemexCatalog(): RecallEntry[] | null {
  // Hard 2s timeout. If memex is slow we'd rather degrade than hang
  // the recall skill while the user waits to start work.
  const r = spawnSync("memex", ["read", "index"], {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error || r.status !== 0) return null;
  return parseMemexIndex(r.stdout);
}

/**
 * `memex read index` outputs a markdown index page that memex itself
 * generates from `memex organize`. Format (lines we care about):
 *
 *   ## <category>
 *   - [[<slug>]] — <one-line summary>
 *   - [[<slug>|<title>]] — <one-line summary>
 *
 * We turn each `- [[...]]` line into a RecallEntry. memex doesn't give
 * us per-card updatedAt cheaply, so all entries get today's date — fine
 * for sort stability, not as informative as vibebook's own dates.
 */
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
      // The LLM should run `memex read <slug>` (the skill description
      // explains this) — we surface the slug as the path so the LLM has
      // exactly what it needs to fetch the body.
      path: `memex:${slug}`,
      slug,
      cardType: typeFromSlug(slug),
      updatedAt: today,
      tags: category && category !== "_memex" ? [category] : [],
    });
  }
  return out;
}
