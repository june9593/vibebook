# GitHub Action Digest Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the digest pipeline (phases 3-7) inside a GitHub Action so users without local LLM credentials (or who don't want to spend local cycles) can get books. The Action checks out their device branch, reads raw_sessions (decrypting if needed via `MEMVC_PASSPHRASE` repo secret), runs `memvc digest --redo` using GitHub Models as the LLM, and pushes the resulting book commit back to the same branch.

**Architecture:**
- **Real `runGithubModels` runner** — `src/digest/runners/github-models.ts` becomes a working LLM adapter against the GitHub Models REST API (`https://models.github.ai/inference/chat/completions`), authenticated via `GITHUB_TOKEN` with the `models:read` scope. Mirrors the contract of `runClaudeCli`: takes prompt + model + opts, returns `RunResult { ok, text, durationMs }`.
- **Workflow file** at `.github/workflows/memvc-digest.yml` provided as a generated template (not auto-installed). Triggers on `push` to `**.lan` / `*-pro` device-branch patterns AND `workflow_dispatch`. The Action installs Node 20, installs `memvc` from npm (or `npm pack` / `npm link` from the repo for self-hosted CI), then runs `memvc digest --redo` (recovery-style: writes any new articles, never destructive).
- **`memvc workflow init`** — new CLI subcommand (orthogonal to `memvc init`) that writes `.github/workflows/memvc-digest.yml` into the user's memvc repo (e.g. `~/memvc-repo`), commits it, and prints clear instructions on which repo secret to set (`MEMVC_PASSPHRASE` if the user's config has `encrypt: true`). User runs this once after `memvc init`.
- **CI mode for `digest`** — when `MEMVC_CI=1` is set, `digestCmd` skips the interactive prompts and skips the `memvc sync` extract phase entirely (which doesn't apply on GH runners — they have no `~/.claude/projects/`). The existing `memvc digest --redo` already covers this; we mostly need to make sure the runner picks `github-models` based on env when no config exists.
- **Auto-detect runner from env in CI**: when `MEMVC_CI=1` AND `cfg.runner === "github-action"` (the wizard placeholder), `createRunner` picks `github-models` instead and reads `GITHUB_TOKEN` from env. Local users keep their existing runner.

**Tech Stack:** Node 20+ TypeScript ESM (memvc); GitHub Actions YAML; GitHub Models REST API (`models.github.ai`); `node:fetch` (built-in, no deps).

**Spec reference:** Conversation 2026-04-21:
- "GitHub action 总结的 pipeline" → real digest in CI
- "Action reads raw from same repo branches" → no external storage
- "GitHub Models (free)" → `runGithubModels` against `models.github.ai`
- "Auto-detect both modes (encrypted/plaintext)" → Action passes `MEMVC_PASSPHRASE` env when encryption is on; pipeline already decrypts `.enc` files
- "Push + manual" → workflow has both `push:` and `workflow_dispatch:`

---

## Scope

5 tasks, 5 commits.

- **Task 1**: Implement `runGithubModels` against models.github.ai REST API + tests (mocked fetch)
- **Task 2**: Wire `runner: "github-action"` to use `runGithubModels` in CI (env-based dispatch)
- **Task 3**: New CLI subcommand `memvc workflow init` that writes the workflow file + tests
- **Task 4**: Workflow YAML template (`.github/workflows/memvc-digest.yml.template` shipped as asset; copied into user repo by Task 3)
- **Task 5**: README + e2e smoke test (run `memvc digest --redo` against a fixture repo with mocked GitHub Models)

---

## File Structure

**Created:**
- `src/commands/workflow.ts` — `workflowInitCmd` writes the YAML into user repo
- `assets/workflows/memvc-digest.yml` — template shipped with memvc package
- `tests/digest/runners/github-models.test.ts`
- `tests/commands/workflow.test.ts`

**Modified:**
- `src/digest/runners/github-models.ts` — replace stub with real impl
- `src/digest/runner.ts` — `createRunner` reads `MEMVC_CI` env to remap `"github-action"` → `"github-models"` with token from env
- `src/cli.ts` — add `memvc workflow init` subcommand
- `package.json` — add `assets/workflows/` to the `files` field (so the template ships in npm)
- `README.md` — section explaining "Run digest in GitHub Actions"

**Untouched:** sync.ts (digest --redo already idempotent), threading, article, chapter, encryption, raw extract.

---

## Task 1: Implement `runGithubModels` against models.github.ai

**Files:**
- Modify: `src/digest/runners/github-models.ts`
- Create: `tests/digest/runners/github-models.test.ts`

### Step 1.1 — Replace stub with real implementation

Replace the entire body of `src/digest/runners/github-models.ts` with:

```ts
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
```

### Step 1.2 — Tests with mocked fetch

`tests/digest/runners/github-models.test.ts`:

```ts
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
    mockFetch(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "late" } }] }))), 500);
    }));
    const r = await runGithubModels("p", "m", { timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("timeout");
  });

  it("falls back to MEMVC_GITHUB_TOKEN when GITHUB_TOKEN missing", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("MEMVC_GITHUB_TOKEN", "fallback-tok");
    mockFetch(() => new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200 },
    ));
    const r = await runGithubModels("p", "m", {});
    expect(r.ok).toBe(true);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer fallback-tok");
  });
});
```

### Step 1.3 — Run + commit

- [ ] `npm test -- github-models` — green, 8 tests pass.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "feat(runner): real github-models adapter against models.github.ai chat-completions API"`

---

## Task 2: CI dispatch — `runner: github-action` → `github-models` in CI

**Files:**
- Modify: `src/digest/runner.ts`
- Modify: `tests/digest/runner.test.ts` (or create if missing — search first)

### Step 2.1 — Update createRunner to remap in CI

In `src/digest/runner.ts`, replace the `case "github-action"` arm:

```ts
case "github-action":
  throw new Error("github-action runner is not implemented yet");
```

with:

```ts
case "github-action": {
  // The "github-action" config value means "I'll run the digest from a GitHub
  // Action, not locally". When MEMVC_CI=1 (set by the workflow), we transparently
  // dispatch to the GitHub Models adapter, which authenticates via GITHUB_TOKEN.
  //
  // Local invocation should not pick this branch — `memvc init` only writes
  // "github-action" if the user picked it in the wizard, and the wizard rejects
  // it (see runWizard's Q6 loop).
  if (process.env.MEMVC_CI === "1") {
    return {
      run: (prompt, vars, opts) =>
        runGithubModels(renderPrompt(prompt, vars), cfg.runnerModel, opts ?? {}),
    };
  }
  throw new Error(
    "runner 'github-action' only works when run inside the GitHub Action (MEMVC_CI=1). For local digest runs, set runner to 'claude-cli'.",
  );
}
```

### Step 2.2 — Tests

Create `tests/digest/runner.test.ts` (or append):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRunner } from "../../src/digest/runner.js";

describe("createRunner — github-action dispatch", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when not in CI (MEMVC_CI != '1')", () => {
    expect(() => createRunner({ runner: "github-action", runnerModel: "" }))
      .toThrow(/MEMVC_CI=1/);
  });

  it("returns a runner when MEMVC_CI='1'", () => {
    vi.stubEnv("MEMVC_CI", "1");
    const r = createRunner({ runner: "github-action", runnerModel: "openai/gpt-4o-mini" });
    expect(typeof r.run).toBe("function");
  });

  it("dispatches to github-models with rendered prompt", async () => {
    vi.stubEnv("MEMVC_CI", "1");
    vi.stubEnv("GITHUB_TOKEN", "tok");
    const captured: { url?: string; body?: string } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured.url = String(url);
      captured.body = init.body as string;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const r = createRunner({ runner: "github-action", runnerModel: "openai/gpt-4o-mini" });
      const out = await r.run("Hello {{name}}", { name: "world" });
      expect(out.ok).toBe(true);
      expect(JSON.parse(captured.body!).messages[0].content).toBe("Hello world");
      expect(captured.url).toContain("models.github.ai");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
```

### Step 2.3 — Run + commit

- [ ] `npm test -- runner` — green, 3 tests pass.
- [ ] `npm test` — full suite green.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "feat(runner): dispatch 'github-action' config to github-models adapter under MEMVC_CI=1"`

---

## Task 3: `memvc workflow init` subcommand

**Files:**
- Create: `src/commands/workflow.ts`
- Create: `tests/commands/workflow.test.ts`
- Modify: `src/cli.ts` (add subcommand)
- Modify: `package.json` (add `assets/workflows/**` to `files` field)

### Step 3.1 — Implement workflowInitCmd

`src/commands/workflow.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { readConfig } from "../config.js";

/**
 * Resolve the bundled workflow template path. Works in both dev (tsx)
 * and built (dist/) layouts because we walk up from this module's URL.
 */
function templatePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/commands/  → ../../assets/workflows/memvc-digest.yml
  // dist/commands/ → ../../assets/workflows/memvc-digest.yml
  return resolve(here, "..", "..", "assets", "workflows", "memvc-digest.yml");
}

