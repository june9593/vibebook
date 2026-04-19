import { Command } from "commander";

export async function run(argv: string[]) {
  const program = new Command();
  program.name("memvc").description("Memory of vibe coding").version("0.1.0");
  program
    .command("init <repoUrl>")
    .description("Initialize memvc with a private repo")
    .option("--local-path <path>", "local checkout path (default ~/memvc-repo)")
    .option("--encrypt", "encrypt raw files before commit")
    .option("--device <name>", "device branch name (default: sanitized os.hostname())")
    .action(async (repoUrl: string, opts: { localPath?: string; encrypt?: boolean; device?: string }) => {
      const { initCmd } = await import("./commands/init.js");
      await initCmd({ repoUrl, localPath: opts.localPath, encrypt: opts.encrypt, device: opts.device });
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
    .option("--reset", "DESTRUCTIVE: wipe book/ + .memvc/index.book.json, then run digest from scratch")
    .action(async (opts: { redo?: boolean; reset?: boolean }) => {
      const { digestCmd } = await import("./commands/digest.js");
      await digestCmd({ redo: opts.redo, reset: opts.reset });
    });
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
