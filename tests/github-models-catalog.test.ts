import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchGithubModelsCatalog, GITHUB_MODELS_FALLBACK, isCopilotPaidOnly } from "../src/github-models-catalog.js";

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
    // Copilot-paid only — should be filtered by default.
    id: "openai/gpt-5-mini",
    name: "OpenAI GPT-5-mini",
    publisher: "OpenAI",
    rate_limit_tier: "custom",
    supported_output_modalities: ["text"],
  },
  {
    id: "openai/o3",
    name: "OpenAI o3",
    publisher: "OpenAI",
    rate_limit_tier: "custom",
    supported_output_modalities: ["text"],
  },
  {
    // custom-tier but Copilot-Free-available — should NOT be filtered.
    id: "deepseek/deepseek-r1",
    name: "DeepSeek R1",
    publisher: "DeepSeek",
    rate_limit_tier: "custom",
    supported_output_modalities: ["text"],
  },
  {
    id: "xai/grok-3",
    name: "xAI Grok 3",
    publisher: "xAI",
    rate_limit_tier: "custom",
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

describe("isCopilotPaidOnly", () => {
  it("recognizes gpt-5 family", () => {
    expect(isCopilotPaidOnly("openai/gpt-5")).toBe(true);
    expect(isCopilotPaidOnly("openai/gpt-5-mini")).toBe(true);
    expect(isCopilotPaidOnly("openai/gpt-5-nano")).toBe(true);
    expect(isCopilotPaidOnly("openai/gpt-5-chat")).toBe(true);
  });
  it("recognizes o-series", () => {
    expect(isCopilotPaidOnly("openai/o1")).toBe(true);
    expect(isCopilotPaidOnly("openai/o1-mini")).toBe(true);
    expect(isCopilotPaidOnly("openai/o1-preview")).toBe(true);
    expect(isCopilotPaidOnly("openai/o3")).toBe(true);
    expect(isCopilotPaidOnly("openai/o3-mini")).toBe(true);
    expect(isCopilotPaidOnly("openai/o4-mini")).toBe(true);
  });
  it("returns false for Copilot Free models", () => {
    expect(isCopilotPaidOnly("openai/gpt-4o-mini")).toBe(false);
    expect(isCopilotPaidOnly("openai/gpt-4o")).toBe(false);
    expect(isCopilotPaidOnly("meta/llama-3.3-70b-instruct")).toBe(false);
    expect(isCopilotPaidOnly("deepseek/deepseek-r1")).toBe(false);
    expect(isCopilotPaidOnly("xai/grok-3")).toBe(false);
    expect(isCopilotPaidOnly("microsoft/phi-4")).toBe(false);
  });
});

describe("fetchGithubModelsCatalog", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("by default hides Copilot-paid models (gpt-5/o3) but keeps custom-tier free ones (deepseek/grok)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE), { status: 200 })) as typeof fetch;
    const models = await fetchGithubModelsCatalog();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("openai/gpt-4o-mini");
    expect(ids).toContain("meta/llama-3.3-70b-instruct");
    expect(ids).toContain("deepseek/deepseek-r1");
    expect(ids).toContain("xai/grok-3");
    expect(ids).not.toContain("openai/gpt-5-mini");
    expect(ids).not.toContain("openai/o3");
    expect(ids).not.toContain("openai/text-embedding-3-small");
    expect(ids).not.toContain("weird/audio-only");
  });

  it("includes paid models when includePaidOnly: true", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE), { status: 200 })) as typeof fetch;
    const models = await fetchGithubModelsCatalog({ includePaidOnly: true });
    const ids = models.map((m) => m.id);
    expect(ids).toContain("openai/gpt-5-mini");
    expect(ids).toContain("openai/o3");
  });

  it("backwards-compat: passing a number arg = timeoutMs (no breaking change)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE), { status: 200 })) as typeof fetch;
    const models = await fetchGithubModelsCatalog(5000);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("openai/gpt-4o-mini");
    expect(ids).not.toContain("openai/gpt-5-mini"); // paid filter still on by default
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
