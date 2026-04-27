import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import chalk from "chalk";
import { readConfig } from "../config.js";
import {
  loadBookIndexV2, saveBookIndexV2,
  insertChronicle, upsertTopic, upsertCard,
  topicKey, cardKey,
  type ChronicleEntry, type TopicEntry, type CardEntry, type BookIndexV2,
} from "../digest/book-index-v2.js";
import { ensureRepo, ensureDeviceBranch, fastForwardBranch, commitAndPush } from "../git-ops.js";
import { generateBookCatalog } from "../digest/book-catalog.js";
import { resolveWikiLinks } from "../digest/wikilinks.js";

/**
 * Inputs for `vibebook publish` — three independent JSON files written by
 * the in-session Claude during the /vibebook skill flow.
 */
export interface ChronicleInput {
  threadId: string;
  title: string;
  sessionIds: string[];
  /** Project the LLM decided this thread belongs to. Must be a real project
   *  (we don't sanity-check; SKILL.md tells the LLM to honor per-project). */
  project: string;
  tags?: string[];
  /** Already-formatted markdown body (with frontmatter). The LLM produced
   *  this following SKILL.md step 3. */
  body: string;
  skip?: boolean;
  skipReason?: string;
}

export interface TopicInput {
  topicSlug: string;
  project: string;
  /** "insert" = new topic page; "update" = full-rewrite an existing one
   *  (we'll back up old content to <slug>.md.bak first). */
  action: "insert" | "update";
  /** Threads contributing to this topic (chronicle threadIds). */
  contributingThreads: string[];
  body: string;
}

export interface CardInput {
  cardSlug: string;
  project: string;  // "_global" allowed
  type: "gotcha" | "pattern" | "decision" | "howto" | "tool" | "other";
  /** "insert" = new; "update" = overwrite existing card with merged content. */
  action: "insert" | "update";
  tags?: string[];
  body: string;
}

export interface PublishOptions {
  chroniclesPath?: string;
  topicsPath?: string;
  cardsPath?: string;
  /** Skip the git commit + push step; just write files + update index.
   *  Useful for tests and for users who want to inspect before pushing. */
  noCommit?: boolean;
  /** Skip catalog generation (book/index.md, book/_meta/timeline.md,
   *  book/<project>/index.md). Project-mode `/vibebook` passes this — only
   *  the global mode rebuilds the catalog after fan-out completes. */
  noCatalog?: boolean;
}

export interface PublishReport {
  chroniclesInserted: number;
  chroniclesSkipped: number;
  topicsUpdated: number;
  topicsInserted: number;
  cardsInserted: number;
  cardsUpdated: number;
  bookIndexFiles: string[];   // paths regen'd by catalog (book/index.md, book/_meta/timeline.md)
  committed: boolean;
  pushed: boolean;
}

/**
 * Main entry: read the three input files, write artifacts, regen catalog,
 * commit + push.
 *
 * Failure semantics: any unrecoverable error (chronicle threadId collision,
 * missing input file, write error) throws BEFORE git operations, so the
 * BookIndex on disk is left untouched. Topic .bak files are written before
 * the new content so a partial failure leaves both old + new for inspection.
 */
