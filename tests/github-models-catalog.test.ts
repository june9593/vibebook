import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchGithubModelsCatalog, GITHUB_MODELS_FALLBACK } from "../src/github-models-catalog.js";

const SAMPLE: unknown = [
  {
    id: "openai/gpt-4o-mini",
    name: "OpenAI GPT-4o mini",
    publisher: "OpenAI",
    rate_limit_tier: "low",
    supported_input_modalities: ["text", "image"],
    supported_output_modalities: ["text"],
    tags: ["multipurpose"],
  },
  {
    id: "openai/text-embedding-3-small",
    name: "Text Embedding 3 Small",
    publisher: "OpenAI",
    rate_limit_tier: "embeddings",
  },
  {
    id: "meta/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B Instruct",
    publisher: "Meta",
    rate_limit_tier: "high",
    supported_output_modalities: ["text"],
  },
  {
    // Should be filtered: text-output missing
    id: "weird/audio-only",
    name: "Audio Only",
    publisher: "Weird",
    supported_output_modalities: ["audio"],
  },
];

describe("fetchGithubModelsCatalog", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("normalizes catalog entries and filters embeddings + non-text outputs", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE), { status: 200 })) as typeof fetch;
    const models = await fetchGithubModelsCatalog();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("openai/gpt-4o-mini");
    expect(ids).toContain("meta/llama-3.3-70b-instruct");
    expect(ids).not.toContain("openai/text-embedding-3-small");
    expect(ids).not.toContain("weird/audio-only");
    const gpt = models.find((m) => m.id === "openai/gpt-4o-mini")!;
    expect(gpt.publisher).toBe("OpenAI");
    expect(gpt.rateLimitTier).toBe("low");
  });

  it("returns fallback list when fetch returns non-OK", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    const models = await fetchGithubModelsCatalog();
    expect(models).toEqual(GITHUB_MODELS_FALLBACK);
  });

  it("returns fallback when fetch throws (network down)", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    const models = await fetchGithubModelsCatalog();
    expect(models).toEqual(GITHUB_MODELS_FALLBACK);
  });

  it("returns fallback when payload is the wrong shape", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ not: "an array" }), { status: 200 })) as typeof fetch;
    const models = await fetchGithubModelsCatalog();
    expect(models).toEqual(GITHUB_MODELS_FALLBACK);
  });

  it("returns fallback when filtering yields zero models", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([{ id: "x/y", name: "X", publisher: "X", rate_limit_tier: "embeddings" }]), { status: 200 })) as typeof fetch;
    const models = await fetchGithubModelsCatalog();
    expect(models).toEqual(GITHUB_MODELS_FALLBACK);
  });
});
