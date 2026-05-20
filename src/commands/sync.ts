import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { ClaudeCodeAdapter } from "../sources/claude-code.js";
import { VSCodeCopilotAdapter } from "../sources/vscode-copilot.js";
import type { SourceAdapter } from "../sources/base.js";
import { loadIndex, saveIndex, hasUnchanged, upsertEntry } from "../index-store.js";
import type { IndexEntry } from "../types.js";
import { lookupOrigin } from "./resume/fork.js";
import { writeSession } from "../writer.js";
import { readConfig, writeConfig, writeRepoSaltFile, type Config } from "../config.js";
import { deviceBranchFromHostname } from "../device.js";
import { ensureRepo, commitAndPush, ensureDeviceBranch, fastForwardBranch } from "../git-ops.js";
import { migrateLegacyMainToDevice, migrateLegacyDataDir, migratedDataDirPaths } from "../migrate.js";
import { INDEX_REL, REPO_SALT_REL, LEGACY_REPO_DATA_DIR } from "../repo-data-dir.js";
import { ensureCryptFilter } from "./crypt.js";

/**
 * `vibebook sync` — extract jsonl from local sources (Claude Code + VS Code
 * Copilot Chat), write per-session raw + md to the user's git repo as
 * **plaintext**, then commit + push to the device branch.
 *
 * Encryption (when enabled) happens transparently via the git clean filter
 * wired up by `vibebook crypt init`. The working tree is always plaintext;
 * only git's object database (and therefore the remote) holds ciphertext.
 *
 * vibebook v0.2 explicitly does NOT call any LLM here. The book-writing
 * pipeline is the in-session `/vibebook` slash command driven by skills/
 * vibebook/SKILL.md, calling `vibebook prepare` + `vibebook publish`.
 */
export interface SyncOptions {
  repoPath: string;
  claudeRoot?: string;
  vscodeRoot?: string;
  /** Whether the configured repo wants encryption. Drives whether we wire
   *  the git filter; never used to encrypt files in-process. */
  encrypt: boolean;
  saltB64?: string;
  push?: boolean;
  repoUrl?: string;
  deviceBranch?: string;
  /** Render assistant reasoning into raw_sessions/*.md as `> 💭`
   *  blockquotes. Caller wires this from cfg.includeReasoning. Default true. */
  includeReasoning?: boolean;
}

export interface SyncResult {
  newCount: number;
  skippedCount: number;
  pathsWritten: string[];
  committed: boolean;
  pushed: boolean;
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  // One-shot migration: rename legacy `.memvc/` → `.vibebook/` if present.
  // Done before loadIndex so the read picks up the file at its new location.
  const dataDirMig = await migrateLegacyDataDir(opts.repoPath);
  if (dataDirMig.migrated) {
    console.log(chalk.cyan(`Migrating: renamed legacy ${LEGACY_REPO_DATA_DIR}/ → .vibebook/ ${dataDirMig.viaGit ? "(via git mv; staged for next commit)" : "(non-git mode)"}`));
  }

  // Wire the git crypt filter idempotently. On a fresh clone, this is also
  // what re-checks-out raw_sessions/ as plaintext via smudge.
  if (opts.encrypt && existsSync(join(opts.repoPath, ".git"))) {
    try {
      const r = ensureCryptFilter(opts.repoPath);
      if (r.wired && r.wroteAttrs) {
        console.log(chalk.cyan(`+ wired git filter \`vibebook\` (also wrote .gitattributes)`));
      }
    } catch (err) {
      console.log(chalk.yellow(`! could not wire git crypt filter: ${(err as Error).message}`));
    }
  }

  const adapters: SourceAdapter[] = [
    new ClaudeCodeAdapter(opts.claudeRoot),
    new VSCodeCopilotAdapter(opts.vscodeRoot),
  ];

  const idx = loadIndex(opts.repoPath);

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
      if (hasUnchanged(idx, s.tool, s.sessionId, d.sourceMtimeMs, d.sourceSha256, opts.repoPath)) {
        skippedCount++;
        continue;
      }
      const rel = writeSession(opts.repoPath, s, { includeReasoning: opts.includeReasoning });

