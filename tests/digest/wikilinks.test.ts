import { describe, it, expect } from "vitest";
import { resolveWikiLinks } from "../../src/digest/wikilinks.js";
import type { BookIndexV2 } from "../../src/digest/book-index-v2.js";

function bookIndex(): BookIndexV2 {
  return {
    version: 2,
    chronicles: {
      "fix-fullscreen": {
        threadId: "fix-fullscreen",
        project: "edge-src",
        title: "修 fullscreen bug",
        sessionIds: ["s1"],
        path: "book/edge-src/chronicle/2026-04-22__fix-fullscreen__fix-full.md",
        createdAt: "2026-04-22", updatedAt: "2026-04-22", tags: [],
      },
      "skipped-thread": {
        threadId: "skipped-thread",
        project: "edge-src",
        title: "x", sessionIds: [], path: "",
        createdAt: "2026-04-22", updatedAt: "2026-04-22", tags: [], skip: true,
      },
    },
    topics: {},
    cards: {
      "edge-src/gotcha-x": {
        cardSlug: "gotcha-x", project: "edge-src", type: "gotcha",
        path: "book/edge-src/cards/gotcha-x.md",
        createdAt: "2026-04-22", updatedAt: "2026-04-22", tags: [],
      },
      "_global/tool-rg": {
        cardSlug: "tool-rg", project: "_global", type: "tool",
        path: "book/_global/cards/tool-rg.md",
        createdAt: "2026-04-22", updatedAt: "2026-04-22", tags: [],
      },
      "chromium-src/gotcha-x": {
        cardSlug: "gotcha-x", project: "chromium-src", type: "gotcha",
        path: "book/chromium-src/cards/gotcha-x.md",
        createdAt: "2026-04-22", updatedAt: "2026-04-22", tags: [],
      },
    },
  };
}

describe("resolveWikiLinks", () => {
  it("resolves [[chronicle/<threadId>]] to a relative markdown link with title", () => {
    const r = resolveWikiLinks(
      "see [[chronicle/fix-fullscreen]] for details",
      { fromPath: "book/edge-src/topics/foo.md", fromProject: "edge-src", bookIndex: bookIndex() },
    );
    expect(r.body).toBe("see [修 fullscreen bug](../chronicle/2026-04-22__fix-fullscreen__fix-full.md) for details");
    expect(r.unresolved).toEqual([]);
  });

  it("supports alias form [[chronicle/<threadId>|alt text]]", () => {
    const r = resolveWikiLinks(
      "[[chronicle/fix-fullscreen|the fullscreen fix]]",
      { fromPath: "book/edge-src/topics/foo.md", fromProject: "edge-src", bookIndex: bookIndex() },
    );
    expect(r.body).toBe("[the fullscreen fix](../chronicle/2026-04-22__fix-fullscreen__fix-full.md)");
  });

  it("resolves bare card slug, preferring same project", () => {
    const r = resolveWikiLinks(
      "see [[gotcha-x]]",
      { fromPath: "book/edge-src/topics/foo.md", fromProject: "edge-src", bookIndex: bookIndex() },
    );
    // Same project (edge-src) wins over chromium-src
    expect(r.body).toBe("see [gotcha-x](../cards/gotcha-x.md)");
  });

  it("falls back to _global when same project has no card with that slug", () => {
    const r = resolveWikiLinks(
      "see [[tool-rg]]",
      { fromPath: "book/edge-src/topics/foo.md", fromProject: "edge-src", bookIndex: bookIndex() },
    );
    expect(r.body).toBe("see [tool-rg](../../_global/cards/tool-rg.md)");
  });

  it("leaves unresolved links alone and reports them", () => {
    const r = resolveWikiLinks(
      "missing [[chronicle/no-such-thread]] and [[no-such-card]]",
      { fromPath: "book/edge-src/topics/foo.md", fromProject: "edge-src", bookIndex: bookIndex() },
    );
    expect(r.body).toBe("missing [[chronicle/no-such-thread]] and [[no-such-card]]");
    expect(r.unresolved.sort()).toEqual(["chronicle/no-such-thread", "no-such-card"]);
  });

  it("does not resolve to skipped chronicles (they have no path)", () => {
    const r = resolveWikiLinks(
      "[[chronicle/skipped-thread]]",
      { fromPath: "book/edge-src/topics/foo.md", fromProject: "edge-src", bookIndex: bookIndex() },
    );
    expect(r.body).toBe("[[chronicle/skipped-thread]]");
    expect(r.unresolved).toEqual(["chronicle/skipped-thread"]);
  });

  it("computes correct relative path from chronicle to topic-cards across project tree", () => {
    // From a card in _global/cards/, link to a chronicle in edge-src/chronicle/
    const r = resolveWikiLinks(
      "[[chronicle/fix-fullscreen]]",
      { fromPath: "book/_global/cards/tool-rg.md", fromProject: "_global", bookIndex: bookIndex() },
    );
    expect(r.body).toContain("(../../edge-src/chronicle/2026-04-22__fix-fullscreen__fix-full.md)");
  });

  it("handles multiple wikilinks in one body", () => {
    const r = resolveWikiLinks(
      "see [[chronicle/fix-fullscreen]] and [[gotcha-x]] and [[tool-rg]]",
      { fromPath: "book/edge-src/topics/foo.md", fromProject: "edge-src", bookIndex: bookIndex() },
    );
    expect(r.body).toContain("[修 fullscreen bug](");
    expect(r.body).toContain("[gotcha-x](");
    expect(r.body).toContain("[tool-rg](");
    expect(r.unresolved).toEqual([]);
  });

  it("accepts the explicit cards/<slug> prefix as well as bare slug", () => {
    const r = resolveWikiLinks(
      "see [[cards/gotcha-x]]",
      { fromPath: "book/edge-src/topics/foo.md", fromProject: "edge-src", bookIndex: bookIndex() },
    );
    expect(r.body).toBe("see [gotcha-x](../cards/gotcha-x.md)");
  });
});
