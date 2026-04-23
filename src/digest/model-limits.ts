/**
 * Per-model token-budget table.
 *
 * For each runner+model combo, return the practical input-token budget
 * (after subtracting room for the prompt skeleton + output). Callers use
 * this to decide *up front* how much of the user content to send, instead
 * of estimating blindly and getting HTTP 413'd.
 *
 * Sources:
 *   - claude-cli: built-in /context tells you 200K for Sonnet/Opus, 200K
 *     for Claude 4.x family. No runtime API; model id chosen by user.
 *   - github-models: catalog says max_input_tokens=131K for gpt-4o-mini,
 *     but the FREE TIER intercepts every request and caps at 8000 input /
 *     4000 output regardless. We hardcode the 8K cap as the floor.
 *     `custom` rate_limit_tier models (gpt-5/o1/o3) are paid and use
 *     their full catalog limits.
 *   - anthropic-api (Sprint 5): Sonnet/Opus 200K standard, Opus extended
 *     1M. Will use /v1/messages/count_tokens for precise counting later.
 *
 * Numbers are in TOKENS, not chars. Convert to chars at the call site
 * with `tokensToChars()` (uses a ~3.5 char/token rule of thumb that's
 * conservative for mixed English+Chinese+code).
 */

export interface ModelBudget {
  /** Max tokens of user content we should put in the prompt body. */
  inputBudgetTokens: number;
  /** Max tokens we expect in the response. */
  outputBudgetTokens: number;
  /** Why this number was chosen — surfaced in logs when truncation kicks in. */
  reason: string;
}

/** Conservative tokens→chars conversion. 3 chars/token is safe for mixed
 *  Chinese + English + code (English+code can be ~4, Chinese ~1.5–2). */
export function tokensToChars(tokens: number): number {
  return tokens * 3;
}

/** Subtract a fixed safety margin so we have room for the prompt skeleton +
 *  some output buffer before the model's hard cap. */
const PROMPT_OVERHEAD_TOKENS = 1500;

/** GitHub Models free tier hard-cap, per
 *  https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models#rate-limits
 *  Applies to ALL Copilot Free models (low, high, AND custom tier). The only
 *  way out is Copilot Pro+, where the gpt-5 / o-series quotas are slightly
 *  different (and even then per-request token caps are still small). */
const GITHUB_FREE_TIER_INPUT = 8000;
const GITHUB_FREE_TIER_OUTPUT = 4000;

/** Models that REQUIRE a paid Copilot tier (Pro / Business / Enterprise) —
 *  Copilot Free returns "Not applicable" per the docs. We treat these as
 *  having higher per-request budgets when the user explicitly opts in. The
 *  default budget assumes Copilot Free.
 *
 *  IMPORTANT: catalog `rate_limit_tier === "custom"` is NOT a clean proxy.
 *  DeepSeek-R1 and Grok-3 are also custom-tier but ARE available on Copilot
 *  Free (with their own tight quotas). Maintain an explicit prefix list. */
const COPILOT_PAID_ONLY_PREFIXES = [
  "openai/gpt-5",
  "openai/o1",
  "openai/o3",
  "openai/o4-mini",
];

function isCopilotPaidOnly(modelId: string): boolean {
  return COPILOT_PAID_ONLY_PREFIXES.some((p) => modelId === p || modelId.startsWith(p));
}

/** Catalog-advertised limits for paid-only models (used only when caller
 *  explicitly opts into the paid tier — see budgetForGithubModels). */
const GITHUB_PAID_LIMITS: Record<string, { in: number; out: number }> = {
  "openai/gpt-5": { in: 200_000, out: 100_000 },
  "openai/gpt-5-chat": { in: 200_000, out: 100_000 },
  "openai/gpt-5-mini": { in: 200_000, out: 100_000 },
  "openai/gpt-5-nano": { in: 200_000, out: 100_000 },
  "openai/o1": { in: 200_000, out: 100_000 },
  "openai/o1-mini": { in: 128_000, out: 65_536 },
  "openai/o1-preview": { in: 128_000, out: 32_768 },
  "openai/o3": { in: 200_000, out: 100_000 },
  "openai/o3-mini": { in: 200_000, out: 100_000 },
  "openai/o4-mini": { in: 200_000, out: 100_000 },
};

/** Anthropic models (used by both anthropic-api runner and claude-cli). */
const ANTHROPIC_LIMITS: Record<string, { in: number; out: number }> = {
  // 200K context family (default)
  "claude-3-5-sonnet": { in: 200_000, out: 8192 },
  "claude-3-5-haiku": { in: 200_000, out: 8192 },
  "claude-3-opus": { in: 200_000, out: 4096 },
  "claude-sonnet-4-5": { in: 200_000, out: 64_000 },
  "claude-sonnet-4-6": { in: 200_000, out: 64_000 },
  "claude-opus-4-7": { in: 200_000, out: 32_000 },
  // 1M-context Opus tier (when caller explicitly opts in)
  "claude-opus-4-7[1m]": { in: 1_000_000, out: 32_000 },
};

/** Heuristic Anthropic limits when the model id isn't in our table. */
function anthropicFallback(): { in: number; out: number } {
  return { in: 200_000, out: 8192 };
}

export function budgetForGithubModels(model: string): ModelBudget {
  const useModel = model.trim() || "openai/gpt-4o-mini";
  if (isCopilotPaidOnly(useModel)) {
    const lim = GITHUB_PAID_LIMITS[useModel] ?? { in: 200_000, out: 4096 };
    return {
      inputBudgetTokens: Math.max(1000, lim.in - PROMPT_OVERHEAD_TOKENS - lim.out),
      outputBudgetTokens: lim.out,
      reason: `github-models Copilot-paid model '${useModel}': catalog limit ${lim.in}/${lim.out} tokens`,
    };
  }
  // Copilot Free tier — hard 8K input cap on every model (low/high/custom),
  // including DeepSeek-R1, Grok-3, gpt-4o, gpt-4.1-mini, etc.
  return {
    inputBudgetTokens: GITHUB_FREE_TIER_INPUT - PROMPT_OVERHEAD_TOKENS,
    outputBudgetTokens: GITHUB_FREE_TIER_OUTPUT,
    reason: `github-models Copilot Free tier: 8K input / 4K output (model '${useModel}' catalog limits don't apply on free tier)`,
  };
}

export function budgetForAnthropic(model: string): ModelBudget {
  const useModel = model.trim();
  // Try exact match first; if model id starts with a known family stem, match that.
  let lim = ANTHROPIC_LIMITS[useModel];
  if (!lim) {
    for (const stem of Object.keys(ANTHROPIC_LIMITS)) {
      if (useModel.startsWith(stem)) { lim = ANTHROPIC_LIMITS[stem]; break; }
    }
  }
  lim ??= anthropicFallback();
  return {
    inputBudgetTokens: lim.in - PROMPT_OVERHEAD_TOKENS - lim.out,
    outputBudgetTokens: lim.out,
    reason: `anthropic model '${useModel || "<default>"}': ${lim.in} in / ${lim.out} out`,
  };
}

/** Claude CLI. Without a runtime API to query /context, we use the same
 *  Anthropic table — model is whatever the user set in runnerModel (or
 *  whatever `claude` defaults to, which we treat as 200K). */
export function budgetForClaudeCli(model: string): ModelBudget {
  return budgetForAnthropic(model);
}