      // Working tree is always plaintext now; the clean filter handles
      // encryption on `git add` if enabled.
      pathsWritten.push(rel.raw, rel.md);
      if (rel.jsonl) pathsWritten.push(rel.jsonl);

      const entry: IndexEntry = {
        sessionId: s.sessionId,
        shortId: s.shortId,
        tool: s.tool,
        project: s.project,
        projectRaw: s.projectRaw,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        nameSlug: s.nameSlug,
        displayName: s.displayName,
        relativePath: rel.raw,
        sourcePath: s.sourcePath,
        sourceMtimeMs: d.sourceMtimeMs,
        sourceSha256: d.sourceSha256,
      };
      // If this device created the session via `vibebook resume <id>`, the
      // fork registry maps the new sessionId back to its origin. Stamp it
      // onto the entry so plugin-side digest can group same-source threads.
      const fork = lookupOrigin(s.sessionId);
      if (fork) entry.originSessionId = fork.originSessionId;
      upsertEntry(idx, entry);
      newCount++;
      console.log(chalk.green(`+ ${s.tool}/${s.project}/${s.nameSlug} (${s.shortId})`));
    }
  }

  saveIndex(opts.repoPath, idx);

  // Self-heal: encryption is on but the repo is missing .vibebook/repo-salt.json
  // (legacy repo or someone git-rm'd it). Salt is not sensitive — security
  // relies on the passphrase. Always restage the path on encrypted-mode sync;
  // git no-ops if there's nothing new.
  const saltRelPath = REPO_SALT_REL;
  let saltStaged = false;
  if (opts.encrypt && opts.saltB64) {
    const saltAbs = join(opts.repoPath, saltRelPath);
    if (!existsSync(saltAbs)) {
      writeRepoSaltFile(opts.repoPath, opts.saltB64);
      console.log(chalk.cyan(`+ wrote missing ${saltRelPath} (needed by GitHub Action workflow)`));
    }
    saltStaged = true;
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
      return { newCount, skippedCount, pathsWritten, committed: false, pushed: false };
    }
    const all = [...pathsWritten, INDEX_REL];
    if (saltStaged) all.push(saltRelPath);
    if (opts.encrypt) all.push(".gitattributes");
    if (dataDirMig.migrated && dataDirMig.viaGit) {
      for (const p of migratedDataDirPaths(opts.repoPath)) all.push(p);
    }
    console.log(chalk.gray(`Staging ${all.length} paths and committing...`));
    const commitMsg = newCount > 0
      ? `vibebook sync: +${newCount} sessions${dataDirMig.migrated ? " (+ rename .memvc/→.vibebook/)" : ""}`
      : (saltStaged ? "vibebook: backfill repo-salt.json for CI" :
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
          "  Tip: enable encryption (`encrypt: true` in ~/.vibebook/config.json) so the git filter scrubs raw_sessions before push, then re-sync.",
        ));
      } else {
        console.log(chalk.yellow("Commit done, push failed or skipped."));
      }
    }
  } else if (opts.push && !opts.repoUrl) {
    console.log(chalk.gray("Local-only mode (no remote URL configured); skipping commit/push."));
  }

  return { newCount, skippedCount, pathsWritten, committed, pushed };
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
 * fixed config back to disk.
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

export async function syncCmd(): Promise<void> {
  const cfg = readConfigWithMigration();
  const r = await runSync({
    repoPath: cfg.repoPath,
    encrypt: cfg.encrypt,
    saltB64: cfg.salt,
    push: true,
    repoUrl: cfg.repoUrl,
    deviceBranch: cfg.deviceBranch,
    includeReasoning: cfg.includeReasoning,
  });
  console.log(chalk.bold(`\nSynced: +${r.newCount} new, ${r.skippedCount} unchanged`));
  if (r.committed) console.log(chalk.cyan(r.pushed ? "Pushed." : "Committed (push failed)."));
  if (r.newCount > 0) {
    console.log(chalk.cyan("\nNext: in Claude Code, run `/vibebook` to digest into chronicle/topics/cards."));
  }
}
