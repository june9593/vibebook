import { spawn } from "node:child_process";
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import chalk from "chalk";
import { readConfig } from "../config.js";

/**
 * `vibebook serve` and `vibebook build-site` are thin wrappers around
 * Astro. We ship the site template inside the vibebook npm package
 * (`site-template/`) and run astro from a per-user cache directory
 * (`~/.vibebook/site-cache/`) so node_modules + dist live somewhere
 * persistent without touching the user's session-repo working tree.
 *
 * Layout:
 *   <package>/site-template/             ← bundled with vibebook (template source)
 *   ~/.vibebook/site-cache/<sig>/        ← copy of template + node_modules + dist
 *
 * The cache is keyed by a signature of the template files so a vibebook
 * upgrade rebuilds cleanly. node_modules can be ~hundreds-of-MB so we
 * keep just the most recent signature; older ones are not pruned (rare
 * enough not to matter; user can `rm -rf ~/.vibebook/site-cache`).
 */

export interface SiteOptions {
  /** Override repo path (default: cfg.repoPath). */
  repoPath?: string;
  /** Override site base URL for build (default: "/" for serve, repo-derived for build). */
  base?: string;
  /** Override absolute site URL for build (e.g. https://user.github.io/repo). */
  siteUrl?: string;
}

interface SiteContext {
  templateDir: string;   // shipped template (read-only)
  cacheDir: string;      // per-signature working tree
  repoPath: string;
  base: string;
  siteUrl: string;
}

function siteContext(opts: SiteOptions): SiteContext {
  const cfg = readConfig();
  const repoPath = opts.repoPath ?? cfg.repoPath;
  // Locate the bundled template. Two layouts to support:
  //   dev (running .ts directly): src/commands/site.ts → ../../site-template
  //   built (running dist/src/commands/site.js): → ../../../site-template
  // npm-installed packages also flatten differently; probe both.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "site-template"),       // src/commands/
    resolve(here, "..", "..", "..", "site-template"), // dist/src/commands/
    resolve(here, "..", "..", "..", "..", "site-template"),
  ];
  const templateDir = candidates.find((c) => existsSync(join(c, "package.json")));
  if (!templateDir) {
    throw new Error(
      `vibebook site template not found. Tried:\n  ${candidates.join("\n  ")}\n` +
      `If you installed vibebook from npm, try \`npm install -g vibebook@latest\`.`,
    );
  }

  const sig = templateSignature(templateDir);
  const cacheDir = join(homedir(), ".vibebook", "site-cache", sig);
  return {
    templateDir,
    cacheDir,
    repoPath,
    base: opts.base ?? "/",
    siteUrl: opts.siteUrl ?? "http://localhost:4321",
  };
}

/** Hash the package.json + every astro/css/ts file. Cheap-ish: ~30 files. */
function templateSignature(templateDir: string): string {
  // We just use the package.json mtime + the package.json contents — astro
  // pages can change without bumping deps, but we always sync the latest
  // template files into the cache before running, so the lock-step is fine.
  const pkg = JSON.parse(readFileSync(join(templateDir, "package.json"), "utf8"));
  const seed = JSON.stringify({ name: pkg.name, version: pkg.version, deps: pkg.dependencies });
  // base32-ish trim
  return Buffer.from(seed).toString("base64url").slice(0, 12);
}

function syncTemplateInto(templateDir: string, cacheDir: string): void {
  // Copy every template file (excluding node_modules + dist) into the cache.
  // Idempotent — running twice is fine. We always do this because the user
  // might have just edited a page in the bundled template (npm-linked dev
  // workflow); preserving the cache's node_modules is the only optimization.
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const skip = new Set(["node_modules", "dist", ".astro"]);
  // First, wipe the cache's `src/` so files we removed from the template
  // (e.g. dropping a page) don't linger and break astro's static path
  // generation. node_modules + dist + .astro are preserved.
  const cacheSrc = join(cacheDir, "src");
  if (existsSync(cacheSrc)) rmSync(cacheSrc, { recursive: true, force: true });
  for (const name of readdirSync(templateDir)) {
    if (skip.has(name)) continue;
    const src = join(templateDir, name);
    const dst = join(cacheDir, name);
    cpSync(src, dst, { recursive: true });
  }
}

async function ensureNodeModules(cacheDir: string): Promise<void> {
  const nm = join(cacheDir, "node_modules");
  if (existsSync(nm)) {
    // Sanity: package.json + astro present?
    const astroBin = join(nm, ".bin", "astro");
    if (existsSync(astroBin)) return;
  }
  console.log(chalk.cyan(`  installing site template dependencies (one-time, ~1-2 min)...`));
  await runCmd("npm", ["install", "--no-audit", "--no-fund", "--silent"], cacheDir);
}

function runCmd(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => {
      if (code === 0) resolveP();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

// ---------- public commands ----------

export async function serveSiteCmd(opts: SiteOptions = {}): Promise<void> {
  const ctx = siteContext(opts);
  console.log(chalk.gray(`  template: ${ctx.templateDir}`));
  console.log(chalk.gray(`  cache:    ${ctx.cacheDir}`));
  console.log(chalk.gray(`  repo:     ${ctx.repoPath}`));
  syncTemplateInto(ctx.templateDir, ctx.cacheDir);
  await ensureNodeModules(ctx.cacheDir);
  console.log(chalk.cyan(`\n  vibebook serve — astro dev`));
  console.log(chalk.gray(`  open http://localhost:4321 in your browser; ctrl-c to stop\n`));
  await runCmd(
    "node",
    [join(ctx.cacheDir, "node_modules", "astro", "astro.js"), "dev"],
    ctx.cacheDir,
    { VIBEBOOK_REPO_PATH: ctx.repoPath },
  );
}

export async function buildSiteCmd(opts: SiteOptions = {}): Promise<{ outDir: string }> {
  const ctx = siteContext(opts);
  syncTemplateInto(ctx.templateDir, ctx.cacheDir);
  await ensureNodeModules(ctx.cacheDir);

  console.log(chalk.cyan(`\n  vibebook build-site — astro build`));
  await runCmd(
    "node",
    [join(ctx.cacheDir, "node_modules", "astro", "astro.js"), "build"],
    ctx.cacheDir,
    {
      VIBEBOOK_REPO_PATH: ctx.repoPath,
      VIBEBOOK_SITE_BASE: ctx.base,
      VIBEBOOK_SITE_URL: ctx.siteUrl,
    },
  );

  // Copy the built dist into <repoPath>/site-dist/ so the user can `git add`
  // it for GitHub Pages or inspect locally.
  const builtDist = join(ctx.cacheDir, "dist");
  const repoDist = join(ctx.repoPath, "site-dist");
  if (existsSync(repoDist)) {
    rmSync(repoDist, { recursive: true, force: true });
  }
  cpSync(builtDist, repoDist, { recursive: true });
  console.log(chalk.green(`\n  ok built to ${repoDist}`));
  return { outDir: repoDist };
}

void writeFileSync; void statSync;  // kept-warm imports for future helpers
