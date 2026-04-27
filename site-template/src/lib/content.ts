/**
 * Read the user's session-repo (BookIndex + book/ markdown files) at build
 * time and produce typed page-data records for Astro `getStaticPaths`.
 *
 * One source of truth: BookIndex v2 (`.vibebook/index.book.json`). The md
 * body is read straight from disk per-entry; we do NOT walk book/ to
 * discover artifacts, because the index records project ownership +
 * sessionIds + skip flags that aren't recoverable from the markdown alone.
 *
 * NOTE: this runs in the Astro/vite Node context, not in the vibebook CLI
 * package, so we re-implement the small read paths here rather than
 * importing from src/digest/. Keeps the site decoupled enough that a user
 * could swap it for a different renderer.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve, posix } from "node:path";
import matter from "gray-matter";

const REPO_PATH: string =
  // @ts-ignore — astro vite injection
  import.meta.env.VIBEBOOK_REPO_PATH ||
  process.env.VIBEBOOK_REPO_PATH ||
  `${process.env.HOME}/.vibebook/session-repo`;

const BOOK_INDEX_PATH = join(REPO_PATH, ".vibebook", "index.book.json");

// ---------- BookIndex v2 types (mirrored from src/digest/book-index-v2.ts) --

export interface RawChronicle {
  threadId: string;
  project: string;
  title?: string;
  sessionIds?: string[];
  path: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  skip?: boolean;
  skipReason?: string;
}
export interface RawTopic {
  topicSlug: string;
  project: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  contributingThreads?: string[];
}
export interface RawCard {
  cardSlug: string;
  project: string;
  type: "gotcha" | "pattern" | "decision" | "howto" | "tool" | "other";
  path: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}
export interface BookIndex {
  version: 2;
  chronicles: Record<string, RawChronicle>;
  topics: Record<string, RawTopic>;
  cards: Record<string, RawCard>;
}

// ---------- enriched page-data types ----

export interface ProjectPage {
  slug: string;
  chronicleCount: number;
  topicCount: number;
  cardCount: number;
  /** Most recent updatedAt across this project's artifacts. */
  lastTouched: string | null;
}

export interface ChroniclePage extends RawChronicle {
  /** title from frontmatter or the first `# ` heading; falls back to threadId. */
  displayTitle: string;
  /** Markdown body with frontmatter stripped. */
  markdown: string;
  /** Cleaned-up thread label without the noise prefixes vibebook publish
   *  used to inject (e.g. `2026-04-26-2025-09-22-...` → `2025-09-22-...`). */
  cleanThreadId: string;
}

export interface TopicPage extends RawTopic {
  displayTitle: string;
  markdown: string;
}

export interface CardPage extends RawCard {
  displayTitle: string;
  markdown: string;
}

// ---------- loader ----------

let cached: BookIndex | null = null;
function loadIndex(): BookIndex {
  if (cached) return cached;
  if (!existsSync(BOOK_INDEX_PATH)) {
    cached = { version: 2, chronicles: {}, topics: {}, cards: {} };
    return cached;
  }
  const raw = readFileSync(BOOK_INDEX_PATH, "utf8");
  cached = JSON.parse(raw) as BookIndex;
  return cached;
}

function readMd(repoRel: string): { md: string; data: Record<string, unknown> } {
  const abs = join(REPO_PATH, repoRel);
  if (!existsSync(abs)) return { md: "", data: {} };
  const raw = readFileSync(abs, "utf8");
  // Some chronicles published before the v0.2 fix have NO frontmatter — they
  // start straight at `# Title`. gray-matter handles both shapes; if there's
  // no frontmatter, `data` is just `{}` and `content` is the entire file.
  const parsed = matter(raw);
  return { md: parsed.content, data: parsed.data as Record<string, unknown> };
}

function firstHeading(md: string): string | null {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/** Strip the publish-bug prefix from a noisy threadId. The early /vibebook
 *  runs let LLMs put `<runDate>-<datedSlug>-<shortId>` into threadId; for
 *  display we want the cleanest readable form possible without losing
 *  identity. We don't try to invert this — just present a friendlier label. */
function cleanThreadIdFor(threadId: string, displayTitle: string): string {
  // If the displayTitle is meaningful and != threadId, just show that;
  // displayTitle came from the # heading or frontmatter, both of which the
  // LLM controlled directly.
  if (displayTitle && displayTitle !== threadId) return displayTitle;
  // Last resort: drop a leading `YYYY-MM-DD-` if present.
  return threadId.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

/** Recover the project slug from a `book/<proj>/<kind>/<file>.md` path —
 *  needed for legacy chronicles where publish forgot to record `project`. */
function projectFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "book") return null;
  return parts[1] || null;
}

