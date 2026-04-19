import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { consoleReporter, silentReporter } from "../../src/digest/reporter.js";

describe("consoleReporter", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { logSpy.mockRestore(); });

  it("threadingStart prints batch count", () => {
    consoleReporter().threadingStart(57);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("57"));
  });

  it("threadingBatchDone shows index, total, ok status, and duration", () => {
    consoleReporter().threadingBatchDone(0, 5, 1234, true);
    const arg = logSpy.mock.calls[0]![0] as string;
    expect(arg).toContain("1/5"); // 1-based index
    expect(arg).toContain("1234");
  });

  it("threadingBatchDone shows FAILED for ok=false", () => {
    consoleReporter().threadingBatchDone(2, 3, 100, false);
    const arg = logSpy.mock.calls[0]![0] as string;
    expect(arg).toContain("FAILED");
  });

  it("articleDone differentiates ok / skipped / failed", () => {
    const r = consoleReporter();
    r.articleDone("t1", "ok", 100);
    r.articleDone("t2", "skipped", 100);
    r.articleDone("t3", "failed", 100);
    const calls = logSpy.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toContain("ok");
    expect(calls[1]).toContain("skip");
    expect(calls[2]).toContain("FAILED");
  });

  it("chapterDone handles no-articles", () => {
    consoleReporter().chapterDone("p", "no-articles", 5);
    expect(logSpy.mock.calls[0]![0] as string).toContain("(none)");
  });

  it("tocDone shows file count", () => {
    consoleReporter().tocDone(42);
    expect(logSpy.mock.calls[0]![0] as string).toContain("42");
  });
});

describe("silentReporter", () => {
  it("never logs", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const r = silentReporter();
      r.threadingStart(1);
      r.threadingBatchDone(0, 1, 1, true);
      r.articleStart(1);
      r.articleDone("t", "ok", 1);
      r.chapterStart(1);
      r.chapterDone("p", "ok", 1);
      r.tocStart();
      r.tocDone(1);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
