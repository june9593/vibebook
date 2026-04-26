import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { readConfig, getPassphrase } from "../config.js";
import { deriveKey, encryptDeterministic, decrypt, isEncryptedBlob } from "../crypto.js";

/**
 * Encrypt-on-push, decrypt-on-checkout via git's clean/smudge filter.
 *
 * Working tree: ALWAYS plaintext .md / .raw.json. The skill, /vibebook, and
 * any human reading the repo see plain text. Only git's object database
 * (and therefore the remote) holds ciphertext.
 *
 * Wiring:
 *   - .gitattributes (committed): `raw_sessions/** filter=vibebook diff=vibebook`
 *   - .git/config (per-clone, NOT committed): filter.vibebook.clean / .smudge
 *
 * On a fresh clone, raw_sessions/ checks out as ciphertext until the user
 * runs `vibebook crypt init` (or `vibebook init` / `vibebook sync`, both of
 * which call this idempotently). Once configured, `git checkout -- raw_sessions/`
 * re-runs the smudge filter and the working tree becomes plaintext.
 *
 * Self-heal: clean and smudge fall through to identity when the config has
 * encryption disabled OR the input lacks our MAGIC header (so plaintext-mode
 * repos and pre-encryption history both work).
 */

const FILTER_NAME = "vibebook";
const ATTR_REL = ".gitattributes";
const ATTR_LINE = "raw_sessions/** filter=vibebook diff=vibebook";
const ATTR_HEADER = "# vibebook: encrypt raw_sessions on push, decrypt on checkout";

interface KeyOrNull {
  key: Buffer | null;
}

function maybeKey(): KeyOrNull {
  const cfg = readConfig();
  if (!cfg.encrypt) return { key: null };
  return { key: deriveKey(getPassphrase(), Buffer.from(cfg.salt, "base64")) };
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Filter: plaintext on stdin → ciphertext (or pass-through) on stdout.
 * Invoked once per file by `git add` (and `git commit`, `git stash`, etc.).
 */
async function cleanFilter(): Promise<void> {
  const buf = await readStdin();
  const { key } = maybeKey();
  if (!key) { process.stdout.write(buf); return; }
  // Already ciphertext (e.g. someone manually staged a .enc file). Don't
  // double-encrypt. Pass through untouched.
  if (isEncryptedBlob(buf)) { process.stdout.write(buf); return; }
  process.stdout.write(encryptDeterministic(buf, key));
}

/**
 * Filter: ciphertext on stdin → plaintext (or pass-through) on stdout.
 * Invoked once per file by `git checkout`, `git clone`, `git merge`, etc.
 *
 * If we can't read the passphrase (encryption off in cfg, OR the file isn't
 * actually ours), we pass through untouched. That keeps plaintext-mode repos
 * + pre-encryption history working.
 */
async function smudgeFilter(): Promise<void> {
  const buf = await readStdin();
  if (!isEncryptedBlob(buf)) { process.stdout.write(buf); return; }
  let key: Buffer | null;
  try { key = maybeKey().key; } catch { key = null; }
  if (!key) {
    // Encrypted blob but no key available — pass through (working tree shows
    // ciphertext until user provides passphrase + re-runs `vibebook crypt init`).
    process.stdout.write(buf);
    return;
  }
  process.stdout.write(decrypt(buf, key));
}

/**
 * Wire the filter into a repo. Idempotent; safe to re-run on every sync.
 *   1. Set .git/config filter.vibebook.{clean,smudge,required}.
 *   2. Ensure .gitattributes has the raw_sessions/** line.
 * Caller passes repoPath; we shell out to `git -C <path> config` so this
 * works whether or not we're in the repo's cwd.
 */
function configureGitFilter(repoPath: string): { wroteAttrs: boolean } {
  const cliBin = process.env.VIBEBOOK_FILTER_BIN ?? "vibebook";
  // `required = true` makes git ABORT (rather than commit garbage) if the
  // filter command is missing. Better to fail loudly than to silently
  // commit plaintext to a ciphertext repo.
  execSync(`git -C ${shell(repoPath)} config filter.${FILTER_NAME}.clean ${shell(cliBin + " crypt clean")}`);
  execSync(`git -C ${shell(repoPath)} config filter.${FILTER_NAME}.smudge ${shell(cliBin + " crypt smudge")}`);
  execSync(`git -C ${shell(repoPath)} config filter.${FILTER_NAME}.required true`);
  // textconv lets `git diff` / `git log -p` show plaintext for committed blobs.
  execSync(`git -C ${shell(repoPath)} config diff.${FILTER_NAME}.textconv ${shell(cliBin + " crypt smudge")}`);

  const attrAbs = join(repoPath, ATTR_REL);
  const existing = existsSync(attrAbs) ? readFileSync(attrAbs, "utf8") : "";
  if (existing.includes(ATTR_LINE)) return { wroteAttrs: false };
  const block = (existing && !existing.endsWith("\n") ? "\n" : "") +
    `${ATTR_HEADER}\n${ATTR_LINE}\n`;
  if (existing) appendFileSync(attrAbs, block);
  else writeFileSync(attrAbs, `${ATTR_HEADER}\n${ATTR_LINE}\n`);
  return { wroteAttrs: true };
}

/**
 * After installing the filter, force git to re-stage raw_sessions/ so the
 * working-tree files match what's in the index now that clean is wired up.
 * Without this, files that existed before the filter was wired wouldn't be
 * re-cleaned until they were touched.
 *
 * Safe to call on a fresh clone (no-op if raw_sessions/ doesn't exist or
 * has nothing tracked).
 */
function refreshWorkingTree(repoPath: string): void {
  if (!existsSync(join(repoPath, "raw_sessions"))) return;
  // Drop raw_sessions from the index so checkout is forced to re-materialize
  // every file via the smudge filter. Without this, git sees the working tree
  // as up-to-date and skips smudge entirely.
  try {
    execSync(`git -C ${shell(repoPath)} rm --cached -r raw_sessions/`,
      { stdio: ["ignore", "ignore", "pipe"] });
  } catch {
    // raw_sessions/ may not be tracked yet (fresh repo before first sync).
    return;
  }
  execSync(`git -C ${shell(repoPath)} checkout HEAD -- raw_sessions/`,
    { stdio: ["ignore", "ignore", "pipe"] });
}

function shell(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function ensureGitDir(repoPath: string): void {
  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`not a git repo: ${repoPath} (run \`vibebook init\` first)`);
  }
}

