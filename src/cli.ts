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
    .command("upgrade")
    .description("Refresh the npm CLI (`npm install -g vibebook@latest`). Skips the npm step if vibebook is npm-link'd from a dev checkout. To update the Claude Code plugin, run `/plugin update vibebook` in any session.")
    .option("--no-cli", "skip the `npm install -g` step")
    .action(async (opts: { cli?: boolean }) => {
      const { upgradeCmd } = await import("./commands/upgrade.js");
      await upgradeCmd({ noCli: opts.cli === false });
    });
  program
    .command("doctor")
    .description("Health check: CLI version on PATH, npm latest, Claude plugin manifest + install entry, ~/.vibebook/config presence, git crypt filter (when encrypt=true), memex availability. Read-only and offline-tolerant.")
    .action(async () => {
      const { doctorCmd } = await import("./commands/doctor.js");
      await doctorCmd();
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
