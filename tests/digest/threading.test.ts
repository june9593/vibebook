import { describe, it, expect, vi } from "vitest";
import { runThreading, mergeCandidates, normalizeSlug } from "../../src/digest/threading.js";
import type { ThreadCandidate, SessionForBatching } from "../../src/digest/types.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";

function fakeRunner(replies: RunResult[]): LlmRunner {
  let i = 0;
  return {
    run: async () => {
      const r = replies[i++];
      if (!r) throw new Error("fakeRunner ran out of replies");
      return r;
    },
  };
}

function s(sessionId: string, project = "p", endedAt = "2026-04-01T00:00:00Z"): SessionForBatching {
  return { sessionId, project, endedAt, tokenEstimate: 10 };
}

describe("normalizeSlug", () => {
  it("lowercases", () => {
    expect(normalizeSlug("Fix-Bug")).toBe("fix-bug");
  });
  it("collapses double hyphens", () => {
    expect(normalizeSlug("fix--bug---now")).toBe("fix-bug-now");
  });
  it("strips trailing -NNN numeric suffix", () => {
    expect(normalizeSlug("fix-bug-12")).toBe("fix-bug");
  });
  it("trims leading and trailing hyphens", () => {
    expect(normalizeSlug("-fix-bug-")).toBe("fix-bug");
  });
  it("leaves a slug without trailing digits alone", () => {
    expect(normalizeSlug("fix-bug")).toBe("fix-bug");
  });
});

describe("mergeCandidates", () => {
  it("returns empty array for empty input", () => {
    expect(mergeCandidates([])).toEqual([]);
  });

  it("merges identical threadIds across batches, unioning sessionIds in first-appearance order", () => {
    const batchA: ThreadCandidate[] = [
      { threadId: "fix-bug", title: "修 bug", sessionIds: ["s1", "s2"] },
    ];
    const batchB: ThreadCandidate[] = [
      { threadId: "fix-bug", title: "修 bug", sessionIds: ["s2", "s3"] },
    ];
    const merged = mergeCandidates([batchA, batchB]);
    expect(merged.length).toBe(1);
    expect(merged[0].threadId).toBe("fix-bug");
    expect(merged[0].sessionIds).toEqual(["s1", "s2", "s3"]);
  });

  it("collapses prefix-equivalent slugs onto the longer one", () => {
    const batchA: ThreadCandidate[] = [
      { threadId: "fix-bug", title: "修 bug", sessionIds: ["s1"] },
    ];
    const batchB: ThreadCandidate[] = [
      { threadId: "fix-bug-in-parser", title: "修 parser", sessionIds: ["s2"] },
    ];
    const merged = mergeCandidates([batchA, batchB]);
    expect(merged.length).toBe(1);
    expect(merged[0].threadId).toBe("fix-bug-in-parser");
    expect(merged[0].sessionIds).toEqual(["s1", "s2"]);
  });

  it("collapses normalize-equivalent slugs (trailing numbers, double hyphens)", () => {
    const batchA: ThreadCandidate[] = [
      { threadId: "fix-bug-1", title: "a", sessionIds: ["s1"] },
    ];
    const batchB: ThreadCandidate[] = [
      { threadId: "fix-bug-2", title: "b", sessionIds: ["s2"] },
    ];
    const merged = mergeCandidates([batchA, batchB]);
    expect(merged.length).toBe(1);
    // Both normalize to "fix-bug"; same length → earliest first-appearance wins.
    expect(merged[0].threadId).toBe("fix-bug-1");
    expect(merged[0].sessionIds).toEqual(["s1", "s2"]);
  });

  it("passes skip through when any candidate of a merged group is skip", () => {
    const batchA: ThreadCandidate[] = [
      { threadId: "say-hi", title: "打招呼", sessionIds: ["s1"], skip: true, reason: "no content" },
    ];
    const batchB: ThreadCandidate[] = [
      { threadId: "say-hi", title: "打招呼", sessionIds: ["s2"] },
    ];
    const merged = mergeCandidates([batchA, batchB]);
    expect(merged.length).toBe(1);
    expect(merged[0].skip).toBe(true);
    expect(merged[0].reason).toBe("no content");
    expect(merged[0].sessionIds).toEqual(["s1", "s2"]);
  });

  it("keeps unrelated threads as separate entries", () => {
    const batchA: ThreadCandidate[] = [
      { threadId: "fix-bug", title: "a", sessionIds: ["s1"] },
      { threadId: "add-feature", title: "b", sessionIds: ["s2"] },
    ];
    const merged = mergeCandidates([batchA]);
    expect(merged.length).toBe(2);
    expect(merged.map((c) => c.threadId).sort()).toEqual(["add-feature", "fix-bug"]);
  });

  it("does NOT collapse slugs whose normalized forms share only a non-segment prefix", () => {
    // "fix" is a raw-string prefix of "fixture", but not a hyphen-segment
    // prefix. They are unrelated threads and must stay distinct.
    const batchA: ThreadCandidate[] = [
      { threadId: "fix", title: "fix", sessionIds: ["s1"] },
    ];
    const batchB: ThreadCandidate[] = [
      { threadId: "fixture", title: "fixture", sessionIds: ["s2"] },
    ];
    const merged = mergeCandidates([batchA, batchB]);
    expect(merged.length).toBe(2);
    expect(merged.map((c) => c.threadId).sort()).toEqual(["fix", "fixture"]);
  });
});

