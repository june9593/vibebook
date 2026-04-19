import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

// Capture spawn invocations.
const spawnCalls: { cmd: string; args: string[]; opts: unknown }[] = [];

vi.mock("node:child_process", () => {
  return {
    spawn: (cmd: string, args: string[], opts: unknown) => {
      spawnCalls.push({ cmd, args, opts });
      const proc = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: Writable;
        kill?: (sig?: string) => void;
      };
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
      proc.kill = () => undefined;
      // Emit a successful close on next tick with text mode result.
      setImmediate(() => {
        proc.stdout.push("hello");
        proc.stdout.push(null);
        proc.emit("close", 0);
      });
      return proc;
    },
  };
});

import { runClaudeCli } from "../../../src/digest/runners/claude-cli.js";

describe("runClaudeCli — spawn cwd plumbing", () => {
  beforeEach(() => { spawnCalls.length = 0; });

  it("passes opts.cwd through to spawn options", async () => {
    const r = await runClaudeCli("p", "", { outputFormat: "text", cwd: "/tmp/iso-cwd" });
    expect(r.ok).toBe(true);
    expect(spawnCalls.length).toBe(1);
    expect((spawnCalls[0]!.opts as { cwd?: string }).cwd).toBe("/tmp/iso-cwd");
  });

  it("leaves cwd undefined when not specified", async () => {
    await runClaudeCli("p", "", { outputFormat: "text" });
    expect((spawnCalls[0]!.opts as { cwd?: string }).cwd).toBeUndefined();
  });
});
