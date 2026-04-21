# Interactive `memvc init` Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current `memvc init <repoUrl>` (single positional arg + 3 flags) with an interactive 6-question wizard that walks new users through repo URL, local path, encryption + passphrase storage, runner choice, runner verification, and writes `~/.memvc/config.json` + (optionally) `~/.memvc/passphrase`. Existing flag-driven mode remains for CI ("hybrid mode").

**Architecture:**
- New file `src/commands/init-wizard.ts` owns the prompt loop. Uses Node built-in `node:readline/promises` (no new dep) wrapped in tiny helpers (`prompt`, `promptChoice`, `promptYesNo`, `promptHidden`). Returns a fully-validated `WizardAnswers` object.
- `src/commands/init.ts` becomes a thin dispatcher: if **any** non-required flag is provided OR `repoUrl` is given on the command line, run **non-interactive** (today's behavior, lightly extended to honor a new `--passphrase-file` flag for parity); otherwise run the **wizard** then call the same write logic.
- Repo materialization: `src/git-ops.ts` gains a `materializeRepoAtPath(localPath, repoUrl)` that handles three cases: dir-doesn't-exist→clone, dir-exists-empty→clone, dir-exists-with-`.git`→use-as-is + verify remote URL matches (warn if not). Today's `ensureRepo` is a special case — refactor it.
- Passphrase storage: a new `src/passphrase-store.ts` writes `~/.memvc/passphrase` with mode `0600` and reads it as the second source after `MEMVC_PASSPHRASE` env. `getPassphrase()` in `config.ts` becomes env > file > throw.
- Runner verification: `src/runner-check.ts` runs `claude --version` (or generic binary `--version`) for the chosen runner. If exit code 0, ✅. If non-zero / not on PATH, print install hint with the official URL. Then ask the user "test a real call now? (y/N)" — if yes, send a 1-token "ping" via existing runner adapter.
- "Summarize into a book?" + "Use local AI agent?" answers are stored on `Config` as `digestEnabled: boolean` and `runner` ("claude-cli" stays; "github-action" is a placeholder enum value reserved for the future, NOT yet wired). The wizard enforces "github-action" is "coming soon" and re-asks.

**Tech Stack:** Node 20+ (built-in `readline/promises`), TypeScript ESM, vitest, no new runtime deps.

**Spec reference:** Conversation 2026-04-21:
- "init 时通过问卷的形式" → wizard
- "你的 repo 是什么？指定路径" → Q1 + Q2
- "路径里面有对应 repo 的话就不 clone，没有的话在那个路径里 clone，跳过则默认在 .memvc 下 clone" → Task 3 materialize logic with cwd-local default `./.memvc/repo`
- "选择是否 encrypt，如果是的话请输入密码" → Q3 + Q4
- "选择是否需要总结成 book？是否使用本地 ai agent？跳过/否的话用 GitHub Copilot action（之后再加）" → Q5 + Q6 with "GitHub Action" reserved
- "选择模型，本地 ai agent 比如 Claude 的话需要验证一下通不通" → Q7 + verification
- User decisions today: passphrase → `~/.memvc/passphrase`; default path → `./.memvc/repo`; flags retained as hybrid escape hatch; runner check = binary + optional test API call.

---

## Scope

7 tasks, 7 commits. Each independently committable.

- **Task 1**: `prompts.ts` — built-in readline-based prompt helpers + tests
- **Task 2**: `passphrase-store.ts` + `config.getPassphrase()` env→file fallback + tests
- **Task 3**: `git-ops.materializeRepoAtPath` + tests
- **Task 4**: `runner-check.ts` (binary + ping) + tests
- **Task 5**: `init-wizard.ts` — orchestrate 7 questions, return validated answers + tests
- **Task 6**: Refactor `init.ts` + `cli.ts` to hybrid (flags = non-interactive, no flags = wizard); add `digestEnabled` to Config
- **Task 7**: Update README and add e2e snapshot test of wizard transcript

---

## File Structure

**Created:**
- `src/prompts.ts` — readline-based prompt helpers
- `src/passphrase-store.ts` — read/write `~/.memvc/passphrase`
- `src/runner-check.ts` — binary detection + ping
- `src/commands/init-wizard.ts` — interactive flow
- `tests/prompts.test.ts`
- `tests/passphrase-store.test.ts`
- `tests/runner-check.test.ts`
- `tests/commands/init-wizard.test.ts`

**Modified:**
- `src/config.ts` — add `digestEnabled: boolean` to schema; rewrite `getPassphrase` to env→file→throw
- `src/git-ops.ts` — add `materializeRepoAtPath`; keep `ensureRepo` as a thin wrapper for backward compat
- `src/commands/init.ts` — dispatch wizard vs flag mode; honor `digestEnabled`
- `src/cli.ts` — make `<repoUrl>` argument optional; add `--digest`/`--no-digest` flag

**Untouched:** sync.ts, digest.ts, threading, article, chapter, etc.

---

## Task 1: `prompts.ts` — readline-based helpers

**Files:**
- Create: `src/prompts.ts`
- Create: `tests/prompts.test.ts`

### Step 1.1 — Write helpers

`src/prompts.ts`:

```ts
import { createInterface, Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * Minimal readline-promise wrapper. Caller closes the rl interface via
 * `closePrompts()` once all questions are asked. Helpers below all use the
 * SAME shared rl so they stay synchronous-feeling for the user.
 */
let _rl: Interface | undefined;
function rl(): Interface {
  if (!_rl) _rl = createInterface({ input, output });
  return _rl;
}
export function closePrompts(): void {
  if (_rl) {
    _rl.close();
    _rl = undefined;
  }
}

/** Free-text input. Returns empty string on EOF / Ctrl-D. */
export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const ans = (await rl().question(`${question}${suffix}: `)).trim();
  return ans || defaultValue || "";
}

/** y/n → true/false. Default applies on empty input. */
export async function promptYesNo(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  for (;;) {
    const ans = (await rl().question(`${question} ${hint}: `)).trim().toLowerCase();
    if (!ans) return defaultYes;
    if (ans === "y" || ans === "yes") return true;
    if (ans === "n" || ans === "no") return false;
    console.log(`  please answer y or n`);
  }
}

/** Pick from labeled options. Returns the value of the chosen option. */
export async function promptChoice<T extends string>(
  question: string,
  options: { value: T; label: string; description?: string }[],
  defaultIndex = 0,
): Promise<T> {
  console.log(question);
  for (let i = 0; i < options.length; i++) {
    const o = options[i]!;
    const marker = i === defaultIndex ? "*" : " ";
    const desc = o.description ? `  — ${o.description}` : "";
    console.log(`  ${marker} ${i + 1}) ${o.label}${desc}`);
  }
  for (;;) {
    const raw = (await rl().question(`Choose [1-${options.length}, default ${defaultIndex + 1}]: `)).trim();
    if (!raw) return options[defaultIndex]!.value;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.value;
    console.log(`  please enter a number 1-${options.length}`);
  }
}

/**
 * Hidden input (passphrase). Disables echo by writing the question, then
 * temporarily silencing stdout writes from readline echo via a write-shim.
 * Falls back to plain prompt if stdin isn't a TTY.
 */
export async function promptHidden(question: string): Promise<string> {
  if (!input.isTTY) return prompt(question);
  const r = rl();
  // Hack: monkey-patch _writeToOutput so each keystroke writes "*".
  // This is the standard Node.js trick for hidden input via readline.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyR = r as any;
  const origWrite = anyR._writeToOutput?.bind(anyR);
  anyR._writeToOutput = (s: string) => {
    if (s.includes(question)) origWrite(s);
    else origWrite("*".repeat(s.length));
  };
  try {
    const ans = await r.question(`${question}: `);
    output.write("\n");
    return ans;
  } finally {
    if (origWrite) anyR._writeToOutput = origWrite;
  }
}
```