export async function publishCmd(opts: PublishOptions): Promise<PublishReport> {
  const cfg = readConfig();
  const bookIndex = loadBookIndexV2(cfg.repoPath);
  const report: PublishReport = {
    chroniclesInserted: 0,
    chroniclesSkipped: 0,
    topicsUpdated: 0,
    topicsInserted: 0,
    cardsInserted: 0,
    cardsUpdated: 0,
    bookIndexFiles: [],
    committed: false,
    pushed: false,
  };

  // ----- chronicles + topics + cards (two-pass: register, then write) -----
  // Pass 1: register entries in bookIndex (no file writes). This lets the
  // wikilink resolver in Pass 2 find new artifacts inserted in the same
  // publish call. Without this, a topic written in this batch couldn't link
  // to a chronicle written in the same batch.
  const chronicleWrites: { absPath: string; body: string; project: string }[] = [];
  const topicWrites: { absPath: string; body: string; project: string; backupOf?: string }[] = [];
  const cardWrites: { absPath: string; body: string; project: string }[] = [];

  if (opts.chroniclesPath) {
    const inputs = readJsonInput<ChronicleInput[]>(opts.chroniclesPath, "chronicles");
    for (const c of inputs) {
      try {
        const r = registerChronicle(cfg.repoPath, bookIndex, c);
        if (r.skipped) report.chroniclesSkipped++;
        else {
          report.chroniclesInserted++;
          if (r.write) chronicleWrites.push(r.write);
        }
      } catch (err) {
        throw new Error(`chronicle threadId='${c?.threadId ?? "?"}' project='${c?.project ?? "?"}': ${(err as Error).message}`);
      }
    }
  }

  if (opts.topicsPath) {
    const inputs = readJsonInput<TopicInput[]>(opts.topicsPath, "topics");
    for (const t of inputs) {
      try {
        const r = registerTopic(cfg.repoPath, bookIndex, t);
        if (r.updated) report.topicsUpdated++;
        else report.topicsInserted++;
        topicWrites.push(r.write);
      } catch (err) {
        throw new Error(`topic slug='${t?.topicSlug ?? "?"}' project='${t?.project ?? "?"}': ${(err as Error).message}`);
      }
    }
  }

  if (opts.cardsPath) {
    const inputs = readJsonInput<CardInput[]>(opts.cardsPath, "cards");
    for (const c of inputs) {
      try {
        const r = registerCard(cfg.repoPath, bookIndex, c);
        if (r.updated) report.cardsUpdated++;
        else report.cardsInserted++;
        cardWrites.push(r.write);
      } catch (err) {
        throw new Error(`card slug='${c?.cardSlug ?? "?"}' project='${c?.project ?? "?"}': ${(err as Error).message}`);
      }
    }
  }

  // Pass 2: write files with [[wikilinks]] resolved against the now-complete
  // bookIndex.
  const allUnresolved: { from: string; target: string }[] = [];
  const writeWithLinks = (
    absPath: string, body: string, project: string, repoRel: string,
  ) => {
    const r = resolveWikiLinks(body, { fromPath: repoRel, fromProject: project, bookIndex });
    for (const u of r.unresolved) allUnresolved.push({ from: repoRel, target: u });
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, r.body.endsWith("\n") ? r.body : r.body + "\n");
  };

  for (const w of chronicleWrites) {
    writeWithLinks(w.absPath, w.body, w.project, repoRelOf(cfg.repoPath, w.absPath));
  }
  for (const w of topicWrites) {
    if (w.backupOf && existsSync(w.absPath)) copyFileSync(w.absPath, w.backupOf);
    writeWithLinks(w.absPath, w.body, w.project, repoRelOf(cfg.repoPath, w.absPath));
  }
  for (const w of cardWrites) {
    writeWithLinks(w.absPath, w.body, w.project, repoRelOf(cfg.repoPath, w.absPath));
  }

  if (allUnresolved.length > 0) {
    console.error(chalk.yellow(`\n  ${allUnresolved.length} unresolved wikilink(s):`));
    for (const u of allUnresolved.slice(0, 10)) {
      console.error(chalk.gray(`    in ${u.from}: [[${u.target}]]`));
    }
    if (allUnresolved.length > 10) {
      console.error(chalk.gray(`    ... and ${allUnresolved.length - 10} more`));
    }
  }

  // ----- regen catalog (book/index.md + book/_meta/timeline.md) -----
  // Project-mode publish skips this — catalog regen only runs in global mode
  // after every project's subagent has finished, so the catalog reflects the
  // full set in one shot rather than churning per-project.
  if (!opts.noCatalog) {
    const catalog = generateBookCatalog(cfg.repoPath, bookIndex);
    report.bookIndexFiles = catalog.written;
  }

  // ----- persist book index -----
  saveBookIndexV2(cfg.repoPath, bookIndex);

  // ----- commit + push -----
  // Stage only files publish actually wrote (artifacts + .bak backups +
  // regen'd catalog) plus the index. Crucially we do NOT `git add book/`
  // recursively — that would silently sweep in any md the LLM wrote
  // directly under book/ bypassing publish (which never goes through
  // wikilink resolution and never gets into the index).
  if (!opts.noCommit && cfg.repoUrl && cfg.deviceBranch) {
    const stagedRel: string[] = [];
    const pushRel = (abs: string) => stagedRel.push(repoRelOf(cfg.repoPath, abs));
    for (const w of chronicleWrites) pushRel(w.absPath);
    for (const w of topicWrites) {
      pushRel(w.absPath);
      if (w.backupOf) pushRel(w.backupOf);
    }
    for (const w of cardWrites) pushRel(w.absPath);
    for (const f of report.bookIndexFiles) stagedRel.push(repoRelOf(cfg.repoPath, f));
    stagedRel.push(".vibebook/index.book.json");

    const r = await commitAndPushBook(cfg.repoPath, cfg.repoUrl, cfg.deviceBranch, report, stagedRel);
    report.committed = r.committed;
    report.pushed = r.pushed;
  }

  return report;
}

