import { runClaudeCli } from "./runners/claude-cli.js";
import { runAnthropicApi } from "./runners/anthropic-api.js";
import { runGithubModels } from "./runners/github-models.js";
import type { Config } from "../config.js";

export type RunResult =
  | { ok: true; text: string; durationMs: number }
  | { ok: false; error: string; durationMs: number };

export interface RunOptions {
  timeoutMs?: number;
  outputFormat?: "json" | "text";
  /** Working directory for the subprocess (claude-cli only). When omitted,
   *  uses process.cwd(), which causes Claude to log session history under
   *  ~/.claude/projects/<hash-of-cwd>/. Pass an isolated tmp dir to prevent
   *  polluting the user's project history. */
  cwd?: string;
}

export interface LlmRunner {
  run(prompt: string, vars: Record<string, string>, opts?: RunOptions): Promise<RunResult>;
}

export type RunnerConfig = Pick<Config, "runner" | "runnerModel">;

/**
 * Substitute `{{key}}` placeholders in `prompt` with values from `vars`.
 * Used by every runner so prompt files can reference variables uniformly.
 */
export function renderPrompt(prompt: string, vars: Record<string, string>): string {
  return prompt.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : `{{${k}}}`,
  );
}

export function createRunner(cfg: RunnerConfig): LlmRunner {
  switch (cfg.runner) {
    case "claude-cli":
      return {
        run: (prompt, vars, opts) =>
          runClaudeCli(renderPrompt(prompt, vars), cfg.runnerModel, opts ?? {}),
      };
    case "anthropic-api":
      return {
        run: (prompt, vars, opts) =>
          runAnthropicApi(renderPrompt(prompt, vars), cfg.runnerModel, opts ?? {}),
      };
    case "github-models":
      return {
        run: (prompt, vars, opts) =>
          runGithubModels(renderPrompt(prompt, vars), cfg.runnerModel, opts ?? {}),
      };
    case "github-action": {
      // The "github-action" config value means "I'll run the digest from a GitHub
      // Action, not locally". When MEMVC_CI=1 (set by the workflow), we transparently
      // dispatch to the GitHub Models adapter, which authenticates via GITHUB_TOKEN.
      //
      // Local invocation should not pick this branch — `memvc init` only writes
      // "github-action" if the user picked it in the wizard, and the wizard rejects
      // it (see runWizard's Q6 loop).
      if (process.env.MEMVC_CI === "1") {
        return {
          run: (prompt, vars, opts) =>
            runGithubModels(renderPrompt(prompt, vars), cfg.runnerModel, opts ?? {}),
        };
      }
      throw new Error(
        "runner 'github-action' only works when run inside the GitHub Action (MEMVC_CI=1). For local digest runs, set runner to 'claude-cli'.",
      );
    }
  }
}