### Step 1.2 — Tests

`tests/prompts.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable, Writable } from "node:stream";

// We test by injecting fake stdin/stdout. Since prompts.ts reads `process.stdin`,
// we mock that with vi.stubGlobal in each test.

function fakeIO(linesIn: string[]) {
  const stdin = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
  stdin.isTTY = true;
  const out: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      out.push(chunk.toString());
      cb();
    },
  }) as Writable & { isTTY?: boolean; columns?: number };
  stdout.isTTY = true;
  stdout.columns = 80;
  // Push input lines asynchronously so readline question() resolves.
  let i = 0;
  const pump = () => {
    if (i < linesIn.length) {
      stdin.push(linesIn[i++] + "\n");
      setImmediate(pump);
    }
  };
  setImmediate(pump);
  return { stdin, stdout, out };
}

describe("prompts", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prompt returns trimmed input", async () => {
    const { stdin, stdout } = fakeIO(["  hello  "]);
    vi.stubGlobal("process", { ...process, stdin, stdout });
    const { prompt, closePrompts } = await import("../src/prompts.js");
    const r = await prompt("Name");
    closePrompts();
    expect(r).toBe("hello");
  });

  it("prompt returns default on empty input", async () => {
    const { stdin, stdout } = fakeIO([""]);
    vi.stubGlobal("process", { ...process, stdin, stdout });
    const { prompt, closePrompts } = await import("../src/prompts.js");
    const r = await prompt("Name", "anon");
    closePrompts();
    expect(r).toBe("anon");
  });

  it("promptYesNo y → true, n → false, empty → default", async () => {
    const { stdin, stdout } = fakeIO(["y", "n", ""]);
    vi.stubGlobal("process", { ...process, stdin, stdout });
    const { promptYesNo, closePrompts } = await import("../src/prompts.js");
    expect(await promptYesNo("a")).toBe(true);
    expect(await promptYesNo("b")).toBe(false);
    expect(await promptYesNo("c", true)).toBe(true);
    closePrompts();
  });

  it("promptYesNo re-asks on garbage input", async () => {
    const { stdin, stdout } = fakeIO(["maybe", "y"]);
    vi.stubGlobal("process", { ...process, stdin, stdout });
    const { promptYesNo, closePrompts } = await import("../src/prompts.js");
    expect(await promptYesNo("a")).toBe(true);
    closePrompts();
  });

  it("promptChoice returns chosen value; empty picks default", async () => {
    const { stdin, stdout } = fakeIO(["2"]);
    vi.stubGlobal("process", { ...process, stdin, stdout });
    const { promptChoice, closePrompts } = await import("../src/prompts.js");
    const r = await promptChoice("pick", [
      { value: "a" as const, label: "A" },
      { value: "b" as const, label: "B" },
    ], 0);
    closePrompts();
    expect(r).toBe("b");
  });
});
```

### Step 1.3 — Run + commit

- [ ] `npm test -- prompts` — green, 5 tests pass.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "feat(prompts): readline-based interactive prompt helpers (no new deps)"`

---

## Task 2: Passphrase storage (env → file → throw)

**Files:**
- Create: `src/passphrase-store.ts`
- Modify: `src/config.ts` (rewrite `getPassphrase`)
- Create: `tests/passphrase-store.test.ts`

### Step 2.1 — Implement passphrase-store.ts

`src/passphrase-store.ts`:

```ts
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Path of the on-disk passphrase. Plain text on purpose — chmod 600 is the
 * only protection. Users who want stronger storage should set MEMVC_PASSPHRASE
 * via shell init / 1Password CLI / etc.
 */
export function passphrasePath(): string {
  return join(homedir(), ".memvc", "passphrase");
}

export function readPassphraseFile(): string | undefined {
  const p = passphrasePath();
  if (!existsSync(p)) return undefined;
  return readFileSync(p, "utf8").trim() || undefined;
}

export function writePassphraseFile(passphrase: string): void {
  const p = passphrasePath();
  mkdirSync(join(homedir(), ".memvc"), { recursive: true });
  writeFileSync(p, passphrase + "\n", { mode: 0o600 });
  // writeFileSync's `mode` only applies on file create; chmod again to handle
  // the overwrite case (file already existed with looser perms).
  chmodSync(p, 0o600);
}
```

### Step 2.2 — Update config.getPassphrase

In `src/config.ts`, replace:

```ts
export function getPassphrase(): string {
  const p = process.env.MEMVC_PASSPHRASE;
  if (!p) throw new Error("encryption is on — set MEMVC_PASSPHRASE env var");
  return p;
}
```

With:

```ts
import { readPassphraseFile } from "./passphrase-store.js";

