/**
 * GitHub Models catalog helper.
 *
 * The catalog (https://models.github.ai/catalog/models) is public — no auth
 * required to LIST models. We fetch it during `vibebook init` so the wizard
 * can offer the user a real list to pick from instead of asking them to
 * type a model id by hand.
 *
 * If the catalog fetch fails (offline, GitHub down, schema change), we fall
 * back to a small hand-curated list of well-known popular ids.
 */

export interface GithubModel {
  /** Full id used in API requests, e.g. "openai/gpt-4o-mini". */
  id: string;
  /** Human-readable name, e.g. "OpenAI GPT-4o mini". */
  name: string;
  /** Vendor, e.g. "OpenAI", "Meta". */
  publisher: string;
  /** Catalog's rate-limit class. "low" / "high" / "custom" / "embeddings". */
  rateLimitTier?: string;
  /** Modalities the model accepts. */
  inputModalities?: string[];
  /** Modalities the model emits. */
  outputModalities?: string[];
  /** Tags (multipurpose / multilingual / multimodal / reasoning…). */
  tags?: string[];
}

const CATALOG_URL = "https://models.github.ai/catalog/models";

/** Hard-coded fallback when the catalog fetch fails. Intentionally small. */
export const GITHUB_MODELS_FALLBACK: GithubModel[] = [
  { id: "openai/gpt-4o-mini", name: "OpenAI GPT-4o mini", publisher: "OpenAI", rateLimitTier: "low" },
  { id: "openai/gpt-4.1-mini", name: "OpenAI GPT-4.1-mini", publisher: "OpenAI", rateLimitTier: "low" },
  { id: "openai/gpt-4o", name: "OpenAI GPT-4o", publisher: "OpenAI", rateLimitTier: "high" },
  { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct", publisher: "Meta", rateLimitTier: "high" },
  { id: "mistral-ai/mistral-medium-2505", name: "Mistral Medium 2505", publisher: "Mistral AI", rateLimitTier: "low" },
  { id: "microsoft/phi-4", name: "Microsoft Phi-4", publisher: "Microsoft", rateLimitTier: "low" },
];

interface RawCatalogEntry {
  id?: string;
  name?: string;
  publisher?: string;
  rate_limit_tier?: string;
  supported_input_modalities?: string[];
  supported_output_modalities?: string[];
  tags?: string[];
}

/**
 * Fetch and normalize the catalog. Filters out embeddings (no chat support)
 * and image/audio-only outputs. Honors a soft timeout so the wizard doesn't
 * stall on a slow network.
 */
export async function fetchGithubModelsCatalog(timeoutMs = 5000): Promise<GithubModel[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(CATALOG_URL, { signal: ac.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return GITHUB_MODELS_FALLBACK;
    const raw = (await res.json()) as RawCatalogEntry[];
    if (!Array.isArray(raw)) return GITHUB_MODELS_FALLBACK;
    const models = raw
      .filter((m): m is Required<Pick<RawCatalogEntry, "id" | "name" | "publisher">> & RawCatalogEntry =>
        typeof m.id === "string" && typeof m.name === "string" && typeof m.publisher === "string")
      .filter((m) => m.rate_limit_tier !== "embeddings")
      .filter((m) => !m.supported_output_modalities || m.supported_output_modalities.includes("text"))
      .map<GithubModel>((m) => ({
        id: m.id,
        name: m.name,
        publisher: m.publisher,
        rateLimitTier: m.rate_limit_tier,
        inputModalities: m.supported_input_modalities,
        outputModalities: m.supported_output_modalities,
        tags: m.tags,
      }));
    return models.length > 0 ? models : GITHUB_MODELS_FALLBACK;
  } catch {
    return GITHUB_MODELS_FALLBACK;
  } finally {
    clearTimeout(timer);
  }
}