export async function workflowInitCmd(opts: { force?: boolean } = {}): Promise<void> {
  const cfg = readConfig();
  const target = join(cfg.repoPath, ".github", "workflows", "memvc-digest.yml");
  if (existsSync(target) && !opts.force) {
    console.log(chalk.yellow(`workflow already exists: ${target}`));
    console.log(chalk.gray("  re-run with --force to overwrite"));
    return;
  }
  const tpl = readFileSync(templatePath(), "utf8");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, tpl);
  console.log(chalk.green(`workflow written: ${target}`));
  console.log(chalk.gray("\nNext steps:"));
  console.log(chalk.gray(`  1. cd ${cfg.repoPath}`));
  console.log(chalk.gray("  2. git add .github/workflows/memvc-digest.yml && git commit -m 'add memvc digest workflow' && git push"));
  if (cfg.encrypt) {
    console.log(chalk.cyan("  3. Set repo secret MEMVC_PASSPHRASE in GitHub Settings → Secrets and variables → Actions → 'New repository secret'"));
  } else {
    console.log(chalk.gray("  3. (encryption is off; no secret needed — but anyone with repo access can read raw_sessions)"));
  }
  console.log(chalk.gray("  4. Trigger: push a device branch, OR run from the Actions tab → 'memvc digest' → 'Run workflow'"));
}
```

### Step 3.2 — CLI wiring

In `src/cli.ts`, add after the existing `program.command("digest")` block:

```ts
program
  .command("workflow")
  .description("Manage the GitHub Action that runs digest in CI")
  .addCommand(
    new Command("init")
      .description("Write .github/workflows/memvc-digest.yml into the configured memvc repo")
      .option("--force", "overwrite if file already exists")
      .action(async (opts: { force?: boolean }) => {
        const { workflowInitCmd } = await import("./commands/workflow.js");
        await workflowInitCmd({ force: opts.force });
      }),
  );