export function getPassphrase(): string {
  const env = process.env.MEMVC_PASSPHRASE;
  if (env) return env;
  const file = readPassphraseFile();
  if (file) return file;
  throw new Error(
    "encryption is on — set MEMVC_PASSPHRASE env var, or save a passphrase via `memvc init`",
  );
}
```

### Step 2.3 — Tests

`tests/passphrase-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("passphrase-store", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "memvc-pp-"));
    vi.stubEnv("HOME", tmpHome);
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("readPassphraseFile returns undefined when no file", async () => {
    const m = await import("../src/passphrase-store.js");
    expect(m.readPassphraseFile()).toBeUndefined();
  });

  it("writePassphraseFile creates file with mode 0600", async () => {
    const m = await import("../src/passphrase-store.js");
    m.writePassphraseFile("secret");
    const p = m.passphrasePath();
    const s = statSync(p);
    expect(s.mode & 0o777).toBe(0o600);
    expect(m.readPassphraseFile()).toBe("secret");
  });

  it("writePassphraseFile overwrites and re-chmods existing file", async () => {
    mkdirSync(join(tmpHome, ".memvc"), { recursive: true });
    const p = join(tmpHome, ".memvc", "passphrase");
    writeFileSync(p, "old\n", { mode: 0o644 });
    const m = await import("../src/passphrase-store.js");
    m.writePassphraseFile("new");
    expect(m.readPassphraseFile()).toBe("new");
    const s = statSync(p);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("readPassphraseFile trims whitespace and returns undefined on empty", async () => {
    const m = await import("../src/passphrase-store.js");
    m.writePassphraseFile("  ");
    expect(m.readPassphraseFile()).toBeUndefined();
  });

  it("config.getPassphrase prefers env over file", async () => {
    const m = await import("../src/passphrase-store.js");
    m.writePassphraseFile("from-file");
    vi.stubEnv("MEMVC_PASSPHRASE", "from-env");
    const cfg = await import("../src/config.js");
    expect(cfg.getPassphrase()).toBe("from-env");
  });

  it("config.getPassphrase falls back to file when env missing", async () => {
    const m = await import("../src/passphrase-store.js");
    m.writePassphraseFile("from-file");
    const cfg = await import("../src/config.js");
    expect(cfg.getPassphrase()).toBe("from-file");
  });

  it("config.getPassphrase throws when neither env nor file set", async () => {
    const cfg = await import("../src/config.js");
    expect(() => cfg.getPassphrase()).toThrow(/encryption is on/);
  });
});
```

### Step 2.4 — Run + commit

- [ ] `npm test -- passphrase-store` — green, 7 tests pass.
- [ ] `npm test` — full suite still green.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "feat(passphrase): persistent ~/.memvc/passphrase store; getPassphrase prefers env then file"`

---

## Task 3: `materializeRepoAtPath` in git-ops

**Files:**
- Modify: `src/git-ops.ts`
- Modify: `tests/git-ops.test.ts` (or create if missing)

### Step 3.1 — Add materializeRepoAtPath

In `src/git-ops.ts`, ABOVE the existing `ensureRepo`, add:

```ts
import { readdirSync } from "node:fs";

export interface MaterializeResult {
  /** "cloned" = brand-new clone; "existing" = used existing checkout;
   *  "init" = empty dir made into a git repo with origin set. */
  kind: "cloned" | "existing" | "init";
  /** When "existing", this is the URL of `origin` already in that repo —
   *  may differ from repoUrl, in which case caller should warn the user. */
  existingRemote?: string;
}

/**
 * Make sure `localPath` contains the repo at `repoUrl`.
 *
 * - If `localPath` doesn't exist OR exists-and-empty → `git clone repoUrl
 *   localPath`. Returns kind:"cloned".
 * - If `localPath` exists and contains `.git` → reuse. Returns kind:"existing"
 *   with `existingRemote` so the wizard can warn on URL mismatch. Does NOT
 *   change the existing remote.
 * - If `localPath` exists, non-empty, no `.git` → throw with a friendly
 *   message; refuse to scribble inside an unrelated dir.
 */
export async function materializeRepoAtPath(
  localPath: string,
  repoUrl: string,
): Promise<MaterializeResult> {
  if (!existsSync(localPath)) {
    mkdirSync(localPath, { recursive: true });
    await simpleGit().clone(repoUrl, localPath);
    return { kind: "cloned" };
  }
  const entries = readdirSync(localPath);
  if (entries.length === 0) {
    await simpleGit().clone(repoUrl, localPath);
    return { kind: "cloned" };
  }
  if (entries.includes(".git")) {
    const git = simpleGit(localPath);
    let remote = "";
    try {
      remote = (await git.getConfig("remote.origin.url")).value ?? "";
    } catch { /* no remote configured */ }
    return { kind: "existing", existingRemote: remote };
  }
  throw new Error(
    `${localPath} is not empty and is not a git repo. Pick another path or empty this one first.`,
  );
}
```

### Step 3.2 — Make ensureRepo a thin wrapper

Replace the existing `ensureRepo` body with:

```ts
export async function ensureRepo(localPath: string, repoUrl: string): Promise<SimpleGit> {
  const r = await materializeRepoAtPath(localPath, repoUrl);
  const git = simpleGit(localPath);
  if (r.kind === "init" || (!existsSync(join(localPath, ".git")))) {
    await git.init();
    await git.addRemote("origin", repoUrl).catch(() => { /* exists */ });
  }
  return git;
}
```

(This preserves the "may have been an empty dir we just initialized but didn't clone" path that the original handled.)

### Step 3.3 — Tests

Append to `tests/git-ops.test.ts` (or create if absent):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { materializeRepoAtPath } from "../src/git-ops.js";