// ----------------- chronicle -----------------

interface ChronicleRegisterResult {
  skipped: boolean;
  write?: { absPath: string; body: string; project: string };
}

function registerChronicle(
  repoRoot: string,
  bookIndex: BookIndexV2,
  c: ChronicleInput,
): ChronicleRegisterResult {
  // Reject inputs missing the fields publish needs to compute paths. Without
  // these checks a typo / frontmatter-only LLM mistake silently writes to
  // book/undefined/chronicle/<undefined>.md, which is what we explicitly
  // don't want — the whole point of the publish CLI is to be the one place
  // that enforces shape.
  assertNonEmpty("chronicle.project", c.project);
  assertNonEmpty("chronicle.threadId", c.threadId);
  assertNonEmpty("chronicle.title", c.title);
  assertNonEmptyArray("chronicle.sessionIds", c.sessionIds);

  // SKIP'd chronicles are recorded in the index (so re-runs don't reconsider
  // the same sessions) but NO file is written.
  const dateStr = new Date().toISOString().slice(0, 10);
  if (c.skip) {
    insertChronicle(bookIndex, {
      threadId: c.threadId,
      project: c.project,
      title: c.title,
      sessionIds: c.sessionIds,
      path: "",
      createdAt: dateStr,
      updatedAt: dateStr,
      tags: c.tags ?? [],
      skip: true,
      skipReason: c.skipReason,
    });
    return { skipped: true };
  }
  const filename = chronicleFilename(c, dateStr);
  const relPath = `book/${c.project}/chronicle/${filename}`;
  insertChronicle(bookIndex, {
    threadId: c.threadId,
    project: c.project,
    title: c.title,
    sessionIds: c.sessionIds,
    path: relPath,
    createdAt: dateStr,
    updatedAt: dateStr,
    tags: c.tags ?? [],
  });
  return {
    skipped: false,
    write: { absPath: join(repoRoot, relPath), body: c.body, project: c.project },
  };
}

function chronicleFilename(c: ChronicleInput, dateStr: string): string {
  // Format: YYYY-MM-DD__<threadId>__<tid8>.md
  const tid8 = c.threadId.slice(0, 8);
  return `${dateStr}__${c.threadId}__${tid8}.md`;
}

// ----------------- topic -----------------

interface TopicRegisterResult {
  updated: boolean;
  write: { absPath: string; body: string; project: string; backupOf?: string };
}

function registerTopic(
  repoRoot: string,
  bookIndex: BookIndexV2,
  t: TopicInput,
): TopicRegisterResult {
  assertNonEmpty("topic.project", t.project);
  assertNonEmpty("topic.topicSlug", t.topicSlug);

  const relPath = `book/${t.project}/topics/${t.topicSlug}.md`;
  const absPath = join(repoRoot, relPath);
  const dateStr = new Date().toISOString().slice(0, 10);

  const existing = bookIndex.topics[topicKey(t.project, t.topicSlug)];
  // Tolerate the input missing `contributingThreads` (or it being null) — the
  // skill can introduce a topic that has no concrete thread bindings yet
  // (e.g. it's a pure concept page seeded from sibling cards). Don't crash
  // with an opaque "is not iterable" — fall back to [].
  const incomingThreads = Array.isArray(t.contributingThreads) ? t.contributingThreads : [];
  const entry: TopicEntry = {
    topicSlug: t.topicSlug,
    project: t.project,
    path: relPath,
    createdAt: existing?.createdAt ?? dateStr,
    updatedAt: dateStr,
    contributingThreads: dedupArray([
      ...(existing?.contributingThreads ?? []),
      ...incomingThreads,
    ]),
  };
  upsertTopic(bookIndex, entry);
  return {
    updated: !!existing,
    write: {
      absPath, body: t.body, project: t.project,
      // Topic full-rewrite rule (SKILL.md step 4): the LLM was supposed to
      // read the old page and preserve historical fact, but if it screwed up,
      // .bak gives the user a recovery path.
      backupOf: existsSync(absPath) ? absPath + ".bak" : undefined,
    },
  };
}

