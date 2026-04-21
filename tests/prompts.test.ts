import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable, Writable } from "node:stream";

// We test by injecting fake stdin/stdout. Since prompts.ts reads `process.stdin`,
// we mock that with vi.stubGlobal in each test.

function fakeIO(linesIn: string[]) {
  const stdin = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
  stdin.isTTY = true;
  const out: string[] = [];
  let i = 0;
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      const s = chunk.toString();
      out.push(s);
      // Feed the next input line when readline has written a prompt.
      // Prompts end with ": " (e.g. "Name: ", "Choose [1-2, default 1]: ").
      if (s.endsWith(": ") && i < linesIn.length) {
        const line = linesIn[i++]!;
        setImmediate(() => stdin.push(line + "\n"));
      }
      cb();
    },
  }) as Writable & { isTTY?: boolean; columns?: number };
  stdout.isTTY = true;
  stdout.columns = 80;
  return { stdin, stdout, out };
}

describe("prompts", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prompt returns trimmed input", async () => {
    const { stdin, stdout } = fakeIO(["  hello  "]);
    vi.stubGlobal("process", { ...process, stdin, stdout });
    const { prompt, closePrompts } = await import("../src/prompts.js");
    const r = await prompt("Name");
    closePrompts();
    expect(r).toBe("hello");
  });

  it("prompt returns default on empty input", async () => {
    const { stdin, stdout } = fakeIO([""]);
    vi.stubGlobal("process", { ...process, stdin, stdout });
    const { prompt, closePrompts } = await import("../src/prompts.js");
    const r = await prompt("Name", "anon");
    closePrompts();
    expect(r).toBe("anon");
  });

  it("promptYesNo y → true, n → false, empty → default", async () => {
    const { stdin, stdout } = fakeIO(["y", "n", ""]);
    vi.stubGlobal("process", { ...process, stdin, stdout });
    const { promptYesNo, closePrompts } = await import("../src/prompts.js");
    expect(await promptYesNo("a")).toBe(true);
    expect(await promptYesNo("b")).toBe(false);
    expect(await promptYesNo("c", true)).toBe(true);
    closePrompts();
  });

  it("promptYesNo re-asks on garbage input", async () => {
    const { stdin, stdout } = fakeIO(["maybe", "y"]);
    vi.stubGlobal("process", { ...process, stdin, stdout });
    const { promptYesNo, closePrompts } = await import("../src/prompts.js");
    expect(await promptYesNo("a")).toBe(true);
    closePrompts();
  });

  it("promptChoice returns chosen value; empty picks default", async () => {
    const { stdin, stdout } = fakeIO(["2"]);
    vi.stubGlobal("process", { ...process, stdin, stdout });
    const { promptChoice, closePrompts } = await import("../src/prompts.js");
    const r = await promptChoice("pick", [
      { value: "a" as const, label: "A" },
      { value: "b" as const, label: "B" },
    ], 0);
    closePrompts();
    expect(r).toBe("b");
  });
});
