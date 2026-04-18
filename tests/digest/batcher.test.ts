import { describe, it, expect } from "vitest";
import { makeBatches } from "../../src/digest/batcher.js";
import type { SessionForBatching } from "../../src/digest/types.js";

function s(
  sessionId: string,
  project: string,
  endedAt: string,
  tokenEstimate: number,
): SessionForBatching {
  return { sessionId, project, endedAt, tokenEstimate };
}

describe("makeBatches", () => {
  it("returns empty array for empty input", () => {
    expect(makeBatches([], { maxTokens: 100 })).toEqual([]);
  });

  it("packs sessions of the same project into one batch when under budget", () => {
    const sessions = [
      s("a", "proj", "2026-04-01T00:00:00Z", 10),
      s("b", "proj", "2026-04-02T00:00:00Z", 20),
      s("c", "proj", "2026-04-03T00:00:00Z", 30),
    ];
    const batches = makeBatches(sessions, { maxTokens: 100 });
    expect(batches.length).toBe(1);
    expect(batches[0].map((x) => x.sessionId)).toEqual(["a", "b", "c"]);
  });

  it("opens a new batch when adding the next session would exceed maxTokens", () => {
    const sessions = [
      s("a", "proj", "2026-04-01T00:00:00Z", 60),
      s("b", "proj", "2026-04-02T00:00:00Z", 60),
    ];
    const batches = makeBatches(sessions, { maxTokens: 100 });
    expect(batches.length).toBe(2);
    expect(batches[0].map((x) => x.sessionId)).toEqual(["a"]);
    expect(batches[1].map((x) => x.sessionId)).toEqual(["b"]);
  });

  it("places an oversized session in its own single-element batch", () => {
    const sessions = [
      s("a", "proj", "2026-04-01T00:00:00Z", 10),
      s("big", "proj", "2026-04-02T00:00:00Z", 500),
      s("c", "proj", "2026-04-03T00:00:00Z", 10),
    ];
    const batches = makeBatches(sessions, { maxTokens: 100 });
    // a fits with c; big stands alone. Order of batches preserves time order
    // of the FIRST session in each batch.
    expect(batches.length).toBe(2);
    expect(batches[0].map((x) => x.sessionId)).toEqual(["a", "c"]);
    expect(batches[1].map((x) => x.sessionId)).toEqual(["big"]);
  });

  it("groups by project first, then orders within project by endedAt", () => {
    const sessions = [
      s("p2-a", "proj2", "2026-04-01T00:00:00Z", 10),
      s("p1-b", "proj1", "2026-04-02T00:00:00Z", 10),
      s("p1-a", "proj1", "2026-04-01T00:00:00Z", 10),
      s("p2-b", "proj2", "2026-04-02T00:00:00Z", 10),
    ];
    const batches = makeBatches(sessions, { maxTokens: 100 });
    // All four fit in one batch but ordering must be: proj1 sessions first
    // (by endedAt), then proj2 sessions (by endedAt). Project order is the
    // order of first appearance in the input.
    expect(batches.length).toBe(1);
    expect(batches[0].map((x) => x.sessionId)).toEqual([
      "p1-a", "p1-b", "p2-a", "p2-b",
    ]);
  });

  it("does not mix two projects in a batch when project boundary is crossed mid-pack", () => {
    // Two projects, each fits on its own; budget allows mixing but we should
    // prefer same-project locality over packing density.
    const sessions = [
      s("p1-a", "proj1", "2026-04-01T00:00:00Z", 40),
      s("p1-b", "proj1", "2026-04-02T00:00:00Z", 40),
      s("p2-a", "proj2", "2026-04-03T00:00:00Z", 40),
    ];
    const batches = makeBatches(sessions, { maxTokens: 100 });
    expect(batches.length).toBe(2);
    expect(batches[0].map((x) => x.sessionId)).toEqual(["p1-a", "p1-b"]);
    expect(batches[1].map((x) => x.sessionId)).toEqual(["p2-a"]);
  });

  it("uses a default maxTokens of 100_000 when opts.maxTokens omitted", () => {
    const sessions = [
      s("a", "proj", "2026-04-01T00:00:00Z", 50_000),
      s("b", "proj", "2026-04-02T00:00:00Z", 50_000),
    ];
    const batches = makeBatches(sessions);
    // 50_000 + 50_000 = 100_000, fits exactly under the default.
    expect(batches.length).toBe(1);
  });
});
