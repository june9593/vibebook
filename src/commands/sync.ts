import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import chalk from "chalk";
import { ClaudeCodeAdapter } from "../sources/claude-code.js";
import { VSCodeCopilotAdapter } from "../sources/vscode-copilot.js";
import type { SourceAdapter } from "../sources/base.js";
import { loadIndex, saveIndex, hasUnchanged, upsertEntry } from "../index-store.js";
import type { IndexEntry } from "../types.js";
import { writeSession } from "../writer.js";
import { deriveKey, encrypt } from "../crypto.js";
import { readConfig, getPassphrase, type Config } from "../config.js";
import { ensureRepo, commitAndPush, ensureDeviceBranch } from "../git-ops.js";
import { migrateLegacyMainToDevice } from "../migrate.js";
import { loadBookIndex, saveBookIndex } from "../digest/book-index.js";
import { createRunner } from "../digest/runner.js";
import { runDigest, type DigestReport } from "../digest/orchestrator.js";

export interface SyncOptions {
  repoPath: string;
  claudeRoot?: string;
  vscodeRoot?: string;
  encrypt: boolean;
  passphrase?: string;
  saltB64?: string;
  push?: boolean;
  repoUrl?: string;
  deviceBranch?: string;
  /** When true, skip phases 3-7 (digest). Default false. */
  noDigest?: boolean;
  /** Runner config — required when noDigest is false and encrypt is false. */
  runnerConfig?: Pick<Config, "runner" | "runnerModel">;
}

export type DigestStatus = "ok" | "skipped-encrypted" | "skipped-flag" | "skipped-no-runner" | "failed" | "not-attempted";

export interface SyncResult {
  newCount: number;
  skippedCount: number;
  pathsWritten: string[];
  committed: boolean;
  pushed: boolean;
  digestStatus: DigestStatus;
  digestError?: string;
  digestReport?: DigestReport;
  /** True iff a second commit (book branch update) was created. */
  digestCommitted: boolean;
  /** True iff the book commit was pushed (only meaningful when digestCommitted is true). */
  digestPushed: boolean;
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const adapters: SourceAdapter[] = [
    new ClaudeCodeAdapter(opts.claudeRoot),
    new VSCodeCopilotAdapter(opts.vscodeRoot),
  ];

  const idx = loadIndex(opts.repoPath);
  const key = opts.encrypt
    ? deriveKey(opts.passphrase!, Buffer.from(opts.saltB64!, "base64"))
    : null;

  let newCount = 0, skippedCount = 0;
  const pathsWritten: string[] = [];

  for (const adapter of adapters) {
    for await (const d of adapter.discover()) {
      let s;
      try {
        s = await d.load();
      } catch (err) {
        console.log(chalk.yellow(`! skip ${d.sourcePath}: ${(err as Error).message}`));
        continue;
      }
      if (hasUnchanged(idx, s.tool, s.sessionId, d.sourceMtimeMs, d.sourceSha256)) {
        skippedCount++;
        continue;
      }
      const rel = writeSession(opts.repoPath, s);

      if (key) {
        const rawAbs = join(opts.repoPath, rel.raw);
        const mdAbs = join(opts.repoPath, rel.md);
        const rawEnc = encrypt(readFileSync(rawAbs), key);
        const mdEnc = encrypt(readFileSync(mdAbs), key);
        writeFileSync(rawAbs + ".enc", rawEnc);
        writeFileSync(mdAbs + ".enc", mdEnc);
        unlinkSync(rawAbs);
        unlinkSync(mdAbs);
        pathsWritten.push(rel.raw + ".enc", rel.md + ".enc");
      } else {
        pathsWritten.push(rel.raw, rel.md);
      }

      const entry: IndexEntry = {
        sessionId: s.sessionId,
        shortId: s.shortId,
        tool: s.tool,
        project: s.project,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        nameSlug: s.nameSlug,
        displayName: s.displayName,
        relativePath: key ? rel.raw + ".enc" : rel.raw,
        sourcePath: s.sourcePath,
        sourceMtimeMs: d.sourceMtimeMs,
        sourceSha256: d.sourceSha256,
      };
      upsertEntry(idx, entry);
      newCount++;
      console.log(chalk.green(`+ ${s.tool}/${s.project}/${s.nameSlug} (${s.shortId})`));
    }
  }

