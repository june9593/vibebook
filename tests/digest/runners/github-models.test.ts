import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runGithubModels, parseRetryAfterMs } from "../../../src/digest/runners/github-models.js";

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds form", () => {
    expect(parseRetryAfterMs("60")).toBe(60_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });
  it("parses HTTP-date form (clamped to ≥ 0)", () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(20_000);
    expect(ms!).toBeLessThanOrEqual(30_000);

    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
  });
  it("returns null on missing or junk", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("nonsense")).toBeNull();
  });
});

describe("runGithubModels", () => {
  let originalFetch: typeof fetch;
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    vi.stubEnv("GITHUB_TOKEN", "fake-token-for-test");
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as typeof fetch;
  }

  it("returns ok:true with content from choices[0].message.content", async () => {
    mockFetch(() => new Response(
      JSON.stringify({ choices: [{ message: { content: "  hello world  " } }] }),
      { status: 200 },
    ));
    const r = await runGithubModels("prompt", "openai/gpt-4o-mini", {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("hello world");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sends Authorization: Bearer <token> + correct model in body", async () => {
    mockFetch(() => new Response(
      JSON.stringify({ choices: [{ message: { content: "x" } }] }),
      { status: 200 },
    ));
    await runGithubModels("the-prompt", "meta/Llama-3.3-70B-Instruct", {});
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fake-token-for-test");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("meta/Llama-3.3-70B-Instruct");
    expect(body.messages).toEqual([{ role: "user", content: "the-prompt" }]);
  });

  it("falls back to DEFAULT_MODEL when model is blank", async () => {
    mockFetch(() => new Response(
      JSON.stringify({ choices: [{ message: { content: "x" } }] }),
      { status: 200 },
    ));
    await runGithubModels("p", "", {});
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("openai/gpt-4o-mini");
  });

  it("returns ok:false with HTTP status when API errors (non-429)", async () => {
    mockFetch(() => new Response("server error", { status: 500 }));
    const r = await runGithubModels("p", "m", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("HTTP 500");
      expect(r.error).toContain("server error");
    }
  });

  it("retries on HTTP 429 honoring Retry-After (seconds)", async () => {
    let n = 0;
    mockFetch(() => {
      n++;
      if (n === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "2" },
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "after-retry" } }] }),
        { status: 200 },
      );
    });
    const sleeps: number[] = [];
    const r = await runGithubModels("p", "m", {}, async (ms) => { sleeps.push(ms); });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("after-retry");
    expect(sleeps).toEqual([2000]); // honored Retry-After: 2 seconds
    expect(n).toBe(2);
  });

  it("falls back to default backoff when Retry-After missing", async () => {
    let n = 0;
    mockFetch(() => {
      n++;
      if (n === 1) return new Response("rl", { status: 429 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    });
    const sleeps: number[] = [];
    const r = await runGithubModels("p", "m", {}, async (ms) => { sleeps.push(ms); });
    expect(r.ok).toBe(true);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);   // expo backoff lower bound
    expect(sleeps[0]).toBeLessThanOrEqual(5 * 60_000); // capped
  });

  it("gives up after RATE_LIMIT_MAX_RETRIES + 1 attempts on persistent 429", async () => {
    let n = 0;
    mockFetch(() => {
      n++;
      return new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } });
    });
    const r = await runGithubModels("p", "m", {}, async () => {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("HTTP 429");
    expect(n).toBe(6); // initial + 5 retries
  });

  it("returns ok:false when no token in env", async () => {
    vi.unstubAllEnvs();
    const r = await runGithubModels("p", "m", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no GITHUB_TOKEN");
  });

  it("returns ok:false with empty-response error when content missing", async () => {
    mockFetch(() => new Response(
      JSON.stringify({ choices: [] }),
      { status: 200 },
    ));
    const r = await runGithubModels("p", "m", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("empty response");
  });

  it("times out after opts.timeoutMs", async () => {
    mockFetch((_url, init) => new Promise((resolve, reject) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      const t = setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "late" } }] }))), 500);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    }));
    const r = await runGithubModels("p", "m", { timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("timeout");
  });

  it("falls back to VIBEBOOK_GITHUB_TOKEN when GITHUB_TOKEN missing", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("VIBEBOOK_GITHUB_TOKEN", "fallback-tok");
    mockFetch(() => new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200 },
    ));
    const r = await runGithubModels("p", "m", {});
    expect(r.ok).toBe(true);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer fallback-tok");
  });
});