// ----------------- card -----------------

interface CardRegisterResult {
  updated: boolean;
  write: { absPath: string; body: string; project: string };
}

function registerCard(
  repoRoot: string,
  bookIndex: BookIndexV2,
  c: CardInput,
): CardRegisterResult {
  assertNonEmpty("card.project", c.project);
  assertNonEmpty("card.cardSlug", c.cardSlug);

  const relPath = `book/${c.project}/cards/${c.cardSlug}.md`;
  const dateStr = new Date().toISOString().slice(0, 10);

  const existing = bookIndex.cards[cardKey(c.project, c.cardSlug)];
  const entry: CardEntry = {
    cardSlug: c.cardSlug,
    project: c.project,
    type: c.type,
    path: relPath,
    createdAt: existing?.createdAt ?? dateStr,
    updatedAt: dateStr,
    tags: c.tags ?? [],
  };
  upsertCard(bookIndex, entry);
  return {
    updated: !!existing,
    write: { absPath: join(repoRoot, relPath), body: c.body, project: c.project },
  };
}

// ----------------- helpers -----------------

function repoRelOf(repoRoot: string, absPath: string): string {
  return absPath.startsWith(repoRoot + "/") ? absPath.slice(repoRoot.length + 1) : absPath;
}

function readJsonInput<T>(path: string, label: string): T {
  if (!existsSync(path)) throw new Error(`${label} input not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`${label} input ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/** Throw if the field is missing/empty/not-a-string. The fail-fast guards in
 *  registerChronicle/Topic/Card use this so a typo (or an LLM that put
 *  `project` only inside frontmatter, not at the top level of the JSON)
 *  errors loudly instead of writing to `book/undefined/...`. */
function assertNonEmpty(label: string, v: unknown): asserts v is string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(
      `${label} is required and must be a non-empty string (got ${JSON.stringify(v)}). ` +
      `If you wrote the value only in YAML frontmatter, also add it to the top level of the JSON entry.`,
    );
  }
}

function assertNonEmptyArray(label: string, v: unknown): asserts v is string[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x.trim().length > 0)) {
    throw new Error(
      `${label} is required and must be a non-empty array of strings (got ${JSON.stringify(v)}). ` +
      `If you wrote the value only in YAML frontmatter, also add it to the top level of the JSON entry.`,
    );
  }
}

function dedupArray<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}

async function commitAndPushBook(
  repoPath: string,
  repoUrl: string,
  deviceBranch: string,
  report: PublishReport,
  paths: string[],
): Promise<{ committed: boolean; pushed: boolean }> {
  const git = await ensureRepo(repoPath, repoUrl);
  try { await git.fetch(); } catch { /* offline / empty */ }
  await ensureDeviceBranch(git, deviceBranch);
  try {
    await fastForwardBranch(git, deviceBranch, (s) => console.log(chalk.gray(`  ${s}`)));
  } catch (err) {
    console.log(chalk.red(`! could not sync with origin: ${err instanceof Error ? err.message : String(err)}`));
    console.log(chalk.cyan(`  Files written + book index updated, but push skipped.`));
    return { committed: false, pushed: false };
  }
  // commitAndPush handles "no changes → no commit" cleanly.
  const msg = `vibebook: +${report.chroniclesInserted} chronicle, ${report.topicsInserted}+${report.topicsUpdated} topic, ${report.cardsInserted}+${report.cardsUpdated} card`;
  const r = await commitAndPush(git, msg, paths, deviceBranch, (stage) => console.log(chalk.gray(`  ${stage}`)));
  return { committed: r.committed, pushed: r.pushed };
}
