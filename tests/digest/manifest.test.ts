import { describe, it, expect } from "vitest";
import { extractManifest } from "../../src/digest/manifest.js";
import type { SessionMessage } from "../../src/types.js";

const u = (text: string, blocks?: SessionMessage["contentBlocks"]): SessionMessage => ({
  role: "user", text, ...(blocks ? { contentBlocks: blocks } : {}),
});
const a = (text: string, blocks?: SessionMessage["contentBlocks"]): SessionMessage => ({
  role: "assistant", text, ...(blocks ? { contentBlocks: blocks } : {}),
});
const tu = (name: string, input: unknown) => ({ type: "tool_use" as const, name, input });

describe("extractManifest", () => {
  it("counts user / assistant turns", () => {
    const m = extractManifest([u("hi"), a("hello"), u("again"), a("again-back")], [0, 1, 2, 3]);
    expect(m.user_turns).toBe(2);
    expect(m.assistant_turns).toBe(2);
  });

  it("histograms tool_use names across messages", () => {
    const m = extractManifest(
      [
        a("", [tu("Bash", { command: "ls" }), tu("Bash", { command: "pwd" })]),
        a("", [tu("Read", { file_path: "/a" })]),
      ],
      [0, 1],
    );
    expect(m.tools_used).toEqual({ Bash: 2, Read: 1 });
  });

  it("dedups files_touched preserving first-seen order, caps at 200", () => {
    const m = extractManifest(
      [
        a("", [
          tu("Read", { file_path: "/a.ts" }),
          tu("Edit", { file_path: "/b.ts" }),
          tu("Read", { file_path: "/a.ts" }),    // dup
          tu("Write", { file_path: "/c.ts" }),
        ]),
      ],
      [0],
    );
    expect(m.files_touched).toEqual(["/a.ts", "/b.ts", "/c.ts"]);
  });

  it("extracts commits from git commit -m \"…\" with line numbers", () => {
    const m = extractManifest(
      [
        a("", [tu("Bash", { command: 'git add -A && git commit -m "fix: bug 1"' })]),
        a("", [tu("Bash", { command: "echo hi" })]),
        a("", [tu("Bash", { command: "git commit -m 'feat: thing'" })]),
      ],
      [10, 20, 30],
    );
    expect(m.commits).toEqual([
      { sha: "", msg: "fix: bug 1", line: 10 },
      { sha: "", msg: "feat: thing", line: 30 },
    ]);
  });

  it("extracts heredoc commit message (first line)", () => {
    const m = extractManifest(
      [a("", [tu("Bash", {
        command: `git commit -m "$(cat <<'EOF'
fix(extractor): drop isMeta entries

Detail follows...
EOF
)"`,
      })])],
      [42],
    );
    expect(m.commits).toEqual([
      { sha: "", msg: "fix(extractor): drop isMeta entries", line: 42 },
    ]);
  });

  it("extracts git tag with version + message", () => {
    const m = extractManifest(
      [a("", [tu("Bash", { command: 'git tag -a v0.6.3 -m "0.6.3 release notes"' })])],
      [100],
    );
    expect(m.commits).toEqual([
      { sha: "v0.6.3", msg: "0.6.3 release notes", line: 100 },
    ]);
  });

  it("matches candidate_decisions on user text keywords with line + preview", () => {
    const m = extractManifest(
      [
        u("我决定就把plugin拆出来单独repo，方便发布"),
        u("just exploring"),                                  // no match
        u("ok merged, ship as 0.5.2"),
        a("we should…", []),                                  // assistant text never matches
      ],
      [50, 60, 70, 80],
    );
    expect(m.candidate_decisions).toEqual([
      { line: 50, preview: "我决定就把plugin拆出来单独repo，方便发布" },
      { line: 70, preview: "ok merged, ship as 0.5.2" },
    ]);
  });

  it("caps candidate_decisions at 20", () => {
    const msgs: SessionMessage[] = Array.from({ length: 30 }, () => u("我决定 yes"));
    const m = extractManifest(msgs, msgs.map((_, i) => i));
    expect(m.candidate_decisions).toHaveLength(20);
  });

  it("survives missing/empty input gracefully", () => {
    const m = extractManifest([], []);
    expect(m).toEqual({
      user_turns: 0, assistant_turns: 0,
      tools_used: {}, commits: [], files_touched: [], candidate_decisions: [],
    });
  });
});