```

(`Command` already imported from `commander` at the top of cli.ts; if not, add `import { Command } from "commander";` to the imports.)

### Step 3.3 — package.json: ship the assets

In `package.json`, ensure `files` includes `assets/`:

```json
"files": ["dist/", "assets/", "README.md"]
```

(If `files` isn't present, add it. If `assets/` is already covered by a wildcard, no change needed.)

### Step 3.4 — Tests

`tests/commands/workflow.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

describe("workflowInitCmd", () => {
  let tmpHome: string;
  let repoPath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "memvc-wf-"));
    vi.stubEnv("HOME", tmpHome);
    repoPath = join(tmpHome, "memvc-repo");
    mkdirSync(repoPath, { recursive: true });
    // Minimal config for readConfig().
    mkdirSync(join(tmpHome, ".memvc"), { recursive: true });
    writeFileSync(join(tmpHome, ".memvc", "config.json"), JSON.stringify({
      repoPath, repoUrl: "git@example.com:u/r.git",
      encrypt: true, salt: "x",
      deviceBranch: "test.lan",
      runner: "github-action", runnerModel: "openai/gpt-4o-mini",
      threadingConcurrency: 4, threadingMaxAttempts: 3,
      digestEnabled: true,
    }));
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("writes the workflow file under repoPath/.github/workflows/", async () => {
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd();
    const out = join(repoPath, ".github", "workflows", "memvc-digest.yml");
    expect(existsSync(out)).toBe(true);
    const body = readFileSync(out, "utf8");
    // Sanity: the template should at least mention these fixed strings.
    expect(body).toContain("memvc digest");
    expect(body).toContain("MEMVC_CI");
    expect(body).toContain("workflow_dispatch");
  });

  it("refuses to overwrite without --force", async () => {
    const out = join(repoPath, ".github", "workflows", "memvc-digest.yml");
    mkdirSync(join(repoPath, ".github", "workflows"), { recursive: true });
    writeFileSync(out, "existing content\n");
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd();
    expect(readFileSync(out, "utf8")).toBe("existing content\n");
  });

  it("overwrites with --force", async () => {
    const out = join(repoPath, ".github", "workflows", "memvc-digest.yml");
    mkdirSync(join(repoPath, ".github", "workflows"), { recursive: true });
    writeFileSync(out, "existing\n");
    const { workflowInitCmd } = await import("../../src/commands/workflow.js");
    await workflowInitCmd({ force: true });
    const body = readFileSync(out, "utf8");
    expect(body).not.toBe("existing\n");
    expect(body).toContain("memvc digest");
  });
});
```

### Step 3.5 — Run + commit

- [ ] **Cannot run yet** until Task 4 creates the template file. Skip running tests; commit code in Task 5 after the template exists. Order rationale: keep tasks atomic; this commit is just the wiring + tests-that-need-template-file.

Actually, **reorder**: do Task 4 first (template asset), then Task 3. Let's restate:

**Revised order**: Task 1 → Task 2 → **Task 4 (template) → Task 3 (workflow init cmd that reads template)** → Task 5.

Apply the order swap mentally; the rest of this doc keeps the original numbering for clarity.

- [ ] `npm test -- workflow` — green, 3 tests pass (after Task 4).
- [ ] `npm test` — full suite green.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "feat(cli): 'memvc workflow init' writes .github/workflows/memvc-digest.yml into the configured repo"`

