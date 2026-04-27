import { describe, it, expect } from "vitest";
import {
  inferProjectFromContent,
  pathToProjectSlug,
  extractPathsFromMessages,
  MIN_CONFIDENCE,
  MIN_PATH_HITS,
} from "../src/content-project-inference.js";
import type { SessionMessage } from "../src/types.js";

const KNOWN_ROOTS = [
  { path: "/Users/u/edge/vibebook", slug: "edge-vibebook" },
  { path: "/Users/u/chromium/src", slug: "chromium-src" },
].sort((a, b) => b.path.length - a.path.length);

function toolUseMsg(blocks: { name: string; input: Record<string, unknown> }[]): SessionMessage {
  return {
    role: "assistant",
    text: "",
    raw: {
      message: {
        content: blocks.map((b) => ({ type: "tool_use", name: b.name, input: b.input })),
      },
    },
  };
}

describe("pathToProjectSlug", () => {
  it("matches a known project root by prefix", () => {
    expect(pathToProjectSlug("/Users/u/edge/vibebook/src/foo.ts", KNOWN_ROOTS)).toBe("edge-vibebook");
  });

  it("falls back to parent-basename slug when no root matches", () => {
    expect(pathToProjectSlug("/Users/u/random/proj/foo.ts", KNOWN_ROOTS)).toBe("random-proj");
  });

  it("rejects /tmp, /etc, system paths", () => {
    expect(pathToProjectSlug("/tmp/scratch/x.txt", KNOWN_ROOTS)).toBeNull();
    expect(pathToProjectSlug("/etc/hosts", KNOWN_ROOTS)).toBeNull();
    expect(pathToProjectSlug("/usr/local/bin/foo", KNOWN_ROOTS)).toBeNull();
  });

  it("rejects non-absolute paths", () => {
    expect(pathToProjectSlug("relative/foo.ts", KNOWN_ROOTS)).toBeNull();
    expect(pathToProjectSlug("", KNOWN_ROOTS)).toBeNull();
  });
});

describe("extractPathsFromMessages", () => {
  it("extracts file_path from Read/Write/Edit tool uses", () => {
    const msgs: SessionMessage[] = [
      toolUseMsg([
        { name: "Read", input: { file_path: "/Users/u/edge/vibebook/a.ts" } },
        { name: "Edit", input: { file_path: "/Users/u/edge/vibebook/b.ts" } },
      ]),
    ];
    const paths = extractPathsFromMessages(msgs);
    expect(paths).toContain("/Users/u/edge/vibebook/a.ts");
    expect(paths).toContain("/Users/u/edge/vibebook/b.ts");
  });

  it("extracts absolute paths from Bash commands", () => {
    const msgs: SessionMessage[] = [
      toolUseMsg([
        { name: "Bash", input: { command: "cat /Users/u/edge/vibebook/c.ts && ls /tmp/x" } },
      ]),
    ];
    const paths = extractPathsFromMessages(msgs);
    expect(paths).toContain("/Users/u/edge/vibebook/c.ts");
  });

  it("dedupes within a single message but counts across messages", () => {
    const msgs: SessionMessage[] = [
      toolUseMsg([
        { name: "Read", input: { file_path: "/p/a.ts" } },
        { name: "Read", input: { file_path: "/p/a.ts" } },
      ]),
      toolUseMsg([
        { name: "Read", input: { file_path: "/p/a.ts" } },
      ]),
    ];
    expect(extractPathsFromMessages(msgs).filter((p) => p === "/p/a.ts").length).toBe(2);
  });

  it("ignores non-tool-use blocks and non-array content", () => {
    const msgs: SessionMessage[] = [
      { role: "assistant", text: "", raw: { message: { content: "plain string" } } },
      { role: "assistant", text: "", raw: { message: { content: [{ type: "text", text: "/Users/x/foo.ts" }] } } },
    ];
    expect(extractPathsFromMessages(msgs)).toEqual([]);
  });
});

