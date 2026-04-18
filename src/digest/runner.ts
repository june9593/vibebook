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
  }
}
