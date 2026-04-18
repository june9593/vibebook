import type { RunOptions, RunResult } from "../runner.js";

export async function runClaudeCli(
  _prompt: string,
  _model: string,
  _opts: RunOptions,
): Promise<RunResult> {
  return {
    ok: false,
    error: "claude-cli runner not yet implemented in this commit (filled in next task)",
    durationMs: 0,
  };
}