  saveIndex(opts.repoPath, idx);
  const indexPath = ".memvc/index.json";

  let committed = false, pushed = false;
  if (opts.push && opts.repoUrl && opts.deviceBranch) {
    console.log(chalk.gray(`\nOpening repo at ${opts.repoPath}...`));
    const git = await ensureRepo(opts.repoPath, opts.repoUrl);
    const mig = await migrateLegacyMainToDevice(opts.repoPath, opts.deviceBranch);
    if (mig.migrated) {
      console.log(chalk.cyan(`Migrated legacy 'main' branch to '${opts.deviceBranch}'. 'main' is now unborn locally.`));
    }
    try { await git.fetch(); } catch { /* remote may be empty / offline */ }
    console.log(chalk.gray(`Ensuring branch '${opts.deviceBranch}' is checked out...`));
    await ensureDeviceBranch(git, opts.deviceBranch);
    const all = [...pathsWritten, indexPath];
    console.log(chalk.gray(`Staging ${all.length} paths and committing...`));
    const r = await commitAndPush(
      git,
      `memvc sync: +${newCount} sessions`,
      all,
      opts.deviceBranch,
      (stage) => console.log(chalk.gray(`  ${stage}`)),
    );
    committed = r.committed; pushed = r.pushed;
    if (committed && !pushed) console.log(chalk.yellow("Commit done, push failed or skipped."));
  }

  // -------------------- Phases 3-7 (digest) + phase 8 (book push) --------------------
  let digestStatus: DigestStatus = "not-attempted";
  let digestError: string | undefined;
  let digestReport: DigestReport | undefined;
  let digestCommitted = false, digestPushed = false;

  if (opts.noDigest) {
    digestStatus = "skipped-flag";
  } else if (opts.encrypt) {
    digestStatus = "skipped-encrypted";
    console.log(chalk.yellow(
      "Digest pipeline skipped: encrypted raw is not yet supported (book/ unchanged).",
    ));
  } else if (!opts.runnerConfig) {
    digestStatus = "skipped-no-runner";
    console.log(chalk.yellow("Digest pipeline skipped: no runnerConfig provided."));
  } else {
    console.log(chalk.gray("\nRunning digest pipeline (phases 3-7)..."));
    const bookIndex = loadBookIndex(opts.repoPath);
    const runner = createRunner(opts.runnerConfig);
    try {
      digestReport = await runDigest(runner, opts.repoPath, idx, bookIndex);
      saveBookIndex(opts.repoPath, bookIndex);
      digestStatus = "ok";
      console.log(chalk.gray(
        `  digest: +${digestReport.articlesOk} articles, ${digestReport.threadsSkipped} skip, ${digestReport.articlesFailed} fail; chapters [${digestReport.chaptersRewritten.join(", ")}]`,
      ));
    } catch (e) {
      digestStatus = "failed";
      digestError = e instanceof Error ? e.message : String(e);
      console.log(chalk.red(`! digest failed: ${digestError}`));
    }

    // -------------------- Phase 8 (book push) --------------------
    if (digestStatus === "ok" && opts.push && opts.repoUrl && opts.deviceBranch && digestReport) {
      const git = await ensureRepo(opts.repoPath, opts.repoUrl);
      // We're already on opts.deviceBranch from the raw commit above. Stage all
      // book paths the digest touched + the BookIndex, and commit if dirty.
      const bookPaths = collectDigestPaths(digestReport, opts.repoPath);
      const r = await commitAndPush(
        git,
        `memvc digest: +${digestReport.articlesOk} articles, ${digestReport.chaptersRewritten.length} chapters`,
        bookPaths,
        opts.deviceBranch,
        (stage) => console.log(chalk.gray(`  ${stage}`)),
      );
      digestCommitted = r.committed;
      digestPushed = r.pushed;
      if (digestCommitted && !digestPushed) {
        console.log(chalk.yellow("Digest commit done, push failed or skipped."));
      }
    }
  }