export interface CryptInitResult {
  wired: boolean;
  reason?: string;
  wroteAttrs: boolean;
}

/**
 * Public entry point used by `vibebook init`, `vibebook sync`, and the user-
 * facing `vibebook crypt init` subcommand. Returns whether the filter was
 * wired (and a reason if skipped).
 */
export function ensureCryptFilter(repoPath: string): CryptInitResult {
  const cfg = readConfig();
  if (!cfg.encrypt) return { wired: false, reason: "encryption disabled in config", wroteAttrs: false };
  ensureGitDir(repoPath);
  const { wroteAttrs } = configureGitFilter(repoPath);
  refreshWorkingTree(repoPath);
  return { wired: true, wroteAttrs };
}

/** CLI dispatcher: `vibebook crypt {clean,smudge,init,status}`. */
export async function cryptCmd(action: string): Promise<void> {
  switch (action) {
    case "clean":  return cleanFilter();
    case "smudge": return smudgeFilter();
    case "init": {
      const cfg = readConfig();
      const r = ensureCryptFilter(cfg.repoPath);
      if (!r.wired) {
        console.log(chalk.yellow(`crypt init skipped: ${r.reason}`));
        return;
      }
      console.log(chalk.green(`✓ git filter \`${FILTER_NAME}\` wired in ${cfg.repoPath}`));
      if (r.wroteAttrs) console.log(chalk.gray(`  ${ATTR_REL} updated (commit it; the line is what tells other clones to use the filter)`));
      console.log(chalk.gray(`  raw_sessions/ working tree refreshed via smudge`));
      return;
    }
    case "status": {
      const cfg = readConfig();
      ensureGitDir(cfg.repoPath);
      try {
        const clean = execSync(`git -C ${shell(cfg.repoPath)} config --get filter.${FILTER_NAME}.clean`).toString().trim();
        const smudge = execSync(`git -C ${shell(cfg.repoPath)} config --get filter.${FILTER_NAME}.smudge`).toString().trim();
        console.log(`encrypt:    ${cfg.encrypt}`);
        console.log(`clean:      ${clean}`);
        console.log(`smudge:     ${smudge}`);
        console.log(`attributes: ${existsSync(join(cfg.repoPath, ATTR_REL)) && readFileSync(join(cfg.repoPath, ATTR_REL), "utf8").includes(ATTR_LINE) ? "wired" : "MISSING — run `vibebook crypt init`"}`);
      } catch {
        console.log(chalk.yellow(`filter \`${FILTER_NAME}\` not configured. Run \`vibebook crypt init\`.`));
      }
      return;
    }
    default:
      throw new Error(`unknown crypt action: ${action} (expected: clean | smudge | init | status)`);
  }
}
