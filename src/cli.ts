import { Command } from "commander";

export async function run(argv: string[]) {
  const program = new Command();
  program.name("memvc").description("Memory of vibe coding").version("0.1.0");
  program.command("init <repoUrl>").description("Initialize memvc with a private repo").action(async () => {
    throw new Error("not implemented");
  });
  program.command("sync").description("Extract, commit, and push new sessions").action(async () => {
    throw new Error("not implemented");
  });
  program.command("list").description("List synced sessions").action(async () => {
    throw new Error("not implemented");
  });
  program.command("show <ref>").description("Show a session by slug or id").action(async () => {
    throw new Error("not implemented");
  });
  await program.parseAsync(argv);
}
