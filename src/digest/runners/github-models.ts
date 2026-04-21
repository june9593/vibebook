import type { RunOptions, RunResult } from "../runner.js";

const ENDPOINT = "https://models.github.ai/inference/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * GitHub Models REST runner. Auth via `GITHUB_TOKEN` env (Action default) or
 * `MEMVC_GITHUB_TOKEN` for local testing. Token must have `models:read` scope.
 *
 * Model id format is `<vendor>/<model>` per the GitHub Models catalog
 * (e.g. `openai/gpt-4o-mini`, `meta/Llama-3.3-70B-Instruct`).
 *
 * The OpenAI-compatible chat-completions schema is used; we send a single
 * "user" message with the rendered prompt and return `choices[0].message.content`.
 */
export async function runGithubModels(
  prompt: string,
  model: string,
  opts: RunOptions,
): Promise<RunResult> {
  const started = Date.now();
  const token = process.env.GITHUB_TOKEN ?? process.env.MEMVC_GITHUB_TOKEN ?? "";
  if (!token) {
    return {
      ok: false,
      error: "github-models: no GITHUB_TOKEN (or MEMVC_GITHUB_TOKEN) in env",
      durationMs: Date.now() - started,
    };
  }
  const useModel = model.trim() || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
        messages: [{ role: "user", content: prompt }],
      }),
    });
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