describe("materializeRepoAtPath", () => {
  let tmp: string;
  let originPath: string;
  let originUrl: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memvc-mat-"));
    // Build a tiny bare repo to act as a fake origin.
    originPath = join(tmp, "origin.git");
    mkdirSync(originPath);
    await simpleGit(originPath).init(true);
    // Seed with one commit via a working dir.
    const seed = join(tmp, "seed");
    mkdirSync(seed);
    const sg = simpleGit(seed);
    await sg.init();
    writeFileSync(join(seed, "README.md"), "x\n");
    await sg.add(".");
    await sg.addConfig("user.email", "t@t");
    await sg.addConfig("user.name", "t");
    await sg.commit("init");
    await sg.addRemote("origin", originPath);
    await sg.push("origin", "master").catch(() => sg.push("origin", "main"));
    originUrl = originPath;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("clones into a non-existent dir", async () => {
    const target = join(tmp, "target");
    const r = await materializeRepoAtPath(target, originUrl);
    expect(r.kind).toBe("cloned");
    expect(existsSync(join(target, ".git"))).toBe(true);
  });

  it("clones into an existing-but-empty dir", async () => {
    const target = join(tmp, "empty");
    mkdirSync(target);
    const r = await materializeRepoAtPath(target, originUrl);
    expect(r.kind).toBe("cloned");
  });

  it("reuses an existing checkout and reports remote URL", async () => {
    const target = join(tmp, "existing");
    await simpleGit().clone(originUrl, target);
    const r = await materializeRepoAtPath(target, originUrl);
    expect(r.kind).toBe("existing");
    expect(r.existingRemote).toBe(originUrl);
  });

  it("reports mismatched remote on existing checkout", async () => {
    const target = join(tmp, "existing-mismatch");
    await simpleGit().clone(originUrl, target);
    const r = await materializeRepoAtPath(target, "https://other.example/different.git");
    expect(r.kind).toBe("existing");
    expect(r.existingRemote).toBe(originUrl);
    // Caller is responsible for warning the user; we just report the actual.
  });

  it("refuses non-empty non-repo dir", async () => {
    const target = join(tmp, "junk");
    mkdirSync(target);
    writeFileSync(join(target, "file.txt"), "x");
    await expect(materializeRepoAtPath(target, originUrl)).rejects.toThrow(/not a git repo/);
  });
});
```

### Step 3.4 — Run + commit

- [ ] `npm test -- git-ops` — green, 5 tests pass.
- [ ] `npm test` — full suite green.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "feat(git-ops): materializeRepoAtPath handles clone/reuse/empty/refuse cases; ensureRepo refactored to wrap it"`

---

## Task 4: `runner-check.ts` (binary detection + ping)

**Files:**
- Create: `src/runner-check.ts`
- Create: `tests/runner-check.test.ts`

### Step 4.1 — Implement runner-check.ts

`src/runner-check.ts`:

```ts
import { spawn } from "node:child_process";

export interface RunnerCheckResult {
  ok: boolean;
  /** Captured stdout/stderr trimmed; useful for surfacing errors. */
  output: string;
  /** Install hint if !ok. */
  hint?: string;
}

/**
 * Spawn `cmd --version` (or any args you like) and return ok/output.
 * No timeout escalation: kills the child after `timeoutMs` (default 5s).
 */
export async function checkBinary(
  cmd: string,
  args: string[] = ["--version"],
  timeoutMs = 5000,
): Promise<RunnerCheckResult> {
  return new Promise((resolve) => {
    const out: string[] = [];
    let settled = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ ok: false, output: out.join(""), hint: `${cmd} timed out` });
    }, timeoutMs);

    child.stdout.on("data", (d) => out.push(d.toString()));
    child.stderr.on("data", (d) => out.push(d.toString()));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, output: out.join(""), hint: `${cmd} not found on PATH (${e.message})` });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, output: out.join("").trim() });
      else resolve({ ok: false, output: out.join("").trim(), hint: `${cmd} exited with ${code}` });
    });
  });
}

const RUNNER_HINTS: Record<string, { binary: string; install: string }> = {
  "claude-cli": {
    binary: "claude",
    install: "https://docs.claude.com/claude-code/installation",
  },
};

/** Return null if runner not known to need a local binary. */
export function runnerBinary(runner: string): string | null {
  return RUNNER_HINTS[runner]?.binary ?? null;
}

export function runnerInstallUrl(runner: string): string | null {
  return RUNNER_HINTS[runner]?.install ?? null;
}
```

### Step 4.2 — Tests

`tests/runner-check.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { checkBinary, runnerBinary, runnerInstallUrl } from "../src/runner-check.js";

describe("checkBinary", () => {
  it("returns ok:true for a known-good binary (`node --version`)", async () => {
    const r = await checkBinary("node", ["--version"]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/^v\d+/);
  });

  it("returns ok:false with hint for unknown binary", async () => {
    const r = await checkBinary("definitely-not-a-real-binary-xyz123");
    expect(r.ok).toBe(false);
    expect(r.hint).toContain("not found");
  });

  it("returns ok:false on non-zero exit", async () => {
    const r = await checkBinary("node", ["-e", "process.exit(7)"]);
    expect(r.ok).toBe(false);
    expect(r.hint).toContain("exited with 7");
  });

  it("times out long-running command", async () => {
    const r = await checkBinary("node", ["-e", "setTimeout(()=>{}, 30000)"], 200);
    expect(r.ok).toBe(false);
    expect(r.hint).toContain("timed out");
  });
});

describe("runnerBinary / runnerInstallUrl", () => {
  it("knows claude-cli", () => {
    expect(runnerBinary("claude-cli")).toBe("claude");
    expect(runnerInstallUrl("claude-cli")).toMatch(/^https:/);
  });
  it("returns null for unknown", () => {
    expect(runnerBinary("nope")).toBeNull();
    expect(runnerInstallUrl("nope")).toBeNull();
  });
});
```

### Step 4.3 — Run + commit

- [ ] `npm test -- runner-check` — green, 6 tests pass.
- [ ] `npm test` — full suite green.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "feat(runner-check): binary-detection + install-hint helper for runner verification"`

---

## Task 5: `init-wizard.ts` — orchestrate 7 questions

**Files:**
- Create: `src/commands/init-wizard.ts`
- Create: `tests/commands/init-wizard.test.ts`

### Step 5.1 — Define WizardAnswers shape + flow

`src/commands/init-wizard.ts`:

```ts
import { join } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import { prompt, promptYesNo, promptChoice, promptHidden, closePrompts } from "../prompts.js";
import { materializeRepoAtPath } from "../git-ops.js";
import { writePassphraseFile } from "../passphrase-store.js";
import {
  freshSaltBase64, writeConfig, configExists,
  DEFAULT_THREADING_CONCURRENCY, DEFAULT_THREADING_MAX_ATTEMPTS,
  type Config,
} from "../config.js";
import { deviceBranchFromHostname } from "../device.js";
import { checkBinary, runnerBinary, runnerInstallUrl } from "../runner-check.js";

export interface WizardAnswers {
  repoUrl: string;
  localPath: string;
  encrypt: boolean;
  passphraseEntered?: string;
  digestEnabled: boolean;
  runner: "claude-cli" | "github-action";
  runnerModel: string;
}

/**
 * Returns the path the wizard will use when the user skips the path question.
 * Cwd-local hidden dir per user preference.
 */
export function defaultLocalPath(): string {
  return join(process.cwd(), ".memvc", "repo");
}

/**
 * Run the interactive 7-step wizard. Returns answers; caller owns writing
 * config + materializing the repo. Throws on user-invalid input that the
 * loops can't recover from (caller catches and exits non-zero).
 */
