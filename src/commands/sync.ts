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
import { readConfig, writeConfig, writeRepoSaltFile, getPassphrase, DEFAULT_THREADING_CONCURRENCY, DEFAULT_THREADING_MAX_ATTEMPTS, type Config } from "../config.js";
import { deviceBranchFromHostname } from "../device.js";
import { ensureRepo, commitAndPush, ensureDeviceBranch, fastForwardBranch } from "../git-ops.js";
import { migrateLegacyMainToDevice, migrateLegacyDataDir, migratedDataDirPaths } from "../migrate.js";
import { loadBookIndex, saveBookIndex } from "../digest/book-index.js";
import { createRunner } from "../digest/runner.js";
import { runDigest, type DigestReport } from "../digest/orchestrator.js";
import { consoleReporter } from "../digest/reporter.js";
import { INDEX_REL, BOOK_INDEX_REL, REPO_SALT_REL, LEGACY_REPO_DATA_DIR } from "../repo-data-dir.js";

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
  /** Cap on parallel runner calls during the threading phase. Default 4. */
  threadingConcurrency?: number;
  /** Attempts per threading batch before soft-failing it. Default 3. */
  threadingMaxAttempts?: number;
}

export type DigestStatus = "ok" | "skipped-flag" | "skipped-no-runner" | "failed" | "not-attempted";

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
  // One-shot migration: rename legacy `.memvc/` → `.vibebook/` if present.
  // Done before loadIndex so the read picks up the file at its new location.
  // Returns paths to stage so the rename rides the next commit.
  const dataDirMig = await migrateLegacyDataDir(opts.repoPath);
  if (dataDirMig.migrated) {
    console.log(chalk.cyan(`Migrating: renamed legacy ${LEGACY_REPO_DATA_DIR}/ → .vibebook/ ${dataDirMig.viaGit ? "(via git mv; staged for next commit)" : "(non-git mode)"}`));
  }

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
  const indexPath = INDEX_REL;

  // Self-heal: encryption is on but the repo is missing .vibebook/repo-salt.json
  // (legacy repo initialized before salt-write was wired into init, or someone
  // git-rm'd it). Write it from the in-memory salt so the GH Action workflow
  // doesn't fail on its salt-presence guard. Salt is not sensitive — security
  // relies on the passphrase.
  const saltRelPath = REPO_SALT_REL;
  let saltJustWritten = false;
  if (opts.encrypt && opts.saltB64) {
    const saltAbs = join(opts.repoPath, saltRelPath);
    if (!existsSync(saltAbs)) {
      writeRepoSaltFile(opts.repoPath, opts.saltB64);
      saltJustWritten = true;
      console.log(chalk.cyan(`+ wrote missing ${saltRelPath} (needed by GitHub Action workflow)`));
    }
  }

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
    // Pull --rebase --autostash before committing, so CI's auto-commits on
    // origin/<device> don't cause non-fast-forward push failures.
    try {
      const ff = await fastForwardBranch(git, opts.deviceBranch, (s) => console.log(chalk.gray(`  ${s}`)));
      if (!ff.pulled && ff.reason === "no-tracking") {
        console.log(chalk.gray(`  no remote ${opts.deviceBranch} yet — first push will create it`));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`! could not sync local branch with origin: ${msg}`));
      console.log(chalk.cyan(`  Skipping push. Resolve in ${opts.repoPath} and re-run \`vibebook sync\`.`));
      // Bail before commit — we don't want to leave an orphaned local commit
      // that the user can't push.
      return {
        newCount, skippedCount, pathsWritten,
        committed: false, pushed: false,
        digestStatus: "not-attempted",
        digestCommitted: false, digestPushed: false,
      };
    }
    const all = [...pathsWritten, indexPath];
    if (saltJustWritten) all.push(saltRelPath);
    if (dataDirMig.migrated && dataDirMig.viaGit) {
      // Stage the renamed dir contents so `git mv` is recorded in this commit.
      // (git mv already staged them, but adding by path is idempotent and keeps
      // commitAndPush's add+status logic uniform.)
      for (const p of migratedDataDirPaths(opts.repoPath)) all.push(p);
    }
    console.log(chalk.gray(`Staging ${all.length} paths and committing...`));
    const commitMsg = newCount > 0
      ? `vibebook sync: +${newCount} sessions${dataDirMig.migrated ? " (+ rename .memvc/→.vibebook/)" : ""}`
      : (saltJustWritten ? "vibebook: backfill repo-salt.json for CI" :
         (dataDirMig.migrated ? "vibebook: rename .memvc/ → .vibebook/" :
          `vibebook sync: +${newCount} sessions`));
    const r = await commitAndPush(
      git,
      commitMsg,
      all,
      opts.deviceBranch,
      (stage) => console.log(chalk.gray(`  ${stage}`)),
    );
    committed = r.committed; pushed = r.pushed;
    if (committed && !pushed) {
      if (r.pushResult?.secretBlocked) {
        console.log(chalk.red(
          "\n  Push blocked by GitHub secret-scanning (GH013). Your raw_sessions contain something that looks like a real secret (token, API key) — typically because past AI conversations included one verbatim.",
        ));
        console.log(chalk.cyan(
          "  Tip: enable encryption to scrub secrets from future syncs — set `encrypt: true` in ~/.vibebook/config.json, save a passphrase to ~/.vibebook/passphrase, then delete raw_sessions/ + .vibebook/index.json and re-sync.",
        ));
        console.log(chalk.gray(
          "  Or unblock manually via the GitHub URL above (not recommended for real tokens).",
        ));
        const { promptYesNo, closePrompts } = await import("../prompts.js");
        const cont = await promptYesNo("\n  Continue with digest phase? (you can `git push` manually later)", true);
        closePrompts();
        if (!cont) {
          console.log(chalk.gray("Aborted."));
          return {
            newCount, skippedCount, pathsWritten,
            committed, pushed,
            digestStatus: "not-attempted",
            digestCommitted: false, digestPushed: false,
          };
        }
      } else {
        console.log(chalk.yellow("Commit done, push failed or skipped."));
      }
    }
  } else if (opts.push && !opts.repoUrl) {
    console.log(chalk.gray("Local-only mode (no remote URL configured); skipping commit/push."));
  }

  // -------------------- Phases 3-7 (digest) + phase 8 (book push) --------------------
  let digestStatus: DigestStatus = "not-attempted";
  let digestError: string | undefined;
  let digestReport: DigestReport | undefined;
  let digestCommitted = false, digestPushed = false;

  if (opts.noDigest) {
    digestStatus = "skipped-flag";
  } else if (!opts.runnerConfig) {
    digestStatus = "skipped-no-runner";
    console.log(chalk.yellow("Digest pipeline skipped: no runnerConfig provided."));
  } else if (opts.runnerConfig.runner === "github-action" && process.env.VIBEBOOK_CI !== "1") {
    digestStatus = "skipped-flag";
    console.log(chalk.cyan("\nDigest delegated to GitHub Action (runner='github-action'); will run in CI on next push."));
  } else {
    console.log(chalk.gray("\nRunning digest pipeline (phases 3-7)..."));
    const bookIndex = loadBookIndex(opts.repoPath);
    const runner = createRunner(opts.runnerConfig);
    try {
      digestReport = await runDigest(runner, opts.repoPath, idx, bookIndex, key, opts.threadingConcurrency ?? DEFAULT_THREADING_CONCURRENCY, opts.threadingMaxAttempts ?? DEFAULT_THREADING_MAX_ATTEMPTS, consoleReporter());
      saveBookIndex(opts.repoPath, bookIndex);
      digestStatus = "ok";
      const failedBatchSuffix = digestReport.threadingBatchesFailed > 0
        ? `; ${digestReport.threadingBatchesFailed} threading batch${digestReport.threadingBatchesFailed === 1 ? "" : "es"} failed (will retry next sync)`
        : "";
      console.log(chalk.gray(
        `  digest: +${digestReport.articlesOk} articles, ${digestReport.threadsSkipped} skip, ${digestReport.articlesFailed} fail; chapters [${digestReport.chaptersRewritten.join(", ")}]${failedBatchSuffix}`,
      ));
      if (digestReport.articleFailures.length > 0) {
        for (const f of digestReport.articleFailures) {
          console.log(chalk.yellow(`    ! article ${f.threadId} failed: ${f.error.replace(/\s+/g, " ").slice(0, 200)}`));
        }
      }
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
        `vibebook digest: +${digestReport.articlesOk} articles, ${digestReport.chaptersRewritten.length} chapters`,
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
 *   - .vibebook/index.book.json
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
  out.add(BOOK_INDEX_REL);
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

/**
 * Pure helper: returns a possibly-migrated copy of cfg with deviceBranch set
 * from hostname when the input is missing/empty. `migrated` indicates whether
 * a write-back is needed.
 */
export function ensureDeviceBranchOnConfig(cfg: Config): { migrated: boolean; cfg: Config } {
  if (cfg.deviceBranch && cfg.deviceBranch.trim() !== "") {
    return { migrated: false, cfg };
  }
  return {
    migrated: true,
    cfg: { ...cfg, deviceBranch: deviceBranchFromHostname() },
  };
}

/**
 * Loads ~/.vibebook/config.json and applies any in-place migrations needed by
 * current code (currently: deviceBranch self-heal). On migration, writes the
 * fixed config back to disk. Used by both syncCmd and digestCmd.
 */
export function readConfigWithMigration(): Config {
  const rawCfg = readConfig();
  const heal = ensureDeviceBranchOnConfig(rawCfg);
  if (heal.migrated) {
    console.log(chalk.cyan(
      `Migrating: legacy config missing deviceBranch. Setting to "${heal.cfg.deviceBranch}" and saving to ~/.vibebook/config.json.`,
    ));
    writeConfig(heal.cfg);
  }
  return heal.cfg;
}

export async function syncCmd(opts: { noDigest?: boolean } = {}): Promise<void> {
  const cfg = readConfigWithMigration();
  const passphrase = cfg.encrypt ? getPassphrase() : undefined;
  // Honor config.digestEnabled: treat digestEnabled=false like --no-digest.
  const noDigest = opts.noDigest || cfg.digestEnabled === false;
  const r = await runSync({
    repoPath: cfg.repoPath,
    encrypt: cfg.encrypt,
    passphrase,
    saltB64: cfg.salt,
    push: true,
    repoUrl: cfg.repoUrl,
    deviceBranch: cfg.deviceBranch,
    noDigest,
    runnerConfig: { runner: cfg.runner, runnerModel: cfg.runnerModel },
    threadingConcurrency: cfg.threadingConcurrency,
    threadingMaxAttempts: cfg.threadingMaxAttempts,
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
  } else if (r.digestStatus === "skipped-flag") {
    console.log(chalk.gray("Digest skipped (--no-digest)."));
  } else if (r.digestStatus === "skipped-no-runner") {
    console.log(chalk.yellow("Digest skipped (no runner configured)."));
  }
}
