import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "../../src/digest/runner.js";

describe("e2e: github-action runner under MEMVC_CI", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "memvc-e2e-"));
    vi.stubEnv("MEMVC_CI", "1");
    vi.stubEnv("GITHUB_TOKEN", "fake");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("createRunner('github-action') in CI calls models.github.ai and returns content", async () => {
    let captured = "";
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = String(url);
      const body = JSON.parse(init.body as string);
      // Echo back a deterministic response for whatever prompt was sent.
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `echo: ${body.messages[0].content}` } }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const r = createRunner({ runner: "github-action", runnerModel: "openai/gpt-4o-mini" });
      const out = await r.run("Test {{kind}}", { kind: "ping" });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.text).toBe("echo: Test ping");
      expect(captured).toContain("models.github.ai");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
