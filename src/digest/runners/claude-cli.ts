import { spawn } from "node:child_process";
import type { RunOptions, RunResult } from "../runner.js";

const DEFAULT_TIMEOUT_MS = 180_000;

export async function runClaudeCli(
  prompt: string,
  model: string,
  opts: RunOptions,
): Promise<RunResult> {
  const started = Date.now();
  const args: string[] = ["-p", "--output-format", opts.outputFormat ?? "json"];
  if (model.trim().length > 0) {
    args.push("--model", model);
  }

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let proc;
    try {
      proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      settle({
        ok: false,
        error: `failed to spawn claude: ${(err as Error).message}`,
        durationMs: Date.now() - started,
      });
      return;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    timer = setTimeout(() => {
      proc.kill?.("SIGTERM");
      settle({
        ok: false,
        error: `claude-cli timeout after ${timeoutMs}ms`,
        durationMs: Date.now() - started,
      });
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      settle({
        ok: false,
        error: `claude-cli spawn error: ${err.message}`,
        durationMs: Date.now() - started,
      });
    });

    proc.on("close", (code) => {
      const durationMs = Date.now() - started;
      if (code !== 0) {
        const tail = stderr.trim().slice(-500);
        settle({
          ok: false,
          error: `claude-cli exit code ${code}${tail ? `: ${tail}` : ""}`,
          durationMs,
        });
        return;
      }
      // Text mode: return stdout as-is.
      if ((opts.outputFormat ?? "json") === "text") {
        settle({ ok: true, text: stdout, durationMs });
        return;
      }
      // JSON mode (default): parse and extract result.
      try {
        const parsed = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
        if (parsed.is_error) {
          settle({ ok: false, error: `claude-cli reported is_error`, durationMs });
          return;
        }
        if (typeof parsed.result !== "string") {
          settle({ ok: false, error: "claude-cli output missing 'result' string", durationMs });
          return;
        }
        settle({ ok: true, text: parsed.result, durationMs });
      } catch (err) {
        settle({
          ok: false,
          error: `failed to parse claude-cli JSON: ${(err as Error).message}`,
          durationMs,
        });
      }
    });

    proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}