  return {
    newCount, skippedCount, pathsWritten,
    committed, pushed,
    digestStatus, digestError, digestReport,
    digestCommitted, digestPushed,
  };
}

/**
 * Collect repo-rooted paths the digest produced or might have produced:
 *   - .memvc/index.book.json
 *   - every entry in digestReport.tocFilesWritten
 *   - book/<project>/articles/* for articles touched (we glob the project dirs)
 *   - book/<project>/chapter.md for each rewritten chapter
 *
 * commitAndPush handles missing files gracefully (git add of a non-existent
 * path is a no-op when the path was previously committed; otherwise git just
 * stages what's there). We avoid a recursive walk to keep this fast.
 */
function collectDigestPaths(report: DigestReport, repoRoot: string): string[] {
  const out = new Set<string>();
  out.add(".memvc/index.book.json");
  for (const p of report.tocFilesWritten) out.add(p);
  for (const project of report.chaptersRewritten) out.add(`book/${project}/chapter.md`);
  // Articles: rather than enumerate per-thread, stage the whole articles dir
  // for any project we touched. git add accepts directory paths and stages
  // every file under them.
  const projectsTouched = new Set<string>();
  for (const project of report.chaptersRewritten) projectsTouched.add(project);
  // tocFilesWritten includes book/<project>/timeline.md for non-empty projects;
  // pull project names from those.
  for (const path of report.tocFilesWritten) {
    const m = path.match(/^book\/([^/]+)\/timeline\.md$/);
    if (m && m[1]) projectsTouched.add(m[1]);
  }
  for (const project of projectsTouched) {
    const dir = `book/${project}/articles`;
    if (existsSync(join(repoRoot, dir))) out.add(dir);
  }
  return [...out];
}

export async function syncCmd(opts: { noDigest?: boolean } = {}): Promise<void> {
  const cfg = readConfig();
  const passphrase = cfg.encrypt ? getPassphrase() : undefined;
  const r = await runSync({
    repoPath: cfg.repoPath,
    encrypt: cfg.encrypt,
    passphrase,
    saltB64: cfg.salt,
    push: true,
    repoUrl: cfg.repoUrl,
    deviceBranch: cfg.deviceBranch,
    noDigest: opts.noDigest,
    runnerConfig: { runner: cfg.runner, runnerModel: cfg.runnerModel },
  });
  console.log(chalk.bold(`\nSynced: +${r.newCount} new, ${r.skippedCount} unchanged`));
  if (r.committed) console.log(chalk.cyan(r.pushed ? "Pushed (raw)." : "Committed raw (push failed)."));
  if (r.digestStatus === "ok") {
    console.log(chalk.cyan(
      r.digestCommitted
        ? (r.digestPushed ? "Pushed (book)." : "Committed book (push failed).")
        : "Digest produced no changes to commit.",
    ));
  } else if (r.digestStatus === "failed") {
    console.log(chalk.red(`Digest failed: ${r.digestError}`));
  } else if (r.digestStatus === "skipped-encrypted") {
    console.log(chalk.yellow("Digest skipped (encrypted mode)."));
  } else if (r.digestStatus === "skipped-flag") {
    console.log(chalk.gray("Digest skipped (--no-digest)."));
  } else if (r.digestStatus === "skipped-no-runner") {
    console.log(chalk.yellow("Digest skipped (no runner configured)."));
  }
}
