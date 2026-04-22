import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runGithubModels } from "../../../src/digest/runners/github-models.js";

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

  it("returns ok:false with HTTP status when API errors", async () => {
    mockFetch(() => new Response("rate limited", { status: 429 }));
    const r = await runGithubModels("p", "m", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("HTTP 429");
      expect(r.error).toContain("rate limited");
    }
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
