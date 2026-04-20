import { describe, it, expect, vi } from "vitest";
import { runThreading, mergeCandidates, normalizeSlug } from "../../src/digest/threading.js";
import type { ThreadCandidate, EnrichedSessionForBatching } from "../../src/digest/types.js";
import type { LlmRunner, RunResult } from "../../src/digest/runner.js";
import { silentReporter } from "../../src/digest/reporter.js";

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

function s(sessionId: string, opts: Partial<EnrichedSessionForBatching> = {}): EnrichedSessionForBatching {
  return {
    sessionId,
    project: "p",
    endedAt: "2026-04-01T00:00:00Z",
    tokenEstimate: 10,
    title: "",
    preview: "",
    insightScore: 0,
    ...opts,
  };
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
  it("calls the runner once per batch and returns the merged result", async () => {
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
    const result = await runThreading(runner, batches, 4, 3, silentReporter());

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(result.failedBatches).toEqual([]);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.threadId).sort()).toEqual(["t1", "t2"]);
    expect(result.candidates.find((c) => c.threadId === "t1")!.sessionIds.sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("with maxAttempts=1: ok:false batch soft-fails (recorded in failedBatches, warns, no throw)", async () => {
    const runner = fakeRunner([
      { ok: true, text: "[]", durationMs: 1 },
      { ok: false, error: "timeout", durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(runner, [[s("s1")], [s("s2")]], 4, 1, silentReporter());
      // s1's batch succeeded with empty output → s1 is auto-recovered.
      // s2's batch failed → s2 is NOT recovered (will retry next sync).
      expect(r.candidates.flatMap((c) => c.sessionIds)).toEqual(["s1"]);
      expect(r.failedBatches).toEqual([{ batchIndex: 1, error: "timeout" }]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/batch 1.*timeout/));
    } finally {
      warn.mockRestore();
    }
  });

  it("with maxAttempts=1: parse error soft-fails", async () => {
    const runner = fakeRunner([
      { ok: true, text: "not-json{", durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(runner, [[s("s0")]], 4, 1, silentReporter());
      expect(r.candidates).toEqual([]);
      expect(r.failedBatches).toHaveLength(1);
      expect(r.failedBatches[0]!.error).toMatch(/parse error/i);
    } finally {
      warn.mockRestore();
    }
  });

  it("with maxAttempts=1: shape error soft-fails", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([{ wrong: "shape" }]), durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(runner, [[s("s0")]], 4, 1, silentReporter());
      expect(r.candidates).toEqual([]);
      expect(r.failedBatches).toHaveLength(1);
      expect(r.failedBatches[0]!.error).toMatch(/missing threadId/);
    } finally {
      warn.mockRestore();
    }
  });

  it("retries a batch that fails first then succeeds, returning candidates from the successful attempt", async () => {
    const runner = fakeRunner([
      { ok: false, error: "transient", durationMs: 1 },
      { ok: true, text: JSON.stringify([
        { threadId: "t-ok", title: "ok", sessionIds: ["s1"] },
      ]), durationMs: 1 },
    ]);
    const r = await runThreading(runner, [[s("s1")]], 4, 3, silentReporter());
    expect(r.failedBatches).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.threadId).toBe("t-ok");
  });

  it("with maxAttempts=3: retries on parse error, succeeds on third attempt", async () => {
    const runner = fakeRunner([
      { ok: true, text: "garbage{", durationMs: 1 },
      { ok: true, text: "still-bad", durationMs: 1 },
      { ok: true, text: JSON.stringify([
        { threadId: "t-late", title: "late", sessionIds: ["s1"] },
      ]), durationMs: 1 },
    ]);
    const r = await runThreading(runner, [[s("s1")]], 4, 3, silentReporter());
    expect(r.failedBatches).toEqual([]);
    expect(r.candidates[0]!.threadId).toBe("t-late");
  });

  it("with maxAttempts=2: gives up after 2 failed attempts and records last error", async () => {
    const runner = fakeRunner([
      { ok: true, text: "garbage1", durationMs: 1 },
      { ok: true, text: "garbage2", durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(runner, [[s("s1")]], 4, 2, silentReporter());
      expect(r.candidates).toEqual([]);
      expect(r.failedBatches).toHaveLength(1);
      expect(r.failedBatches[0]!.error).toMatch(/parse error/);
    } finally {
      warn.mockRestore();
    }
  });

  it("partial failure: one batch fails, others succeed; merged candidates come only from successful batches", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([
        { threadId: "t-good", title: "G", sessionIds: ["s0"] },
      ]), durationMs: 1 },
      { ok: true, text: "garbage", durationMs: 1 },
      { ok: true, text: JSON.stringify([
        { threadId: "t-also-good", title: "A", sessionIds: ["s2"] },
      ]), durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(runner, [[s("s0")], [s("s1")], [s("s2")]], 4, 1, silentReporter());
      expect(r.failedBatches).toEqual([{ batchIndex: 1, error: expect.stringMatching(/parse error/) }]);
      expect(r.candidates.map((c) => c.threadId).sort()).toEqual(["t-also-good", "t-good"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("calls runner with outputFormat:'json'", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([]), durationMs: 1 },
    ]);
    const runSpy = vi.spyOn(runner, "run");
    await runThreading(runner, [[s("s1")]], 4, 3, silentReporter());
    const opts = runSpy.mock.calls[0][2];
    expect(opts?.outputFormat).toBe("json");
  });

  it("substitutes {{sessionList}} with a JSON array of session metadata", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([]), durationMs: 1 },
    ]);
    const runSpy = vi.spyOn(runner, "run");
    await runThreading(runner, [[s("s1")]], 4, 3, silentReporter());
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

  it("respects the concurrency cap (no more than `concurrency` runner calls in flight at once)", async () => {
    let active = 0;
    let peak = 0;
    const runner: LlmRunner = {
      run: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { ok: true, text: "[]", durationMs: 10 } satisfies RunResult;
      },
    };
    const batches = Array.from({ length: 8 }, (_, i) => [s(`s${i}`)]);
    await runThreading(runner, batches, 2, 3, silentReporter());
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("runThreading dropped-session recovery", () => {
  it("auto-recovers sessions the LLM omitted from its output", async () => {
    const runner = fakeRunner([
      {
        ok: true,
        text: JSON.stringify([
          { threadId: "t1", title: "T1", sessionIds: ["s1"], worthWriting: true },
        ]),
        durationMs: 1,
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(
        runner,
        [[s("s1", { title: "fix bug" }), s("s2", { title: "add feature" }), s("s3", { title: "" })]],
        4,
        1,
        silentReporter(),
      );
      const allSids = new Set(r.candidates.flatMap((c) => c.sessionIds));
      expect(allSids).toEqual(new Set(["s1", "s2", "s3"]));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("auto-recovering"));
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT recover sessions from failed batches (those are retried next sync per soft-fail contract)", async () => {
    const runner = fakeRunner([
      { ok: false, error: "boom", durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(
        runner,
        [[s("s1"), s("s2")]],
        4,
        1,
        silentReporter(),
      );
      expect(r.candidates).toEqual([]);
      expect(r.failedBatches).toHaveLength(1);
      const recoveryCalls = warn.mock.calls.filter((c) => String(c[0]).includes("auto-recovering"));
      expect(recoveryCalls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("synthesized threadId derives readable slug from session title", async () => {
    const runner = fakeRunner([
      { ok: true, text: JSON.stringify([]), durationMs: 1 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = await runThreading(
        runner,
        [[s("session-uuid-12345", { title: "Fix Login Bug" })]],
        4, 1,
        silentReporter(),
      );
      expect(r.candidates).toHaveLength(1);
      expect(r.candidates[0]!.threadId).toMatch(/fix-login-bug/);
      expect(r.candidates[0]!.threadId).toContain("session-");
    } finally {
      warn.mockRestore();
    }
  });
});
