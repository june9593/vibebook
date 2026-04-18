import { describe, it, expect, afterEach } from "vitest";
import { createRunner } from "../../src/digest/runner.js";

describe("createRunner factory", () => {
  it("returns an object with a .run() function for claude-cli", () => {
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    expect(typeof r.run).toBe("function");
  });

  it("returns a runner for anthropic-api", () => {
    const r = createRunner({ runner: "anthropic-api", runnerModel: "" });
    expect(typeof r.run).toBe("function");
  });

  it("returns a runner for github-models", () => {
    const r = createRunner({ runner: "github-models", runnerModel: "" });
    expect(typeof r.run).toBe("function");
  });
});

describe("anthropic-api runner stub", () => {
  it("returns ok:false with a clear 'not implemented' error", async () => {
    const r = createRunner({ runner: "anthropic-api", runnerModel: "" });
    const res = await r.run("hello", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not implemented/i);
  });
});

describe("github-models runner stub", () => {
  it("returns ok:false with a clear 'not implemented' error", async () => {
    const r = createRunner({ runner: "github-models", runnerModel: "" });
    const res = await r.run("hello", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not implemented/i);
  });
});

import { vi } from "vitest";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return { ...orig, spawn: vi.fn() };
});

function fakeSpawn(stdout: string, exitCode: number, opts: { delayMs?: number } = {}) {
  const spawnMock = vi.mocked(childProcess.spawn);
  spawnMock.mockImplementation(() => {
    const proc = new EventEmitter() as childProcess.ChildProcess;
    const stdoutEm = new EventEmitter() as NodeJS.ReadableStream;
    const stderrEm = new EventEmitter() as NodeJS.ReadableStream;
    const stdinChunks: string[] = [];
    const stdin = {
      write: (c: string | Buffer) => { stdinChunks.push(c.toString()); return true; },
      end: () => {},
    } as unknown as NodeJS.WritableStream;
    (proc as any).stdout = stdoutEm;
    (proc as any).stderr = stderrEm;
    (proc as any).stdin = stdin;
    (proc as any).kill = vi.fn();
    setTimeout(() => {
      stdoutEm.emit("data", Buffer.from(stdout));
      proc.emit("close", exitCode);
    }, opts.delayMs ?? 0);
    return proc;
  });
  return spawnMock;
}

describe("claude-cli runner", () => {
  afterEach(() => vi.resetAllMocks());

  it("returns ok:true with parsed result text on exit code 0", async () => {
    fakeSpawn(JSON.stringify({ result: "hello world", is_error: false }), 0);
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    const res = await r.run("say hi", {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe("hello world");
  });

  it("substitutes {{var}} placeholders in the prompt before spawning", async () => {
    const spy = fakeSpawn(JSON.stringify({ result: "ok" }), 0);
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    await r.run("hello {{name}}!", { name: "Yue" });
    const argv = spy.mock.calls[0][1] as string[];
    expect(argv).toContain("-p");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("json");
    expect(argv).not.toContain("--model");
  });

  it("passes --model when runnerModel is non-empty", async () => {
    const spy = fakeSpawn(JSON.stringify({ result: "ok" }), 0);
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "claude-opus-4-6" });
    await r.run("x", {});
    const argv = spy.mock.calls[0][1] as string[];
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-4-6");
  });

  it("returns ok:false when exit code is non-zero", async () => {
    fakeSpawn("", 1);
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    const res = await r.run("x", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exit code 1/);
  });

  it("returns ok:false when stdout is not valid JSON", async () => {
    fakeSpawn("not json {", 0);
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    const res = await r.run("x", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/parse/i);
  });

  it("returns ok:false when timeout elapses", async () => {
    fakeSpawn(JSON.stringify({ result: "late" }), 0, { delayMs: 50 });
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    const res = await r.run("x", {}, { timeoutMs: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/timeout/i);
  });

  it("returns ok:false when spawn throws synchronously (no TDZ on timer)", async () => {
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      throw new Error("EACCES");
    });
    const { createRunner } = await import("../../src/digest/runner.js");
    const r = createRunner({ runner: "claude-cli", runnerModel: "" });
    const res = await r.run("x", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/failed to spawn claude/);
  });
});