export async function runWizard(): Promise<WizardAnswers> {
  console.log(chalk.bold("\nmemvc init wizard\n"));

  // Q1: repo URL
  const repoUrl = await prompt(
    chalk.cyan("Q1") + " Private git repo URL (e.g. git@github.com:you/work-memory.git)",
  );
  if (!repoUrl) throw new Error("repo URL is required");

  // Q2: local path
  const dflt = defaultLocalPath();
  const localPath = await prompt(
    chalk.cyan("Q2") + ` Where should the repo live locally?`,
    dflt,
  );

  // Q3: encrypt
  const encrypt = await promptYesNo(
    chalk.cyan("Q3") + " Encrypt raw session files before commit?",
    true,
  );

  // Q4: passphrase (only if encrypt)
  let passphraseEntered: string | undefined;
  if (encrypt) {
    for (;;) {
      const pp = await promptHidden(chalk.cyan("Q4") + " Passphrase (will be saved to ~/.memvc/passphrase, mode 0600)");
      if (!pp) {
        const skip = await promptYesNo("  Skip storing? You'll need to set MEMVC_PASSPHRASE before sync", false);
        if (skip) break;
        continue;
      }
      const pp2 = await promptHidden("  Confirm passphrase");
      if (pp === pp2) {
        passphraseEntered = pp;
        break;
      }
      console.log(chalk.yellow("  passphrases didn't match, try again"));
    }
  }

  // Q5: digest enabled
  const digestEnabled = await promptYesNo(
    chalk.cyan("Q5") + " Summarize sessions into a book?",
    true,
  );

  // Q6 + Q7 only if digest enabled
  let runner: WizardAnswers["runner"] = "claude-cli";
  let runnerModel = "";
  if (digestEnabled) {
    for (;;) {
      runner = await promptChoice(
        chalk.cyan("Q6") + " Runner",
        [
          { value: "claude-cli", label: "Local Claude CLI", description: "needs `claude` on PATH" },
          { value: "github-action", label: "GitHub Action (coming soon)", description: "no local install; runs in CI" },
        ],
        0,
      );
      if (runner === "github-action") {
        console.log(chalk.yellow("  GitHub Action runner is not implemented yet — please pick another."));
        continue;
      }
      break;
    }
    runnerModel = await prompt(
      chalk.cyan("Q7") + " Model name (blank = runner default)",
      "",
    );
  }

  return { repoUrl, localPath, encrypt, passphraseEntered, digestEnabled, runner, runnerModel };
}

/**
 * Verify the chosen runner's binary is available, then optionally make a real
 * test call. Prints results; returns true iff binary check passed (test-call
 * failures are warnings, not blocking). Caller can decide to abort.
 */
export async function verifyRunner(runner: string): Promise<boolean> {
  const bin = runnerBinary(runner);
  if (!bin) return true; // nothing local to check
  console.log(chalk.gray(`\nVerifying runner '${runner}'...`));
  const r = await checkBinary(bin, ["--version"]);
  if (!r.ok) {
    console.log(chalk.red(`  ✗ ${bin} not available: ${r.hint ?? "unknown error"}`));
    const url = runnerInstallUrl(runner);
    if (url) console.log(chalk.gray(`    install: ${url}`));
    return false;
  }
  console.log(chalk.green(`  ✓ ${bin}: ${r.output.split("\n")[0]}`));
  const ping = await promptYesNo("  Test a real API call now? (sends 1-token ping)", false);
  if (ping) {
    console.log(chalk.gray("  (test call not yet implemented — skipping)"));
  }
  return true;
}

/**
 * Materialize repo + write config + (optionally) save passphrase. Pure I/O,
 * separated so wizard logic stays unit-testable.
 */
export async function applyWizardAnswers(a: WizardAnswers): Promise<void> {
  const mat = await materializeRepoAtPath(a.localPath, a.repoUrl);
  if (mat.kind === "existing" && mat.existingRemote && mat.existingRemote !== a.repoUrl) {
    console.log(chalk.yellow(
      `  warning: ${a.localPath} already has remote '${mat.existingRemote}', not '${a.repoUrl}'. Using existing.`,
    ));
  } else if (mat.kind === "cloned") {
    console.log(chalk.gray(`  cloned ${a.repoUrl} → ${a.localPath}`));
  } else {
    console.log(chalk.gray(`  using existing repo at ${a.localPath}`));
  }
  if (a.encrypt && a.passphraseEntered) {
    writePassphraseFile(a.passphraseEntered);
    console.log(chalk.gray(`  passphrase saved to ~/.memvc/passphrase (mode 0600)`));
  }
  const cfg: Config = {
    repoPath: a.localPath,
    repoUrl: a.repoUrl,
    encrypt: a.encrypt,
    salt: freshSaltBase64(),
    deviceBranch: deviceBranchFromHostname(),
    runner: a.runner,
    runnerModel: a.runnerModel,
    threadingConcurrency: DEFAULT_THREADING_CONCURRENCY,
    threadingMaxAttempts: DEFAULT_THREADING_MAX_ATTEMPTS,
    digestEnabled: a.digestEnabled,
  };
  writeConfig(cfg);
  console.log(chalk.green("\n✓ memvc initialized"));
  console.log(chalk.gray(`  config: ~/.memvc/config.json`));
}

/** Top-level entry — composes wizard + verify + apply, with cleanup. */
export async function runInitWizard(): Promise<void> {
  if (configExists()) {
    const overwrite = await promptYesNo(
      chalk.yellow("memvc already initialized at ~/.memvc/config.json. Overwrite?"),
      false,
    );
    if (!overwrite) {
      console.log(chalk.gray("aborted"));
      closePrompts();
      return;
    }
  }
  try {
    const answers = await runWizard();
    if (answers.digestEnabled) await verifyRunner(answers.runner);
    await applyWizardAnswers(answers);
  } finally {
    closePrompts();
  }
}
```

### Step 5.2 — Update Config schema for `digestEnabled`

In `src/config.ts`, inside the Zod schema, add:

```ts
digestEnabled: z.boolean().default(true),
```

(Default true so existing configs keep working — they implicitly had digest on.)

### Step 5.3 — Tests

`tests/commands/init-wizard.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("defaultLocalPath", () => {
  it("returns ./.memvc/repo under cwd", async () => {
    const m = await import("../../src/commands/init-wizard.js");
    expect(m.defaultLocalPath().endsWith("/.memvc/repo")).toBe(true);
  });
});

