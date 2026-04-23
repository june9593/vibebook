import { Command } from "commander";

export async function run(argv: string[]) {
  const program = new Command();
  program.name("vibebook").description("Vibe coding memory book").version("0.1.0");
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
    .description("Extract, commit, push raw sessions; then run digest pipeline (phases 3-7) and push book branch")
    .option("--no-digest", "skip digest pipeline (only runs extract + raw push)")
    .action(async (opts: { digest?: boolean }) => {
      const { syncCmd } = await import("./commands/sync.js");
      // commander's --no-X sets opts.X = false when the flag is present, true otherwise.
      await syncCmd({ noDigest: opts.digest === false });
    });
  program
    .command("digest")
    .description("Digest pipeline operations: --redo retries failed; --reset wipes book/ and re-runs from scratch")
    .option("--redo", "retry all failed threads and force-rewrite every chapter")
    .option("--reset", "DESTRUCTIVE: wipe book/ + .vibebook/index.book.json, then run digest from scratch")
    .action(async (opts: { redo?: boolean; reset?: boolean }) => {
      const { digestCmd } = await import("./commands/digest.js");
      await digestCmd({ redo: opts.redo, reset: opts.reset });
    });
  program
    .command("workflow")
    .description("Manage the GitHub Action that runs digest in CI")
    .addCommand(
      new Command("init")
        .description("Write .github/workflows/vibebook-digest.yml into the configured vibebook repo, then commit + push")
        .option("--force", "overwrite if file already exists")
        .option("--no-push", "write the yaml locally but don't auto commit + push")
        .action(async (opts: { force?: boolean; push?: boolean }) => {
          const { workflowInitCmd } = await import("./commands/workflow.js");
          // commander's --no-X sets opts.X=false when flag present, true otherwise.
          await workflowInitCmd({ force: opts.force, noPush: opts.push === false });
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
  await program.parseAsync(argv);
}
