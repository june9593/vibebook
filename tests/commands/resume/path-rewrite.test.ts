import { describe, it, expect } from "vitest";
import { rewriteJsonlPaths, type PathMap } from "../../../src/commands/resume/path-rewrite.js";

describe("rewriteJsonlPaths", () => {
  it("rewrites cwd field via pathMap", () => {
    const pathMap: PathMap = { "/Users/yueA": "/Users/yueB" };
    const input = JSON.stringify({ cwd: "/Users/yueA/code/my-app", type: "user" }) + "\n";
    const output = rewriteJsonlPaths(input, pathMap);
    expect(output).toContain('"cwd":"/Users/yueB/code/my-app"');
    expect(output).not.toContain("yueA");
  });

  it("rewrites multiple occurrences across a multi-line jsonl", () => {
    const pathMap: PathMap = { "/Users/yueA": "/Users/yueB" };
    const input = [
      JSON.stringify({ cwd: "/Users/yueA/edge/src", type: "user" }),
      JSON.stringify({ tool_input: { file_path: "/Users/yueA/edge/src/main.cc" }, type: "tool_use" }),
      JSON.stringify({ tool_result: "Read /Users/yueA/edge/src/main.cc:42" }),
    ].join("\n") + "\n";
    const output = rewriteJsonlPaths(input, pathMap);
    expect(output).toContain("/Users/yueB/edge/src");
    expect(output).toContain("/Users/yueB/edge/src/main.cc");
    expect(output).not.toMatch(/yueA/);
  });

  it("longest-prefix wins when multiple pathMap entries could match", () => {
    const pathMap: PathMap = {
      "/Users/yueA": "/Users/yueB",
      "/Users/yueA/special": "/Users/yueB/SPECIAL",
    };
    const input = JSON.stringify({ cwd: "/Users/yueA/special/sub" }) + "\n";
    const output = rewriteJsonlPaths(input, pathMap);
    // Longer prefix wins → SPECIAL, not just yueB/special
    expect(output).toContain("/Users/yueB/SPECIAL/sub");
  });

  it("with empty pathMap, returns input unchanged", () => {
    const input = JSON.stringify({ cwd: "/Users/yueA/code/my-app" }) + "\n";
    expect(rewriteJsonlPaths(input, {})).toBe(input);
  });

  it("doesn't double-rewrite when prefix appears in already-rewritten content", () => {
    const pathMap: PathMap = { "/Users/yueA": "/Users/yueB" };
    // Sneaky case: only matches at boundaries, not inside e.g. "/Users/yueA-archive/..."
    const input = JSON.stringify({ cwd: "/Users/yueA-archive/old" }) + "\n";
    const output = rewriteJsonlPaths(input, pathMap);
    // Should NOT match the "/Users/yueA" prefix because next char is "-" not "/"
    expect(output).toBe(input);
  });
});