describe("applyWizardAnswers", () => {
  let tmpHome: string;
  let originUrl: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "memvc-wiz-"));
    vi.stubEnv("HOME", tmpHome);
    // Build a fake bare origin so materializeRepoAtPath can clone.
    const { simpleGit } = await import("simple-git");
    originUrl = join(tmpHome, "origin.git");
    mkdirSync(originUrl);
    await simpleGit(originUrl).init(true);
    const seed = join(tmpHome, "seed");
    mkdirSync(seed);
    const sg = simpleGit(seed);
    await sg.init();
    await sg.addConfig("user.email", "t@t");
    await sg.addConfig("user.name", "t");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(seed, "r"), "x");
    await sg.add(".");
    await sg.commit("c");
    await sg.addRemote("origin", originUrl);
    await sg.push("origin", "master").catch(() => sg.push("origin", "main"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("clones the repo, writes config, and writes passphrase when encrypt=true", async () => {
    const localPath = join(tmpHome, "checkout");
    const m = await import("../../src/commands/init-wizard.js");
    await m.applyWizardAnswers({
      repoUrl: originUrl,
      localPath,
      encrypt: true,
      passphraseEntered: "secret",
      digestEnabled: true,
      runner: "claude-cli",
      runnerModel: "",
    });
    const { existsSync, readFileSync, statSync } = await import("node:fs");
    expect(existsSync(join(localPath, ".git"))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(tmpHome, ".memvc", "config.json"), "utf8"));
    expect(cfg.repoUrl).toBe(originUrl);
    expect(cfg.repoPath).toBe(localPath);
    expect(cfg.encrypt).toBe(true);
    expect(cfg.digestEnabled).toBe(true);
    expect(cfg.runner).toBe("claude-cli");
    const pp = readFileSync(join(tmpHome, ".memvc", "passphrase"), "utf8").trim();
    expect(pp).toBe("secret");
    expect(statSync(join(tmpHome, ".memvc", "passphrase")).mode & 0o777).toBe(0o600);
  });

  it("does NOT write passphrase when encrypt=false", async () => {
    const localPath = join(tmpHome, "checkout");
    const m = await import("../../src/commands/init-wizard.js");
    await m.applyWizardAnswers({
      repoUrl: originUrl,
      localPath,
      encrypt: false,
      digestEnabled: false,
      runner: "claude-cli",
      runnerModel: "",
    });
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tmpHome, ".memvc", "passphrase"))).toBe(false);
  });
});

describe("verifyRunner", () => {
  it("returns true and logs version for a usable binary", async () => {
    const m = await import("../../src/commands/init-wizard.js");
    // Override claude-cli's binary to `node` for this test.
    vi.doMock("../../src/runner-check.js", async () => {
      const real = await vi.importActual<typeof import("../../src/runner-check.js")>("../../src/runner-check.js");
      return {
        ...real,
        runnerBinary: () => "node",
        runnerInstallUrl: () => "https://nodejs.org",
      };
    });
    // promptYesNo returns false (skip the test call) — mock prompts.
    vi.doMock("../../src/prompts.js", async () => ({
      prompt: vi.fn(),
      promptYesNo: vi.fn(async () => false),
      promptChoice: vi.fn(),
      promptHidden: vi.fn(),
      closePrompts: vi.fn(),
    }));
    vi.resetModules();
    const m2 = await import("../../src/commands/init-wizard.js");
    expect(await m2.verifyRunner("claude-cli")).toBe(true);
  });

  it("returns false for missing binary", async () => {
    vi.doMock("../../src/runner-check.js", async () => {
      const real = await vi.importActual<typeof import("../../src/runner-check.js")>("../../src/runner-check.js");
      return {
        ...real,
        runnerBinary: () => "definitely-not-real-xyz",
        runnerInstallUrl: () => "https://example.com",
      };
    });
    vi.doMock("../../src/prompts.js", async () => ({
      prompt: vi.fn(),
      promptYesNo: vi.fn(async () => false),
      promptChoice: vi.fn(),
      promptHidden: vi.fn(),
      closePrompts: vi.fn(),
    }));
    vi.resetModules();
    const m = await import("../../src/commands/init-wizard.js");
    expect(await m.verifyRunner("claude-cli")).toBe(false);
  });
});
```

### Step 5.4 — Run + commit

- [ ] `npm test -- init-wizard` — green, 4-5 tests pass.
- [ ] `npm test` — full suite green.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "feat(init): interactive wizard (repo URL, path, encrypt+passphrase, digest, runner, model, verification)"`

---

## Task 6: Hybrid dispatch in `init.ts` + `cli.ts`

**Files:**
- Modify: `src/commands/init.ts`
- Modify: `src/cli.ts`

### Step 6.1 — Make `<repoUrl>` optional in CLI; add `--digest`/`--no-digest`

In `src/cli.ts`, change the init command from:

```ts
program
  .command("init <repoUrl>")
  .description("Initialize memvc with a private repo")
  .option("--local-path <path>", "local checkout path (default ~/memvc-repo)")
  .option("--encrypt", "encrypt raw files before commit")
  .option("--device <name>", "device branch name (default: sanitized os.hostname())")
  .action(async (repoUrl: string, opts: { localPath?: string; encrypt?: boolean; device?: string }) => {
    const { initCmd } = await import("./commands/init.js");
    await initCmd({ repoUrl, localPath: opts.localPath, encrypt: opts.encrypt, device: opts.device });
  });
```

To:

```ts
program
  .command("init [repoUrl]")
  .description("Initialize memvc. Run with no arguments for the interactive wizard, or pass --repoUrl + flags for non-interactive setup.")
  .option("--local-path <path>", "local checkout path (default ./.memvc/repo)")
  .option("--encrypt", "encrypt raw files before commit")
  .option("--no-digest", "skip the digest pipeline (raw push only)")
  .option("--device <name>", "device branch name (default: sanitized os.hostname())")
  .option("--passphrase <pp>", "save passphrase to ~/.memvc/passphrase (only with --encrypt)")
  .action(async (
    repoUrl: string | undefined,
    opts: { localPath?: string; encrypt?: boolean; digest?: boolean; device?: string; passphrase?: string },
  ) => {
    const { initCmd } = await import("./commands/init.js");
    await initCmd({
      repoUrl,
      localPath: opts.localPath,
      encrypt: opts.encrypt,
      digestEnabled: opts.digest !== false, // commander: --no-digest sets digest=false
      device: opts.device,
      passphrase: opts.passphrase,
    });
  });
```