/** Infer card.type from the slug prefix when the BookIndex entry omits it
 *  (legacy publishes did). Falls back to "other". */
function typeFromSlug(slug: string): CardPage["type"] {
  const m = slug.match(/^(gotcha|pattern|decision|howto|tool)-/);
  if (m) return m[1] as CardPage["type"];
  return "other";
}

/** Turn `gotcha-profile-shutdown-floating-widget-uaf` into a sentence-case
 *  display title — used as a chronic last-resort when neither YAML
 *  frontmatter nor a `# heading` is available in the md. */
function prettifySlug(slug: string): string {
  // Drop the type prefix so "gotcha-foo" → "foo"
  const stripped = slug.replace(/^(gotcha|pattern|decision|howto|tool)-/, "");
  // Replace dashes with spaces; capitalize first word.
  const spaced = stripped.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ---------- public API ----------

export function listChronicles(): ChroniclePage[] {
  const idx = loadIndex();
  const out: ChroniclePage[] = [];
  for (const c of Object.values(idx.chronicles)) {
    if (c.skip) continue;
    // Old vibebook publish (pre-fail-fast) wrote chronicles without a
    // top-level `project` field. We can recover from the path: book/<proj>/
    // chronicle/...md. Fall back to "_unknown" if even that fails so the
    // build doesn't crash on legacy data.
    const project = c.project || projectFromPath(c.path) || "_unknown";
    const { md, data } = readMd(c.path);
    const fmTitle = typeof data.title === "string" ? data.title : null;
    const headingTitle = firstHeading(md);
    const displayTitle = c.title || fmTitle || headingTitle || c.threadId;
    out.push({
      ...c,
      project,
      tags: c.tags ?? [],
      sessionIds: c.sessionIds ?? [],
      displayTitle,
      markdown: md,
      cleanThreadId: cleanThreadIdFor(c.threadId, displayTitle),
    });
  }
  // newest first
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export function listTopics(): TopicPage[] {
  const idx = loadIndex();
  const out: TopicPage[] = [];
  for (const t of Object.values(idx.topics)) {
    const project = t.project || projectFromPath(t.path) || "_unknown";
    const { md, data } = readMd(t.path);
    const fmTitle = typeof data.title === "string" ? data.title : null;
    const displayTitle = fmTitle || firstHeading(md) || t.topicSlug;
    out.push({
      ...t,
      project,
      contributingThreads: t.contributingThreads ?? [],
      displayTitle,
      markdown: md,
    });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export function listCards(): CardPage[] {
  const idx = loadIndex();
  const out: CardPage[] = [];
  for (const c of Object.values(idx.cards)) {
    const project = c.project || projectFromPath(c.path) || "_unknown";
    const { md, data } = readMd(c.path);
    const fmTitle = typeof data.title === "string" ? data.title : null;
    const displayTitle = fmTitle || firstHeading(md) || prettifySlug(c.cardSlug);
    out.push({
      ...c,
      project,
      type: c.type || (typeFromSlug(c.cardSlug) as CardPage["type"]),
      tags: c.tags ?? [],
      displayTitle,
      markdown: md,
    });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export function listProjects(): ProjectPage[] {
  const idx = loadIndex();
  const m = new Map<string, ProjectPage>();
  const ensure = (slug: string): ProjectPage => {
    let p = m.get(slug);
    if (!p) {
      p = { slug, chronicleCount: 0, topicCount: 0, cardCount: 0, lastTouched: null };
      m.set(slug, p);
    }
    return p;
  };
  const bumpDate = (p: ProjectPage, d: string) => {
    if (!p.lastTouched || d > p.lastTouched) p.lastTouched = d;
  };
  for (const c of Object.values(idx.chronicles)) {
    const project = c.project || projectFromPath(c.path);
    if (!project) continue;
    const p = ensure(project);
    if (!c.skip) p.chronicleCount++;
    bumpDate(p, c.updatedAt);
  }
  for (const t of Object.values(idx.topics)) {
    const project = t.project || projectFromPath(t.path);
    if (!project) continue;
    const p = ensure(project);
    p.topicCount++;
    bumpDate(p, t.updatedAt);
  }
  for (const c of Object.values(idx.cards)) {
    const project = c.project || projectFromPath(c.path);
    if (!project) continue;
    const p = ensure(project);
    p.cardCount++;
    bumpDate(p, c.updatedAt);
  }
  // _global at end
  return [...m.values()].sort((a, b) => {
    if (a.slug === "_global") return 1;
    if (b.slug === "_global") return -1;
    return a.slug.localeCompare(b.slug);
  });
}

export function chroniclesFor(project: string): ChroniclePage[] {
  return listChronicles().filter((c) => c.project === project);
}
export function topicsFor(project: string): TopicPage[] {
  return listTopics().filter((t) => t.project === project);
}
export function cardsFor(project: string): CardPage[] {
  return listCards().filter((c) => c.project === project);
}

// ---------- markdown post-processing ----------

/**
 * Rewrite repo-relative markdown links (the LLM wrote a lot of these:
 * `(../../edge-src/chronicle/...md)` and `(../cards/...md)`) into routes
 * for the static site. We do this on the raw markdown so the renderer
 * still emits regular `<a>` tags.
 *
 * fromRepoRel is the source file's path within the repo, e.g.
 * `book/edge-src/topics/menu-bar.md`. The link target is resolved relative
 * to its directory.
 */
export function rewriteMarkdownLinks(
  md: string,
  fromRepoRel: string,
  baseUrl: string,
): string {
  const fromDir = posix.dirname(fromRepoRel);
  return md.replace(/\]\(([^)]+\.md)([^)]*)\)/g, (whole, target: string, anchor: string) => {
    if (/^https?:/i.test(target)) return whole;
    const targetRel = target.startsWith("/")
      ? target.slice(1)
      : posix.normalize(posix.join(fromDir, target));
    const route = mdPathToRoute(targetRel, baseUrl);
    if (!route) return whole;
    return `](${route}${anchor})`;
  });
}

/** Map a `book/<project>/<kind>/<slug>.md` path to a site URL. Returns null
 *  if the path doesn't fit any known shape. */
export function mdPathToRoute(repoRel: string, base: string): string | null {
  const parts = repoRel.split("/").filter(Boolean);
  // book / <project> / chronicle | topics | cards / <filename>.md
  if (parts.length !== 4 || parts[0] !== "book") return null;
  const project = parts[1];
  const kind = parts[2];
  const file = parts[3].replace(/\.md$/, "");
  if (project === "_global" && kind === "cards") {
    return `${trimTrailing(base)}/global/cards/${file}/`;
  }
  if (kind === "chronicle") {
    return `${trimTrailing(base)}/projects/${project}/chronicle/${file}/`;
  }
  if (kind === "topics") {
    return `${trimTrailing(base)}/projects/${project}/topics/${file}/`;
  }
  if (kind === "cards") {
    return `${trimTrailing(base)}/projects/${project}/cards/${file}/`;
  }
  return null;
}

function trimTrailing(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/** Strip the awkward `<runDate>__<noisyThreadId>__<dateFragment>.md` style
 *  filename down to the threadId portion. Used to map a chronicle.path back
 *  to its routing slug. */
export function chronicleFileSlug(path: string): string {
  const base = path.split("/").pop()!.replace(/\.md$/, "");
  // Pattern: <YYYY-MM-DD>__<threadId>__<tid8>
  const m = base.match(/^(\d{4}-\d{2}-\d{2})__(.+)__([^_]+)$/);
  return m ? m[2] : base;
}

/** Stable URL-safe slug for a chronicle. */
export function chronicleRouteSlug(c: RawChronicle): string {
  // Use the file slug (which equals threadId for clean publishes; for the
  // legacy noisy publishes it equals their compound id). Either way it's
  // unique within a project because publish enforces that.
  return chronicleFileSlug(c.path);
}

void resolve; void relative; void dirname;  // keep-warm against TS unused-import nag
