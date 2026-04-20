import { describe, it, expect } from "vitest";
import { extractSessionSignals } from "../../src/digest/session-signal.js";

describe("extractSessionSignals", () => {
  it("extracts title from the first ## User block", () => {
    const md = `# Display\n\n## User\n\nfix the bug in login\n\n## Assistant\n\nok`;
    const r = extractSessionSignals(md);
    expect(r.title).toBe("fix the bug in login");
  });

  it("caps title at 80 chars", () => {
    const long = "x".repeat(200);
    const md = `## User\n\n${long}\n`;
    const r = extractSessionSignals(md);
    expect(r.title.length).toBeLessThanOrEqual(80);
  });

  it("preview concatenates all ## User blocks, capped at 300 chars", () => {
    const md = `## User\n\nfirst question\n\n## Assistant\n\nresp\n\n## User\n\nsecond question\n`;
    const r = extractSessionSignals(md);
    expect(r.preview).toContain("first question");
    expect(r.preview).toContain("second question");
    expect(r.preview.length).toBeLessThanOrEqual(305);
  });

  it("insightScore is high when multiple SIGNAL_CATEGORIES hit", () => {
    const md = `## User\n\nfix the bug, root cause was a design pattern decision; learned a lot. why? because architecture was wrong.`;
    const r = extractSessionSignals(md);
    expect(r.insightScore).toBeGreaterThan(0.3);
  });

  it("insightScore floors at 0.1 when fewer than 2 categories hit", () => {
    const md = `## User\n\nhi how are you\n\n## Assistant\n\nfine`;
    const r = extractSessionSignals(md);
    expect(r.insightScore).toBe(0.1);
  });

  it("works on Chinese content", () => {
    const md = `## User\n\n修复了一个问题，发现是架构设计的关键陷阱，原因是因为没考虑边界`;
    const r = extractSessionSignals(md);
    expect(r.insightScore).toBeGreaterThan(0.2);
  });

  it("handles empty body without crashing", () => {
    const r = extractSessionSignals("");
    expect(r.title).toBe("");
    expect(r.preview).toBe("");
    expect(r.insightScore).toBe(0);
  });

  it("handles body with only assistant messages (no user) — title empty", () => {
    const md = `## Assistant\n\nhello world`;
    const r = extractSessionSignals(md);
    expect(r.title).toBe("");
  });
});