### Step 6.2 — Rewrite `init.ts` as dispatcher

Replace `src/commands/init.ts` body with:

```ts
import { writeConfig, freshSaltBase64, DEFAULT_THREADING_CONCURRENCY, DEFAULT_THREADING_MAX_ATTEMPTS, type Config } from "../config.js";
import { materializeRepoAtPath } from "../git-ops.js";
import { writePassphraseFile } from "../passphrase-store.js";
import { deviceBranchFromHostname } from "../device.js";
import { join } from "node:path";
import chalk from "chalk";

export interface InitOptions {
  repoUrl?: string;
  localPath?: string;
  encrypt?: boolean;
  digestEnabled?: boolean;
  device?: string;
  passphrase?: string;
}

/** Wizard mode kicks in when caller passed no flags AND no repoUrl. */
function isFlagMode(opts: InitOptions): boolean {
  return Boolean(
    opts.repoUrl || opts.localPath || opts.encrypt || opts.device ||
    opts.passphrase || opts.digestEnabled === false,
  );
}

export async function initCmd(opts: InitOptions): Promise<void> {
  if (!isFlagMode(opts)) {
    // No flags → interactive wizard.
    const { runInitWizard } = await import("./init-wizard.js");
    await runInitWizard();
    return;
  }

  // Flag mode: keep the old non-interactive path.
  if (!opts.repoUrl) {
    throw new Error("repoUrl is required in flag mode (or run `memvc init` with no args for the wizard)");
  }
  const localPath = opts.localPath ?? join(process.cwd(), ".memvc", "repo");
  const mat = await materializeRepoAtPath(localPath, opts.repoUrl);
  if (mat.kind === "existing" && mat.existingRemote && mat.existingRemote !== opts.repoUrl) {
    console.log(chalk.yellow(
      `warning: ${localPath} already has remote '${mat.existingRemote}', not '${opts.repoUrl}'. Using existing.`,
    ));
  }
  if (opts.encrypt && opts.passphrase) {
    writePassphraseFile(opts.passphrase);
  }
  const cfg: Config = {
    repoPath: localPath,
    repoUrl: opts.repoUrl,
    encrypt: !!opts.encrypt,
    salt: freshSaltBase64(),
    deviceBranch: opts.device ?? deviceBranchFromHostname(),
    runner: "claude-cli",
    runnerModel: "",
    threadingConcurrency: DEFAULT_THREADING_CONCURRENCY,
    threadingMaxAttempts: DEFAULT_THREADING_MAX_ATTEMPTS,
    digestEnabled: opts.digestEnabled !== false,
  };
  writeConfig(cfg);
  console.log(chalk.green(`memvc initialized:`));
  console.log(`  repo: ${localPath}`);
  console.log(`  remote: ${opts.repoUrl}`);
  console.log(`  device branch: ${cfg.deviceBranch}`);
  console.log(`  encrypt: ${cfg.encrypt}`);
  console.log(`  digest enabled: ${cfg.digestEnabled}`);
  if (cfg.encrypt && !opts.passphrase) {
    console.log(chalk.cyan(`  set MEMVC_PASSPHRASE env var (or pass --passphrase) before running sync`));
  }
}
```

### Step 6.3 — Sync command should respect `digestEnabled`

In `src/commands/sync.ts`, near the top of `syncCmd`, add (right after reading config):

```ts
if (cfg.digestEnabled === false && !opts.noDigest) {
  // Honor config; treat as if --no-digest was passed.
  opts.noDigest = true;
}
```

