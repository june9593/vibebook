import { describe, it, expect } from "vitest";
import { buildTocEntries, renderTocMarkdown } from "../../src/digest/toc.js";
import type { SessionMessage } from "../../src/types.js";

const u = (text: string, ts?: string): SessionMessage => ({
  role: "user", text, timestamp: ts,
});
const a = (text: string, blocks?: SessionMessage["contentBlocks"], ts?: string): SessionMessage => ({
  role: "assistant", text, timestamp: ts,
  ...(blocks ? { contentBlocks: blocks } : {}),
});
const tu = (name: string, input: unknown) => ({ type: "tool_use" as const, name, input });

describe("buildTocEntries — importance-based filtering", () => {
  it("includes user messages whose text is >= USER_TEXT_MIN (50 chars)", () => {
    const longUser = "我们已经把sprint 2给做完了, 但是和你之后的聊天记录全丢失了, 需要从头开始 — 先看看历史进度";
    const shortUser = "hi";
    const e = buildTocEntries([u(longUser), u(shortUser)], [10, 20]);
    expect(e).toHaveLength(1);
    expect(e[0]!.markers).toBe("🧑");
    expect(e[0]!.line).toBe(10);
  });

  it("includes assistant turns with Edit / Write tool_use (✏️)", () => {
    const e = buildTocEntries(
      [a("", [tu("Edit", { file_path: "/foo.ts" })]), a("ok", [])],
      [5, 7],
    );
    expect(e).toHaveLength(1);
    expect(e[0]!.markers).toBe("✏️");
    expect(e[0]!.preview).toContain("/foo.ts");
  });

  it("includes assistant turns with git commit / tag in Bash (💾)", () => {
    const e = buildTocEntries(
      [
        a("", [tu("Bash", { command: 'git commit -m "fix bug"' })]),
        a("", [tu("Bash", { command: "ls" })]),                       // no marker
        a("", [tu("Bash", { command: "git tag v0.7.0" })]),
      ],
      [10, 20, 30],
    );
    expect(e.map((x) => x.markers)).toEqual(["💾", "💾"]);
  });

  it("stacks markers when a turn has both edit AND commit", () => {
    const e = buildTocEntries(
      [a("", [
        tu("Edit", { file_path: "/x" }),
        tu("Bash", { command: 'git commit -m "z"' }),
      ])],
      [1],
    );
    expect(e[0]!.markers).toBe("💾✏️");
  });

  it("marks substantive assistant text replies (🤖) but only when no edit/commit", () => {
    const longTxt = "x".repeat(250);
    const e = buildTocEntries(
      [
        a(longTxt),                                                       // 🤖
        a(longTxt, [tu("Edit", { file_path: "/y" })]),                    // edit beats text → ✏️ only
        a("short"),                                                       // dropped
      ],
      [1, 2, 3],
    );
    expect(e.map((x) => x.markers)).toEqual(["🤖", "✏️"]);
  });

  it("preview falls back to action summary when message text is empty", () => {
    const e = buildTocEntries(
      [a("", [
        tu("Edit", { file_path: "src/foo.ts" }),
        tu("Edit", { file_path: "src/bar.ts" }),
      ])],
      [10],
    );
    expect(e[0]!.preview).toBe("Edit src/foo.ts · Edit src/bar.ts");
  });

  it("preserves turn number as 1-based index", () => {
    const e = buildTocEntries(
      [
        a("", [tu("Edit", { file_path: "/a" })]),  // turn 1
        u("short"),                                // skipped
        a("", [tu("Edit", { file_path: "/b" })]),  // turn 3
      ],
      [10, 20, 30],
    );
    expect(e.map((x) => x.turn)).toEqual([1, 3]);
  });
});

describe("renderTocMarkdown", () => {
  it("emits empty string when no entries", () => {
    expect(renderTocMarkdown([])).toBe("");
  });

  it("emits a markdown table with header + rows", () => {
    const md = renderTocMarkdown([
      { turn: 1, timestamp: "2026-04-18T04:10:59.000Z", markers: "🧑", preview: "we shipped sprint 2", line: 240 },
      { turn: 14, timestamp: "2026-04-18T05:02:00.000Z", markers: "💾", preview: 'git commit -m "fix"', line: 1420 },
    ]);
    expect(md).toContain("# Table of Contents");
    expect(md).toContain("| # | Time | Marker | Preview | Line |");
    expect(md).toContain("| 1 | 04-18 04:10 | 🧑 | we shipped sprint 2 | →L240 |");
    expect(md).toContain("| 14 | 04-18 05:02 | 💾 | git commit -m \"fix\" | →L1420 |");
  });

  it("escapes pipe characters inside preview", () => {
    const md = renderTocMarkdown([
      { turn: 1, timestamp: "2026-04-18T04:10:59.000Z", markers: "🧑", preview: "echo a | wc -l", line: 100 },
    ]);
    expect(md).toContain("echo a \\| wc -l");
  });
});
