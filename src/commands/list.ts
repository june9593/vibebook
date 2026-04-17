import chalk from "chalk";
import { readConfig } from "../config.js";
import { loadIndex } from "../index-store.js";
import type { Tool } from "../types.js";

export interface ListOptions {
  tool?: Tool;
  project?: string;
}

export async function listCmd(opts: ListOptions): Promise<void> {
  const cfg = readConfig();
  const idx = loadIndex(cfg.repoPath);
  const rows = Object.values(idx.entries)
    .filter((e) => !opts.tool || e.tool === opts.tool)
    .filter((e) => !opts.project || e.project === opts.project)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (rows.length === 0) { console.log(chalk.gray("(no sessions)")); return; }
  for (const e of rows) {
    const date = e.startedAt.slice(0, 10);
    console.log(`${chalk.gray(date)}  ${chalk.cyan(e.tool)}  ${chalk.yellow(e.project)}  ${e.displayName}  ${chalk.gray(e.shortId)}`);
  }
}