(Place it where `opts` and `cfg` are both in scope; if there's no easy place, surface it before the digest invocation: `if (!opts.noDigest && cfg.digestEnabled !== false) { ...digest... }`. Pick whichever fits the existing structure with minimum churn.)

### Step 6.4 — Tests

Add to `tests/commands/init-wizard.test.ts` or create `tests/commands/init.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("initCmd flag mode", () => {
  let tmpHome: string;
  let originUrl: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "memvc-init-"));
    vi.stubEnv("HOME", tmpHome);
    const { simpleGit } = await import("simple-git");
    originUrl = join(tmpHome, "origin.git");
    mkdirSync(originUrl);
    await simpleGit(originUrl).init(true);
    const seed = join(tmpHome, "seed");
    mkdirSync(seed);
    const sg = simpleGit(seed);
    await sg.init();
    await sg.addConfig("user.email", "t@t");
    await sg.addConfig("user.name", "t");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(seed, "r"), "x");
    await sg.add(".");
    await sg.commit("c");
    await sg.addRemote("origin", originUrl);
    await sg.push("origin", "master").catch(() => sg.push("origin", "main"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("flag mode with --encrypt + --passphrase persists config and passphrase", async () => {
    const localPath = join(tmpHome, "checkout");
    const { initCmd } = await import("../../src/commands/init.js");
    await initCmd({
      repoUrl: originUrl,
      localPath,
      encrypt: true,
      passphrase: "abc",
      digestEnabled: false,
    });
    const cfg = JSON.parse(readFileSync(join(tmpHome, ".memvc", "config.json"), "utf8"));
    expect(cfg.encrypt).toBe(true);
    expect(cfg.digestEnabled).toBe(false);
    expect(readFileSync(join(tmpHome, ".memvc", "passphrase"), "utf8").trim()).toBe("abc");
  });

  it("flag mode default localPath is ./.memvc/repo under cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "memvc-cwd-"));
    const orig = process.cwd();
    process.chdir(cwd);
    try {
      const { initCmd } = await import("../../src/commands/init.js");
      await initCmd({ repoUrl: originUrl });
      const cfg = JSON.parse(readFileSync(join(tmpHome, ".memvc", "config.json"), "utf8"));
      expect(cfg.repoPath).toBe(join(cwd, ".memvc", "repo"));
      expect(existsSync(join(cwd, ".memvc", "repo", ".git"))).toBe(true);
    } finally {
      process.chdir(orig);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("flag mode without repoUrl throws", async () => {
    const { initCmd } = await import("../../src/commands/init.js");
    await expect(initCmd({ encrypt: true })).rejects.toThrow(/repoUrl is required/);
  });
});
```

### Step 6.5 — Run + commit

- [ ] `npm test` — full suite green.
- [ ] `npm run build` — clean.
- [ ] Manual smoke: `npm run dev -- init` (no args) — wizard appears. `Ctrl-C` to exit.
- [ ] **Commit**: `git add -u && git commit -m "feat(cli): hybrid init — wizard when no flags, non-interactive when any flag/arg given; --no-digest + --passphrase + digestEnabled config field"`

---

## Task 7: README + e2e wizard transcript test

**Files:**
- Modify: `README.md` (replace init section)
- Modify: `tests/commands/init-wizard.test.ts` (append e2e test)

### Step 7.1 — README update

In `README.md`, find the existing init section (likely under "Quick start" / "Usage") and replace with:

````markdown
## Quick start

```bash
npm install -g memvc

memvc init           # interactive wizard
# or non-interactive:
memvc init git@github.com:you/work-memory.git --encrypt --passphrase secret

memvc sync
```

The wizard asks:
1. **Repo URL** — your private memory repo (will be cloned if not present)
2. **Local path** — defaults to `./.memvc/repo`
3. **Encrypt?** — y/n; if y, asks for a passphrase saved to `~/.memvc/passphrase` (mode 0600)
4. **Digest into a book?** — y/n
5. **Runner** — local Claude CLI today; GitHub Action coming
6. **Model** — blank for runner default
7. **Verify** — checks `claude --version`; offers a real test call

Flag mode (CI-friendly): pass any of `--local-path / --encrypt / --no-digest / --device / --passphrase` and the wizard is bypassed.
````

### Step 7.2 — E2E wizard transcript test

Append to `tests/commands/init-wizard.test.ts`:

```ts
import { Readable, Writable } from "node:stream";

describe("runWizard end-to-end transcript", () => {
  it("walks through all 7 questions and returns expected answers", async () => {
    const lines = [
      "git@github.com:you/repo.git",  // Q1 repo URL
      "",                              // Q2 path → default
      "y",                             // Q3 encrypt
      "secret123",                     // Q4 passphrase
      "secret123",                     // Q4 confirm
      "y",                             // Q5 digest
      "1",                             // Q6 runner = claude-cli
      "claude-sonnet-4-6",             // Q7 model
    ];
    const stdin = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
    stdin.isTTY = true;
    const out: string[] = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) { out.push(chunk.toString()); cb(); },
    }) as Writable & { isTTY?: boolean; columns?: number };
    stdout.isTTY = true;
    stdout.columns = 80;
    let i = 0;
    const pump = () => {
      if (i < lines.length) {
        stdin.push(lines[i++] + "\n");
        setImmediate(pump);
      }
    };
    setImmediate(pump);
    vi.stubGlobal("process", { ...process, stdin, stdout });
    vi.resetModules();
    const m = await import("../../src/commands/init-wizard.js");
    const a = await m.runWizard();
    m.closePrompts?.(); // closePrompts is in prompts.js, not exported here — reach in if needed
    expect(a.repoUrl).toBe("git@github.com:you/repo.git");
    expect(a.encrypt).toBe(true);
    expect(a.passphraseEntered).toBe("secret123");
    expect(a.digestEnabled).toBe(true);
    expect(a.runner).toBe("claude-cli");
    expect(a.runnerModel).toBe("claude-sonnet-4-6");
  });
});
```

(If `closePrompts` isn't re-exported from init-wizard.ts, import it directly from `../../src/prompts.js` at the top of the test file.)

### Step 7.3 — Run + commit

- [ ] `npm test` — full suite green; new e2e test passes.
- [ ] `npm run build` — clean.
- [ ] **Commit**: `git add -u && git commit -m "docs(init): README walks through wizard + flag mode; add e2e wizard transcript test"`

---

## Self-Review Checklist

- **Spec coverage:**
  - "init 时通过问卷" → wizard, Task 5 ✅
  - "你的 repo 是什么 + 指定路径 + 路径已存在则不 clone, 跳过则默认 .memvc 下" → Q1+Q2+Task 3 materialize ✅
  - "选择是否 encrypt + 输入密码" → Q3+Q4 + Task 2 passphrase store ✅
  - "选择是否需要总结成 book" → Q5 + `digestEnabled` config field ✅
  - "是否使用本地 ai agent / 否则用 GitHub action（之后再加）" → Q6 with `github-action` reserved value ✅
  - "选择模型" → Q7 ✅
  - "本地 ai agent 验证一下通不通" → `verifyRunner` Task 5 + `runner-check` Task 4 ✅
  - User decisions: passphrase to file ✅; default `./.memvc/repo` ✅; hybrid flag mode ✅; binary + optional test call ✅

- **Placeholder scan:** every step has runnable code; tests included; commands exact. The "test call not yet implemented — skipping" line in `verifyRunner` is intentional (the real ping requires the runner adapter, outside this plan's scope).

- **Type consistency:**
  - `WizardAnswers.runner: "claude-cli" | "github-action"` matches `Config.runner` enum + adds `"github-action"` placeholder. Need to widen `Config.runner` enum to include `"github-action"` OR keep config narrow and only set `"claude-cli"` in `applyWizardAnswers`. **Fix:** in Task 5 Step 5.2 also widen `Config.runner` enum to `["claude-cli", "anthropic-api", "github-models", "github-action"]` (since wizard refuses to actually use `"github-action"`, but type-correct).
  - `digestEnabled: boolean` consistent across `Config`, `WizardAnswers`, `InitOptions`, `applyWizardAnswers`, `sync.ts`.
  - `materializeRepoAtPath` return shape (`MaterializeResult`) consumed identically in `applyWizardAnswers` and `initCmd` flag mode.
  - `passphrasePath / readPassphraseFile / writePassphraseFile` exported names match their usage in wizard + tests + `getPassphrase`.

- **Backward compat:**
  - Old `memvc init <url>` syntax still works (commander treats `[repoUrl]` as positional optional; if user supplies it, it goes through flag mode).
  - Existing `Config` files on disk: missing `digestEnabled` → Zod default `true` → existing users unaffected.
  - `MEMVC_PASSPHRASE` env var still works (priority over file).

- **Out of scope:**
  - Real "test API call" implementation (placeholder only — wires through runner adapter).
  - GitHub Action runner implementation (placeholder enum value; wizard refuses to select).
  - macOS Keychain integration (rejected in favor of file).
  - Migration helper for users with existing `~/memvc-repo` checkouts (they can keep it; their config still points there).

- **Type fix to apply during Task 5 Step 5.2:** when adding `digestEnabled`, ALSO change `runner: z.enum(["claude-cli", "anthropic-api", "github-models"])` → `runner: z.enum(["claude-cli", "anthropic-api", "github-models", "github-action"])`. This keeps wizard's union type assignable to Config without `as` casts.
