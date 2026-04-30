import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** Read version straight from the bundled package.json so we can never
 *  ship a CLI whose --version lies. Two layouts to handle:
 *    dev: src/cli.ts → ../package.json
 *    built: dist/src/cli.js → ../../package.json */
function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../package.json", "../../package.json", "../../../package.json"]) {
    try {
      return JSON.parse(readFileSync(resolve(here, rel), "utf8")).version as string;
    } catch { /* try next */ }
  }
  return "0.0.0-unknown";
}

export async function run(argv: string[]) {
  const program = new Command();
  program
    .name("vibebook")
    .description("Vibe coding memory book")
    // Standard CLI convention: -v + --version. Commander defaults to -V
    // (uppercase) which most users don't reach for; we override to lowercase.
    .version(readPackageVersion(), "-v, --version", "print the installed vibebook version");
  program
    .command("init [repoUrl]")
    .description("Initialize vibebook. Run with no arguments for the interactive wizard, or pass a repoUrl + flags for non-interactive setup.")
    .option("--local-path <path>", "local checkout path (default ./.vibebook/repo)")
    .option("--encrypt", "encrypt raw files before commit")
    .option("--no-digest", "skip the digest pipeline (raw push only)")
    .option("--device <name>", "device branch name (default: sanitized os.hostname())")
    .option("--passphrase <pp>", "save passphrase to ~/.vibebook/passphrase (only with --encrypt)")
    .action(async (
      repoUrl: string | undefined,
      opts: { localPath?: string; encrypt?: boolean; digest?: boolean; device?: string; passphrase?: string },
    ) => {
      const { initCmd } = await import("./commands/init.js");
      await initCmd({
        repoUrl,
        localPath: opts.localPath,
        encrypt: opts.encrypt,
        digestEnabled: opts.digest !== false,
        device: opts.device,
        passphrase: opts.passphrase,
      });
    });
  program
    .command("sync")
    .description("Extract sessions from local Claude Code + VS Code Copilot Chat, commit + push to your device branch. No LLM call. Run /vibebook in Claude Code afterward to digest.")
    .action(async () => {
      const { syncCmd } = await import("./commands/sync.js");
      await syncCmd();
    });
  program
    .command("prepare")
    .description("Emit JSON describing new sessions + existing topics/cards. Consumed by the /vibebook skill in Claude Code.")
    .option("--project <slug>", "limit to one project (default: all real projects)")
    .option("--cwd <path>", "auto-resolve --project from this cwd via projectSlugFromPath + index lookup")
    .action(async (opts: { project?: string; cwd?: string }) => {
      const { prepareCmd } = await import("./commands/prepare.js");
      await prepareCmd({ project: opts.project, cwd: opts.cwd });
    });
  program
    .command("list-projects")
    .description("Print per-project session + artifact counts. Consumed by the global-mode /vibebook skill to decide where to fan-out subagents.")
    .action(async () => {
      const { listProjectsCmd } = await import("./commands/list-projects.js");
      await listProjectsCmd();
    });
  program
    .command("recall")
    .description("Three-stage progressive recall for an in-session Claude. Stage 1 (default): a project's TOPIC list + 1-line summaries (~5 KB). Stage 2 (--topic <slug>): chronicles for that topic with frontmatter (files_touched, commits, decisions, blockers, status). Stage 3: agent uses the Read tool on entry.path. When memex is on PATH, atomic-card entries are folded in.")
    .option("--cwd <path>", "auto-detect project from this absolute cwd (default process.cwd)")
    .option("--project <slug>", "override cwd resolution; catalog this project explicitly")
    .option("--topic <slug>", "stage 2: list chronicles for this topic with frontmatter")
    .option("--all", "catalog every project (no project filter)")
    .option("--no-memex", "skip the optional memex source even if memex is installed")
    .action(async (opts: { cwd?: string; project?: string; topic?: string; all?: boolean; memex?: boolean }) => {
      const { recallCmd } = await import("./commands/recall.js");
      await recallCmd({
        cwd: opts.cwd ?? process.cwd(),
        project: opts.project,
        topic: opts.topic,
        all: opts.all,
        noMemex: opts.memex === false,
      });
    });
  program
    .command("publish")
    .description("Read JSON inputs from /vibebook skill, write chronicles + topics + cards into book/, regen catalog, commit + push.")
    .option("--chronicles <path>", "JSON file with ChronicleInput[]")
    .option("--topics <path>", "JSON file with TopicInput[]")
    .option("--cards <path>", "[deprecated since 0.4] JSON file with CardInput[]; atomic cards now belong to memex (/memex-retro)")
    .option("--no-commit", "write files locally but don't commit/push")
    .option("--no-catalog", "skip book/index.md + book/_meta/timeline.md + book/<proj>/index.md regen (project-mode publish uses this; global mode does the regen once at the end of fan-out)")
    .action(async (opts: { chronicles?: string; topics?: string; cards?: string; commit?: boolean; catalog?: boolean }) => {
      const { publishCmd } = await import("./commands/publish.js");
      const r = await publishCmd({
        chroniclesPath: opts.chronicles,
        topicsPath: opts.topics,
        cardsPath: opts.cards,
        noCommit: opts.commit === false,
        noCatalog: opts.catalog === false,
      });
      console.log(JSON.stringify(r, null, 2));
    });
  program
    .command("serve")
    .description("Local dev server (astro dev) for the vibebook site, reading book/ + .vibebook/index.book.json from the configured session-repo. Open http://localhost:4321.")
    .action(async () => {
      const { serveSiteCmd } = await import("./commands/site.js");
      await serveSiteCmd({});
    });
  program
    .command("build-site")
    .description("Build the static vibebook site into <repoPath>/site-dist/. Suitable for GitHub Pages / Vercel / Netlify.")
    .option("--base <path>", "site base path (default '/'); for project-page deploys use '/<repo>/'")
    .option("--site-url <url>", "absolute site URL used for canonical / OG tags")
    .action(async (opts: { base?: string; siteUrl?: string }) => {
      const { buildSiteCmd } = await import("./commands/site.js");
      await buildSiteCmd({ base: opts.base, siteUrl: opts.siteUrl });
    });
  program
    .command("catalog-regen")
    .description("Regenerate book/index.md + book/_meta/timeline.md + book/<proj>/index.md from the existing book index. Used by global-mode /vibebook after subagent fan-out finishes.")
    .option("--no-commit", "write files locally but don't commit/push")
    .action(async (opts: { commit?: boolean }) => {
      const { catalogRegenCmd } = await import("./commands/catalog-regen.js");
      const r = await catalogRegenCmd({ noCommit: opts.commit === false });
      console.log(JSON.stringify(r, null, 2));
    });
  program
    .command("plugin-install")
    .description("Install vibebook as a Claude Code plugin (~/.claude/plugins/marketplaces/vibebook + cache). Equivalent to running `/plugin marketplace add june9593/vibebook` + `/plugin install vibebook@vibebook` from inside Claude Code, but works from a shell. Idempotent: re-runs as a no-op when already at the latest commit.")
    .option("--repo <owner/name>", "GitHub repo to install from (default: june9593/vibebook)")
    .action(async (opts: { repo?: string }) => {
      const { installPluginFromGitHub } = await import("./commands/plugin-install.js");
      const r = await installPluginFromGitHub({ repo: opts.repo });
      if (r.ok) console.log(`✓ ${r.message}`);
      else console.error(`✗ ${r.message}`);
      process.exit(r.ok ? 0 : 1);
    });
  program
    .command("workflow")
    .description("Manage the GitHub Action that aggregates device branches into main")
    .addCommand(
      new Command("init")
        .description("Write .github/workflows/vibebook-aggregate.yml + scripts/merge-books.mjs into the configured vibebook repo, then commit + push")
        .option("--force", "overwrite if files already exist")
        .option("--no-push", "write the files locally but don't auto commit + push")
        .action(async (opts: { force?: boolean; push?: boolean }) => {
          const { workflowInitCmd } = await import("./commands/workflow.js");
          // commander's --no-X sets opts.X=false when flag present, true otherwise.
          await workflowInitCmd({ force: opts.force, noPush: opts.push === false });
        }),
    )
    .addCommand(
      new Command("pages-init")
        .description("Write .github/workflows/vibebook-pages.yml — builds the static site and publishes to GitHub Pages on every push to main.")
        .option("--force", "overwrite if file already exists")
        .option("--no-push", "write the file locally but don't auto commit + push to main")
        .action(async (opts: { force?: boolean; push?: boolean }) => {
          const { workflowPagesInitCmd } = await import("./commands/workflow.js");
          await workflowPagesInitCmd({ force: opts.force, noPush: opts.push === false });
        }),
    );
  program
    .command("list")
    .description("List synced sessions")
    .option("--tool <name>", "filter by claude|copilot")
    .option("--project <name>", "filter by project")
    .action(async (opts: { tool?: "claude"|"copilot"; project?: string }) => {
      const { listCmd } = await import("./commands/list.js");
      await listCmd(opts);
    });
  program
    .command("show <ref>")
    .description("Show a session by sessionId, shortId, slug, or display name")
    .action(async (ref: string) => {
      const { showCmd } = await import("./commands/show.js");
      await showCmd(ref);
    });
  program
    .command("cat <path>")
    .description("Print a repo file to stdout, auto-decrypting `.enc` files. Path is absolute or relative to the configured repoPath. Used by the /vibebook skill to read encrypted session md.")
    .action(async (path: string) => {
      const { catCmd } = await import("./commands/cat.js");
      await catCmd(path);
    });
  program
    .command("crypt <action>")
    .description("Manage the git clean/smudge filter that encrypts raw_sessions/ on push and decrypts on checkout. Actions: init | status | clean | smudge. (`clean` and `smudge` are invoked by git itself, not by you.)")
    .action(async (action: string) => {
      const { cryptCmd } = await import("./commands/crypt.js");
      await cryptCmd(action);
    });
  await program.parseAsync(argv);
}