describe("inferProjectFromContent", () => {
  it("returns inferred project when one project dominates ≥ MIN_CONFIDENCE", () => {
    // 8 vibebook + 2 chromium = 80% vibebook
    const blocks = [
      ...Array.from({ length: 8 }, (_, i) => ({ name: "Read", input: { file_path: `/Users/u/edge/vibebook/v${i}.ts` } })),
      ...Array.from({ length: 2 }, (_, i) => ({ name: "Read", input: { file_path: `/Users/u/chromium/src/c${i}.cc` } })),
    ];
    const msgs = blocks.map((b) => toolUseMsg([b]));
    const r = inferProjectFromContent(msgs, KNOWN_ROOTS);
    expect(r.inferredProject).toBe("edge-vibebook");
    expect(r.confidence).toBeCloseTo(0.8, 5);
    expect(r.totalHits).toBe(10);
  });

  it("returns null when no project meets confidence threshold", () => {
    // 5 vibebook + 5 chromium = 50/50
    const blocks = [
      ...Array.from({ length: 5 }, (_, i) => ({ name: "Read", input: { file_path: `/Users/u/edge/vibebook/v${i}.ts` } })),
      ...Array.from({ length: 5 }, (_, i) => ({ name: "Read", input: { file_path: `/Users/u/chromium/src/c${i}.cc` } })),
    ];
    const msgs = blocks.map((b) => toolUseMsg([b]));
    const r = inferProjectFromContent(msgs, KNOWN_ROOTS);
    expect(r.inferredProject).toBeNull();
    expect(r.confidence).toBeCloseTo(0.5, 5);
  });

  it("returns null when total hits < MIN_PATH_HITS", () => {
    // 2 hits all from vibebook — under threshold
    const blocks = [
      { name: "Read", input: { file_path: "/Users/u/edge/vibebook/a.ts" } },
      { name: "Read", input: { file_path: "/Users/u/edge/vibebook/b.ts" } },
    ];
    const msgs = blocks.map((b) => toolUseMsg([b]));
    const r = inferProjectFromContent(msgs, KNOWN_ROOTS);
    expect(r.inferredProject).toBeNull();
    expect(r.totalHits).toBe(2);
    expect(r.totalHits).toBeLessThan(MIN_PATH_HITS);
  });

  it("respects MIN_CONFIDENCE exactly at boundary", () => {
    // 7 vibebook + 3 chromium = 70% — should pass
    const blocks = [
      ...Array.from({ length: 7 }, (_, i) => ({ name: "Read", input: { file_path: `/Users/u/edge/vibebook/v${i}.ts` } })),
      ...Array.from({ length: 3 }, (_, i) => ({ name: "Read", input: { file_path: `/Users/u/chromium/src/c${i}.cc` } })),
    ];
    const msgs = blocks.map((b) => toolUseMsg([b]));
    const r = inferProjectFromContent(msgs, KNOWN_ROOTS);
    expect(r.confidence).toBeCloseTo(0.7, 5);
    expect(r.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(r.inferredProject).toBe("edge-vibebook");
  });

  it("ignores /tmp / /etc / system paths in tally", () => {
    const blocks = [
      // 6 vibebook hits + 100 /tmp hits → vibebook should dominate (tmp filtered)
      ...Array.from({ length: 6 }, (_, i) => ({ name: "Read", input: { file_path: `/Users/u/edge/vibebook/v${i}.ts` } })),
      ...Array.from({ length: 100 }, (_, i) => ({ name: "Read", input: { file_path: `/tmp/scratch/x${i}.txt` } })),
    ];
    const msgs = blocks.map((b) => toolUseMsg([b]));
    const r = inferProjectFromContent(msgs, KNOWN_ROOTS);
    expect(r.inferredProject).toBe("edge-vibebook");
    expect(r.totalHits).toBe(6);
  });
});
