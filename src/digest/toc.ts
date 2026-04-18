import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import type { BookIndex, BookEntry } from "./book-index.js";

export interface GenerateTocResult {
  /** Repo-root-relative paths of every file written, suitable for git add. */
  written: string[];
}

/**
 * Mechanically (no LLM) generate the book TOC artifacts from a BookIndex:
 *   - book/index.md           — front page with chapter list
 *   - book/_meta/timeline.md  — global timeline (all ok+non-skipped articles, newest-first)
 *   - book/<project>/timeline.md — per-chapter timeline (only when the chapter has ≥1 ok+non-skipped article)
 *
 * Pure string concatenation — deterministic, easy to test, no IO except writes.
 * Spec §"Pipeline → digest.toc": this step always runs at the end of digest;
 * the pipeline glue is responsible for invoking generateToc once after articles + chapters.
 */
export function generateToc(repoRoot: string, bookIndex: BookIndex): GenerateTocResult {
  const written: string[] = [];

  // Project set: union of chapters keys and projects appearing in threads.
  const projectSet = new Set<string>();
  for (const p of Object.keys(bookIndex.chapters)) projectSet.add(p);
  for (const e of Object.values(bookIndex.threads)) projectSet.add(e.project);
  const projects = Array.from(projectSet).sort();

  // Bucket entries per project, filtering for "publishable" (ok && !skip).
  const okEntriesByProject = new Map<string, BookEntry[]>();
  for (const p of projects) okEntriesByProject.set(p, []);
  let totalOk = 0;
  let totalFailed = 0;
  for (const e of Object.values(bookIndex.threads)) {
    if (e.articleStatus === "failed") {
      totalFailed += 1;
      continue;
    }
    if (e.skip) continue;
    if (e.articleStatus === "ok" && e.articlePath === "") continue;
    okEntriesByProject.get(e.project)!.push(e);
    totalOk += 1;
  }

  // Front page.
  const frontPath = "book/index.md";
  writeFile(repoRoot, frontPath, renderBookIndex({
    projects,
    okCounts: new Map(Array.from(okEntriesByProject, ([p, list]) => [p, list.length])),
    totalOk,
    totalFailed,
    latestUpdate: latestUpdate(bookIndex),
  }));
  written.push(frontPath);

  // Global timeline.
  const globalPath = "book/_meta/timeline.md";
  const allOk = ([] as BookEntry[]).concat(...okEntriesByProject.values());
  writeFile(repoRoot, globalPath, renderGlobalTimeline(allOk, globalPath));
  written.push(globalPath);

  // Per-chapter timelines.
  for (const p of projects) {
    const list = okEntriesByProject.get(p)!;
    if (list.length === 0) continue;
    const chPath = `book/${p}/timeline.md`;
    writeFile(repoRoot, chPath, renderChapterTimeline(p, list, chPath));
    written.push(chPath);
  }

  return { written };
}

/** ISO timestamp of the most recent updatedAt across all threads, or "—". */
function latestUpdate(bookIndex: BookIndex): string {
  let best: string | undefined;
  for (const e of Object.values(bookIndex.threads)) {
    if (!best || e.updatedAt > best) best = e.updatedAt;
  }
  return best ?? "—";
}

interface FrontPageInput {
  projects: string[];
  okCounts: Map<string, number>;
  totalOk: number;
  totalFailed: number;
  latestUpdate: string;
}

function renderBookIndex(input: FrontPageInput): string {
  const lines: string[] = [];
  lines.push("# 笔记本", "");
  lines.push(`更新于 ${input.latestUpdate}`, "");
  const failedSuffix = input.totalFailed > 0 ? `, ${input.totalFailed} 篇失败` : "";
  lines.push(`共 ${input.projects.length} 章，${input.totalOk} 篇文章${failedSuffix}`, "");
  lines.push("## 章节", "");
  if (input.projects.length === 0) {
    lines.push("（暂无）", "");
  } else {
    for (const p of input.projects) {
      lines.push(`- [${p}](${p}/) — ${input.okCounts.get(p) ?? 0} 篇文章`);
    }
    lines.push("");
  }
  lines.push("## 索引", "");
  lines.push("- [全局时间线](_meta/timeline.md)", "");
  return lines.join("\n");
}

function renderGlobalTimeline(entries: BookEntry[], timelinePath: string): string {
  const sorted = entries.slice().sort(timelineSort);
  const lines: string[] = [];
  lines.push("# 全局时间线", "");
  lines.push("| 时间 | 项目 | 标题 | 文章 |");
  lines.push("|---|---|---|---|");
  for (const e of sorted) {
    const link = relPosix(dirname(timelinePath), e.articlePath);
    const linkSafe = /[|\n\r]/.test(link) ? mdCell(link) : link;
    lines.push(`| ${e.updatedAt} | ${e.project} | ${mdCell(e.title)} | [link](${linkSafe}) |`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderChapterTimeline(project: string, entries: BookEntry[], timelinePath: string): string {
  const sorted = entries.slice().sort(timelineSort);
  const lines: string[] = [];
  lines.push(`# ${project} · 时间线`, "");
  lines.push("| 时间 | 标题 | 文章 |");
  lines.push("|---|---|---|");
  for (const e of sorted) {
    const link = relPosix(dirname(timelinePath), e.articlePath);
    const linkSafe = /[|\n\r]/.test(link) ? mdCell(link) : link;
    lines.push(`| ${e.updatedAt} | ${mdCell(e.title)} | [link](${linkSafe}) |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Newest first by updatedAt; tie-broken by threadId ASC for determinism. */
function timelineSort(a: BookEntry, b: BookEntry): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
}

/** path.relative with POSIX separators forced — links in markdown must use '/'. */
function relPosix(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function mdCell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function writeFile(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
