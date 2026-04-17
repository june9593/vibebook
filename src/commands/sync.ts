import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
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
import { readConfig, getPassphrase } from "../config.js";
import { ensureRepo, commitAndPush, ensureDeviceBranch } from "../git-ops.js";
import { migrateLegacyMainToDevice } from "../migrate.js";

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
}

export interface SyncResult {
  newCount: number;
  skippedCount: number;
  pathsWritten: string[];
  committed: boolean;
  pushed: boolean;
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

  return { newCount, skippedCount, pathsWritten, committed, pushed };
}

export async function syncCmd(): Promise<void> {
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
  });
  console.log(chalk.bold(`\nSynced: +${r.newCount} new, ${r.skippedCount} unchanged`));
  if (r.committed) console.log(chalk.cyan(r.pushed ? "Pushed." : "Committed (push failed)."));
}
