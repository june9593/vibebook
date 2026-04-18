import type { RunOptions, RunResult } from "../runner.js";

export async function runGithubModels(
  _prompt: string,
  _model: string,
  _opts: RunOptions,
): Promise<RunResult> {
  return {
    ok: false,
    error: "github-models runner is not implemented yet (planned for Sprint 5)",
    durationMs: 0,
  };
}