---

## Task 4: Workflow YAML template

**Files:**
- Create: `assets/workflows/memvc-digest.yml`

### Step 4.1 — Write the template

`assets/workflows/memvc-digest.yml` (verbatim):

```yaml
# Auto-generated by `memvc workflow init`. Edit if you want to change schedule
# or model — the file is yours to own once committed.

name: memvc digest

on:
  push:
    branches:
      - "*.lan"      # macOS device branch (default from os.hostname())
      - "*-pro"      # common Mac hostname suffix
      - "*-mbp"
      - "*-MBP*"
      - "*-pc"
      - "*-laptop"
      # Add your hostname pattern here if it doesn't match.
      # Tip: see your `cfg.deviceBranch` value in ~/.memvc/config.json.
  workflow_dispatch:
    inputs:
      branch:
        description: "Device branch to digest (default: caller's branch)"
        required: false
        default: ""

# Allow this workflow to use GitHub Models (read-only inference).
permissions:
  contents: write       # to push the book commit back
  models: read          # to call GitHub Models

concurrency:
  group: memvc-digest-${{ github.ref }}
  cancel-in-progress: false

jobs:
  digest:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - name: Checkout device branch
        uses: actions/checkout@v4
        with:
          ref: ${{ inputs.branch || github.ref }}
          fetch-depth: 0      # need full history so digest can find prior book commits

      - name: Set up Node 20
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install memvc
        run: npm install -g memvc

      - name: Write minimal config
        env:
          MEMVC_PASSPHRASE: ${{ secrets.MEMVC_PASSPHRASE }}
        run: |
          mkdir -p ~/.memvc
          REPO_PATH="$PWD"
          ENCRYPT="$( [ -n "$MEMVC_PASSPHRASE" ] && echo true || echo false )"
          cat > ~/.memvc/config.json <<JSON
          {
            "repoPath": "$REPO_PATH",
            "repoUrl": "${{ github.server_url }}/${{ github.repository }}.git",
            "encrypt": $ENCRYPT,
            "salt": "$(grep -o '"salt":[^,]*' .memvc/index.json 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"/\1/' || echo placeholder)",
            "deviceBranch": "${{ inputs.branch || github.ref_name }}",
            "runner": "github-action",
            "runnerModel": "openai/gpt-4o-mini",
            "threadingConcurrency": 4,
            "threadingMaxAttempts": 3,
            "digestEnabled": true
          }
          JSON
          if [ -n "$MEMVC_PASSPHRASE" ]; then
            echo "$MEMVC_PASSPHRASE" > ~/.memvc/passphrase
            chmod 600 ~/.memvc/passphrase
          fi

      - name: Run digest
        env:
          MEMVC_CI: "1"
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: memvc digest --redo

      - name: Push book commit
        run: |
          git config user.name  "memvc-bot"
          git config user.email "memvc-bot@users.noreply.github.com"
          git push origin HEAD:${{ inputs.branch || github.ref_name }}
```

### Step 4.2 — Manual smoke (optional)

- [ ] Eyeball the YAML. Validate with `actionlint` if installed: `actionlint assets/workflows/memvc-digest.yml` (no errors expected).
- [ ] No automated test for YAML validity in this plan; Task 3's tests cover "the template gets copied" which is what `workflow init` cares about.

### Step 4.3 — Commit

- [ ] **Commit**: `git add assets/workflows/memvc-digest.yml && git commit -m "feat(action): GitHub Actions workflow template for memvc-digest (push + manual triggers; auto-detects encryption)"`

---

## Task 5: README + e2e smoke test

**Files:**
- Modify: `README.md`
- Create: `tests/e2e/digest-with-github-models.test.ts`

