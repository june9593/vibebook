import { describe, it, expect } from "vitest";
import {
  budgetForGithubModels,
  budgetForAnthropic,
  budgetForClaudeCli,
  tokensToChars,
} from "../../src/digest/model-limits.js";

describe("budgetForGithubModels", () => {
  it("free tier: gpt-4o-mini gets 8K cap regardless of catalog claim", () => {
    const b = budgetForGithubModels("openai/gpt-4o-mini");
    expect(b.inputBudgetTokens).toBeLessThan(8000);
    expect(b.inputBudgetTokens).toBeGreaterThan(5000); // 8K - 1.5K overhead
    expect(b.outputBudgetTokens).toBe(4000);
    expect(b.reason).toMatch(/free tier/);
  });

  it("free tier: gpt-4.1-mini also capped (catalog says 1M but free tier overrides)", () => {
    const b = budgetForGithubModels("openai/gpt-4.1-mini");
    expect(b.inputBudgetTokens).toBeLessThan(8000);
    expect(b.reason).toMatch(/free tier/);
  });

  it("paid custom-tier: gpt-5-mini gets full 200K", () => {
    const b = budgetForGithubModels("openai/gpt-5-mini");
    expect(b.inputBudgetTokens).toBeGreaterThan(90_000);
    expect(b.outputBudgetTokens).toBe(100_000);
    expect(b.reason).toMatch(/paid model/);
  });

  it("paid custom-tier: o3 gets full 200K", () => {
    const b = budgetForGithubModels("openai/o3");
    expect(b.inputBudgetTokens).toBeGreaterThan(90_000);
  });

  it("empty model id falls back to gpt-4o-mini default (free)", () => {
    const b = budgetForGithubModels("");
    expect(b.inputBudgetTokens).toBeLessThan(8000);
  });

  it("unknown model treated as free tier", () => {
    const b = budgetForGithubModels("madeup/model-9000");
    expect(b.inputBudgetTokens).toBeLessThan(8000);
  });
});

describe("budgetForAnthropic", () => {
  it("known model returns its 200K cap", () => {
    const b = budgetForAnthropic("claude-sonnet-4-6");
    expect(b.inputBudgetTokens).toBeGreaterThan(100_000);
    expect(b.outputBudgetTokens).toBe(64_000);
  });

  it("opus 1M variant returns 1M cap", () => {
    const b = budgetForAnthropic("claude-opus-4-7[1m]");
    expect(b.inputBudgetTokens).toBeGreaterThan(900_000);
  });

  it("matches by family-stem prefix when exact id unknown", () => {
    const b = budgetForAnthropic("claude-sonnet-4-6-20251201");
    expect(b.inputBudgetTokens).toBeGreaterThan(100_000);
  });

  it("unknown model uses 200K fallback", () => {
    const b = budgetForAnthropic("totally-made-up");
    expect(b.inputBudgetTokens).toBeGreaterThan(100_000);
  });
});

describe("budgetForClaudeCli delegates to anthropic table", () => {
  it("returns same shape as budgetForAnthropic", () => {
    const a = budgetForAnthropic("claude-sonnet-4-6");
    const c = budgetForClaudeCli("claude-sonnet-4-6");
    expect(c).toEqual(a);
  });
});

describe("tokensToChars", () => {
  it("uses 3 char/token rule of thumb", () => {
    expect(tokensToChars(1000)).toBe(3000);
    expect(tokensToChars(0)).toBe(0);
  });
});
