import type { RunOptions, RunResult } from "../runner.js";

const ENDPOINT = "https://models.github.ai/inference/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 180_000;

/** How many times to retry a 429 inside a single run() call before giving up. */
const RATE_LIMIT_MAX_RETRIES = 5;
/** Fallback Retry-After when the server doesn't send the header. */
const DEFAULT_RETRY_AFTER_MS = 60_000;
/** Cap on how long any single retry will sleep. */
const MAX_RETRY_BACKOFF_MS = 5 * 60_000;

/**
 * GitHub Models free tier caps every low/high-tier model at 8000 input tokens
 * and 4000 output tokens *per request*, regardless of what the catalog
 * metadata says about the underlying model's theoretical context. (See
 * https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models#rate-limits)
 *
 * We truncate the prompt to ~21000 characters before sending. That's
 * conservatively ~7000 tokens (3 char/token rule-of-thumb for mixed
 * English/Chinese), leaving ~1000 tokens of headroom for system overhead.
 *
 * When we truncate, we splice in a marker so the model knows part of the
 * input was dropped and can produce a partial-but-honest article instead
 * of a confidently-wrong full one.
 */
const MAX_INPUT_CHARS = 21_000;
const TRUNCATION_MARKER = "\n\n[... 此处省略 ${dropped} 字符以满足 GitHub Models 8K 输入上限 ...]\n\n";

export function truncatePromptForGithubModels(prompt: string, maxChars = MAX_INPUT_CHARS): string {
  if (prompt.length <= maxChars) return prompt;
  // Keep the head (where the prompt + first sessions live) and a tail snippet
  // (so the LLM sees how the conversation ended). 80/20 split.
  const headChars = Math.floor(maxChars * 0.8);
  const tailChars = maxChars - headChars - 200; // leave room for the marker
  const dropped = prompt.length - headChars - tailChars;
  return (
    prompt.slice(0, headChars) +
    TRUNCATION_MARKER.replace("${dropped}", dropped.toLocaleString()) +
    prompt.slice(prompt.length - tailChars)
  );
}

/**
 * Parse a Retry-After header per RFC 7231 §7.1.3:
 *   - delta-seconds: positive integer → seconds
 *   - HTTP-date: parse to epoch ms; clamp to ≥ 0
 *
 * Returns ms (not s) so callers can pass it directly to setTimeout. Returns
 * null when the header is absent or malformed.
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, t - Date.now());
}

/**
 * GitHub Models REST runner. Auth via `GITHUB_TOKEN` env (Action default) or
 * `VIBEBOOK_GITHUB_TOKEN` for local testing. Token must have `models:read` scope.
 *
 * Model id format is `<vendor>/<model>` per the GitHub Models catalog
 * (e.g. `openai/gpt-4o-mini`, `meta/Llama-3.3-70B-Instruct`).
 *
 * The OpenAI-compatible chat-completions schema is used; we send a single
 * "user" message with the rendered prompt and return `choices[0].message.content`.
 *
 * Rate limiting: GitHub Models enforces strict per-minute quotas. On HTTP 429
 * we read the Retry-After header (or fall back to 60s exponential backoff)
 * and retry up to RATE_LIMIT_MAX_RETRIES times — transparent to the caller.
 * Set the runner's threadingConcurrency to 1 in CI to keep the burst small.
 *
 * `_sleep` is dependency-injected for tests.
 */
export async function runGithubModels(
  prompt: string,
  model: string,
  opts: RunOptions,
  _sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<RunResult> {
  const started = Date.now();
  const token = process.env.GITHUB_TOKEN ?? process.env.VIBEBOOK_GITHUB_TOKEN ?? "";
  if (!token) {
    return {
      ok: false,
      error: "github-models: no GITHUB_TOKEN (or VIBEBOOK_GITHUB_TOKEN) in env",
      durationMs: Date.now() - started,
    };
  }
  const useModel = model.trim() || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Truncate before send. GH Models hard-caps free-tier input at 8K tokens.
  const safePrompt = truncatePromptForGithubModels(prompt);

  let lastErrorBody = "";
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          model: useModel,
          messages: [{ role: "user", content: safePrompt }],
        }),
      });
      if (res.status === 429) {
        // Rate limited. Sleep, then retry. Stop trying after the cap.
        if (attempt === RATE_LIMIT_MAX_RETRIES) {
          lastErrorBody = await res.text().catch(() => "");
          return {
            ok: false,
            error: `github-models: HTTP 429 after ${RATE_LIMIT_MAX_RETRIES + 1} attempts: ${lastErrorBody.slice(0, 500)}`,
            durationMs: Date.now() - started,
          };
        }
        const headerWait = parseRetryAfterMs(res.headers.get("retry-after"));
        // Exponential backoff fallback (1s, 2s, 4s, 8s, 16s) — but Retry-After
        // wins when present (server knows best, often 60s for GH Models).
        const expoBackoffMs = Math.min(1000 * Math.pow(2, attempt), MAX_RETRY_BACKOFF_MS);
        const wait = Math.min(headerWait ?? Math.max(DEFAULT_RETRY_AFTER_MS, expoBackoffMs), MAX_RETRY_BACKOFF_MS);
        // Drain the body so the connection can be reused.
        await res.text().catch(() => "");
        await _sleep(wait);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          ok: false,
          error: `github-models: HTTP ${res.status}: ${body.slice(0, 500)}`,
          durationMs: Date.now() - started,
        };
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = json.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) {
        return {
          ok: false,
          error: "github-models: empty response (no choices[0].message.content)",
          durationMs: Date.now() - started,
        };
      }
      return { ok: true, text, durationMs: Date.now() - started };
    } catch (e) {
      const err = e as Error;
      const isTimeout = err.name === "AbortError";
      return {
        ok: false,
        error: isTimeout
          ? `github-models: timeout after ${timeoutMs}ms`
          : `github-models: ${err.message}`,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable — loop returns or continues. Defensive fall-through.
  return {
    ok: false,
    error: `github-models: exhausted retries (last body: ${lastErrorBody.slice(0, 200)})`,
    durationMs: Date.now() - started,
  };
}