describe("runThreading", () => {
  it("calls the runner once per batch and returns the merged ThreadCandidate[]", async () => {
    const runner = fakeRunner([
      {
        ok: true,
        text: JSON.stringify([
          { threadId: "t1", title: "T1", sessionIds: ["s1", "s2"] },
        ]),
        durationMs: 1,
      },
      {
        ok: true,
        text: JSON.stringify([
          { threadId: "t1", title: "T1", sessionIds: ["s3"] },
          { threadId: "t2", title: "T2", sessionIds: ["s4"] },
        ]),
        durationMs: 1,
      },
    ]);
    const runSpy = vi.spyOn(runner, "run");

    const batches = [
      [s("s1"), s("s2")],
      [s("s3"), s("s4")],
    ];
    const merged = await runThreading(runner, batches);

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(merged.length).toBe(2);
    const t1 = merged.find((c) => c.threadId === "t1")!;
    expect(t1.sessionIds).toEqual(["s1", "s2", "s3"]);
  });

  it("throws when any batch's runner call returns ok:false, with all errors", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([]), durationMs: 1 },
      { ok: false, error: "timeout", durationMs: 1 },
    ]);
    const batches = [[s("s1")], [s("s2")]];
    await expect(runThreading(runner, batches)).rejects.toThrow(/batch 1.*timeout/i);
  });

  it("throws when a batch returns malformed JSON", async () => {
    const runner = fakeRunner([
      { ok: true, text: "not json at all", durationMs: 1 },
    ]);
    const batches = [[s("s1")]];
    await expect(runThreading(runner, batches)).rejects.toThrow(/batch 0.*parse/i);
  });

  it("throws when a batch returns valid JSON but not a ThreadCandidate[] shape", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify({ not: "an array" }), durationMs: 1 },
    ]);
    const batches = [[s("s1")]];
    await expect(runThreading(runner, batches)).rejects.toThrow(/batch 0.*shape/i);
  });

  it("calls runner with outputFormat:'json'", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([]), durationMs: 1 },
    ]);
    const runSpy = vi.spyOn(runner, "run");
    await runThreading(runner, [[s("s1")]]);
    const opts = runSpy.mock.calls[0][2];
    expect(opts?.outputFormat).toBe("json");
  });

  it("substitutes {{sessionList}} with a JSON array of session metadata", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([]), durationMs: 1 },
    ]);
    const runSpy = vi.spyOn(runner, "run");
    await runThreading(runner, [[s("s1", "p", "2026-04-01T00:00:00Z")]]);
    const vars = runSpy.mock.calls[0][1];
    expect(vars.sessionList).toBeDefined();
    const parsed = JSON.parse(vars.sessionList);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      sessionId: "s1",
      project: "p",
      endedAt: "2026-04-01T00:00:00Z",
    });
  });
});
