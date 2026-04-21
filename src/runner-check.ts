import { spawn } from "node:child_process";

export interface RunnerCheckResult {
  ok: boolean;
  /** Captured stdout/stderr trimmed; useful for surfacing errors. */
  output: string;
  /** Install hint if !ok. */
  hint?: string;
}

/**
 * Spawn `cmd --version` (or any args you like) and return ok/output.
 * No timeout escalation: kills the child after `timeoutMs` (default 5s).
 */
export async function checkBinary(
  cmd: string,
  args: string[] = ["--version"],
  timeoutMs = 5000,
): Promise<RunnerCheckResult> {
  return new Promise((resolve) => {
    const out: string[] = [];
    let settled = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ ok: false, output: out.join(""), hint: `${cmd} timed out` });
    }, timeoutMs);

    child.stdout.on("data", (d) => out.push(d.toString()));
    child.stderr.on("data", (d) => out.push(d.toString()));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, output: out.join(""), hint: `${cmd} not found on PATH (${e.message})` });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, output: out.join("").trim() });
      else resolve({ ok: false, output: out.join("").trim(), hint: `${cmd} exited with ${code}` });
    });
  });
}

const RUNNER_HINTS: Record<string, { binary: string; install: string }> = {
  "claude-cli": {
    binary: "claude",
    install: "https://docs.claude.com/claude-code/installation",
  },
};

/** Return null if runner not known to need a local binary. */
export function runnerBinary(runner: string): string | null {
  return RUNNER_HINTS[runner]?.binary ?? null;
}

export function runnerInstallUrl(runner: string): string | null {
  return RUNNER_HINTS[runner]?.install ?? null;
}
