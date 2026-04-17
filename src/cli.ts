import { Command } from "commander";

export async function run(argv: string[]) {
  const program = new Command();
  program.name("memvc").description("Memory of vibe coding").version("0.1.0");
  program
    .command("init <repoUrl>")
    .description("Initialize memvc with a private repo")
    .option("--local-path <path>", "local checkout path (default ~/memvc-repo)")
    .option("--encrypt", "encrypt raw files before commit")
    .action(async (repoUrl: string, opts: { localPath?: string; encrypt?: boolean }) => {
      const { initCmd } = await import("./commands/init.js");
      await initCmd({ repoUrl, localPath: opts.localPath, encrypt: opts.encrypt });
    });
  program
    .command("sync")
    .description("Extract, commit, and push new sessions")
    .action(async () => {
      const { syncCmd } = await import("./commands/sync.js");
      await syncCmd();
    });
  program.command("list").description("List synced sessions").action(async () => {
    throw new Error("not implemented");
  });
  program.command("show <ref>").description("Show a session by slug or id").action(async () => {
    throw new Error("not implemented");
  });
  await program.parseAsync(argv);
}