### Step 5.1 — README section

Append to `README.md` (after the wizard section):

````markdown
## Run digest in GitHub Actions

If you'd rather not burn local Claude credits / cycles, memvc can run the digest pipeline inside a GitHub Action using **GitHub Models** (free for personal accounts) as the LLM.

```bash
# One-time setup inside your memvc repo:
memvc workflow init
cd ~/memvc-repo  # or wherever your memvc repo lives
git add .github/workflows/memvc-digest.yml
git commit -m "add memvc digest workflow"
git push
```

If your config has `encrypt: true`, also set the **MEMVC_PASSPHRASE** repo secret (Settings → Secrets and variables → Actions → New repository secret).

The workflow runs on:
- Every `push` to a device branch (default patterns: `*.lan`, `*-pro`, `*-mbp`, `*-MBP*`, `*-pc`, `*-laptop`). Edit the workflow if your hostname doesn't match.
- Manual `workflow_dispatch` from the **Actions** tab.

It uses model `openai/gpt-4o-mini` by default — change `runnerModel` in the workflow if you want a different one (see [GitHub Models catalog](https://github.com/marketplace?type=models)).
````

### Step 5.2 — E2E smoke test

`tests/e2e/digest-with-github-models.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
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
```

### Step 5.3 — Run + commit

- [ ] `npm test` — full suite green; new e2e test passes.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "docs(action): README walks through workflow init + e2e smoke for github-action runner"`

---

## Self-Review Checklist

- **Spec coverage:**
  - "Action reads raw from same repo branches" → workflow uses `actions/checkout` on the same repo + branch ✅
  - "GitHub Models (free)" → `runGithubModels` against `models.github.ai` ✅ (Task 1)
  - "Auto-detect encrypted/plaintext" → workflow conditionally writes `~/.memvc/passphrase` based on `MEMVC_PASSPHRASE` secret presence; pipeline already handles `.enc` decryption via existing code ✅ (Task 4)
  - "Push + manual trigger" → workflow has both `push:` and `workflow_dispatch:` ✅ (Task 4)

- **Placeholder scan:** All steps contain runnable code. The workflow's "salt" extraction uses `grep | sed` — pragmatic but if `index.json` lacks a salt, it falls back to `placeholder`, which **breaks decryption**. **Fix this**: in Task 4 Step 4.1, change the salt extraction to **read from a checked-in `.memvc/config.salt` file** OR **require the user to set salt as a second secret**. Updating below.

- **Type consistency:** `RunResult { ok, text, durationMs } | { ok: false, error, durationMs }` matches sibling runners. `RunOptions { timeoutMs?, outputFormat?, cwd? }` consumed correctly (`outputFormat` ignored — REST always returns JSON; `cwd` not applicable to a network call). Acceptable.

- **Out of scope:**
  - Streaming responses (current contract is one-shot text only).
  - Per-prompt model override (memvc renders the same model for every call).
  - Caching responses across runs.
  - Anthropic-API runner (still a stub; out of scope for this sprint).

### CRITICAL FIX: salt handling in workflow

The original Task 4 Step 4.1 grep-and-sed for salt is fragile and probably wrong (the salt isn't in `.memvc/index.json` — it's in `~/.memvc/config.json` which doesn't exist in CI). **Replace** the salt-extraction line with reading from a committed file in the repo:

When `memvc init --encrypt` writes `~/.memvc/config.json` locally, also write `<repoPath>/.memvc/repo-salt.json` containing just the salt. This file is safe to commit (the salt is already public-knowledge — security relies on the passphrase, not salt secrecy). Then the workflow reads `.memvc/repo-salt.json` from the checked-out repo.

**Add a Task 3.6** before the workflow init commit:
- Modify `src/commands/init-wizard.ts` `applyWizardAnswers` and `src/commands/init.ts` flag-mode to also write `<repoPath>/.memvc/repo-salt.json` containing `{"salt": "<base64>"}` when `encrypt: true`.
- Update workflow YAML to read salt from that file:

```yaml
SALT="$(jq -r .salt $REPO_PATH/.memvc/repo-salt.json 2>/dev/null || echo placeholder)"
```

(Then use `"salt": "$SALT"` in the heredoc.)

If you'd rather not commit the salt file, alternative: pass salt as a SECOND repo secret `MEMVC_SALT`. Up to user — safer to commit (no extra secret to manage; salt isn't sensitive).

**Apply this fix during Task 4 implementation** — don't ship the broken grep version.
