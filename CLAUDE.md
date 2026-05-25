# vibebook — contributor / AI-agent guide

> If you're an AI agent working in this repo (Claude Code, Codex, Copilot,
> etc.), read this once at the start of any non-trivial task. If you're
> a human contributor, this is the short version of the README's "how
> things are organized".

## What this project is

**vibebook (npm)** = the **sync + resume + aggregate** half of a two-package
system. Cross-device transport for Claude Code + VS Code Copilot Chat
sessions, plus the read-side commands (`resume`, `list-sessions`, `show`).
No LLM calls — pure I/O.

The **digest + recall** half lives in the separate
`june9593/vibebook-plugin` repo (`~/edge/vibebook-plugin/`), installed
into Claude Code via `/plugin install vibebook`. That's where chronicles,
topics, the /vibebook write skill, the /vibebook-recall read skill, and
the Astro book site template live.

**Active version**: check `package.json`. Never hard-code a version in
code or chat.

## Architecture sketch

```
src/
  cli.ts                     # commander setup; thin command registry
  commands/
    init.ts, init-wizard.ts  # interactive + non-interactive init
    sync.ts                  # extract sessions → write md → push + overlay (P7)
    upgrade.ts               # `vibebook upgrade` = npm install -g vibebook@latest
    doctor.ts                # health check
    workflow.ts              # CI aggregate workflow installer (writes to main)
    crypt.ts                 # git clean/smudge filter setup
    prune.ts                 # delete orphan raw_sessions md (0.7.1+)
    cat.ts, list.ts, show.ts # read-side CLI
    resume/
      list-sessions.ts       # lists own + aggregated sessions (P7)
      resume.ts              # context-as-prompt resume; chunked when manifest_version:1
      render-prompt.ts       # builds the claude argv (full embed vs chunked)
      fuzzy-match.ts
      config-pathmap.ts      # per-device cwd remapping
  digest/
    manifest.ts              # 0.7.0 — extracts commits / files_touched / tools_used
    toc.ts                   # 0.7.0 — importance-based table-of-contents builder
  sources/
    claude-code.ts           # ~/.claude/projects/<...>/<id>.jsonl extractor
    vscode-copilot.ts        # VS Code workspaceStorage extractor (chatSessions/+transcripts/ deduped)
    base.ts                  # SourceAdapter interface
  writer.ts                  # 0.7.0 two-pass renderer: frontmatter + manifest + TOC + body
  aggregated-store.ts        # 0.8.0 — git-worktree-based read-only main overlay (P7)
  crypto.ts, git-ops.ts, config.ts, index-store.ts, types.ts, ...

assets/
  workflows/vibebook-aggregate.yml   # template; `vibebook workflow init` writes it to main
  scripts/merge-books.mjs            # CI aggregator — unions book/ + raw_sessions/ from device branches

site-template/                       # Astro source for `vibebook build-site` (kept for parity)
marketing-site/                      # project landing page (live at Pages)
```

## Hard rules

1. **CLI never spawns an LLM.** All writing/digest/recall is in-session via
   the **plugin's** skills. This npm package only does I/O (file system,
   git, network). If you find yourself wanting to call Claude from here,
   stop — that work belongs in the plugin.

2. **Spool format is single `.md` per session** (since 0.6.0). Frontmatter
   carries `manifest_version: 1` + `user_turns` / `assistant_turns` /
   `tools_used` / `commits` / `files_touched` / `candidate_decisions`,
   followed by a `# Table of Contents` block with `→L<line>` jump offsets,
   then the body. **Never write `.raw.json` or `.jsonl` siblings** — both
   were dropped in 0.6.0; resume reads the `.md` directly.

3. **Two extractors, one rule each:**
   - Claude: filter `isMeta=true` (skill body injections — 0.6.3); use
     content blocks (text / thinking / tool_use / tool_result).
   - Copilot: walk `chatSessions/<id>.jsonl` as a **rolling-window state
     log** (NOT a transcript) — append `kind=2 k=["requests"]` snapshot
     elements to a growing `turns[]` (0.6.2); dedupe vs
     `transcripts/<id>.jsonl` per workspace, chatSessions wins (0.7.1);
     skip empty-shell sessions (`messages.length === 0`, 0.7.1).

4. **Per-clone read-only overlay** (0.8.0, `src/aggregated-store.ts`):
   sync refreshes a second git worktree at `~/.vibebook/aggregated/`
   tracking `origin/main`. Shares `.git` with `~/.vibebook/session-repo/`
   so the smudge filter is inherited. `list-sessions` and `resume` read
   both indices; own wins on collision. **Don't try to commit anything
   to that worktree** — it's CI's territory (merge-books.mjs writes it
   on main).

5. **CI aggregation lives on main** (0.5.3 fix). `vibebook workflow init`
   installs `vibebook-aggregate.yml` + `merge-books.mjs` to the **main**
   branch, not the device branch. Workflow triggers on push to any
   non-main branch and runs `merge-books.mjs` which: (a) merges device
   branches' `book/` (dedup chronicles by threadId, per-device topic
   forks, union cards), and (b) aggregates raw_sessions/ + writes
   `.vibebook/index.aggregated.json` (P7, 0.8.0). Don't add scripts/
   to device branches.

## Versioning + publish workflow

After any meaningful code change:

```sh
npm run build && npx vitest run        # gate on green
npm version patch|minor --no-git-tag-version
git add -A && git commit -m "..."
git tag -a vX.Y.Z -m "..."
git push origin <branch> && git push origin vX.Y.Z   # PR if not on main
```

There is **no `.claude-plugin/` directory** in this repo anymore (moved to
vibebook-plugin since the 0.5 slim split) and **no `scripts/sync-plugin-version.mjs`**.
Just bump `package.json` and tag. No manifests to mirror.

**Then stop.** `npm publish` is a manual step Yue runs himself (OTP
gate). Don't suggest "now do `npm publish`" — just say the tag is
ready.

Bump rules:
- Bug fix or doc-only → patch
- New feature, schema-compatible → minor
- Breaking schema change → minor too (pre-1.0; don't bump major until 1.0 is intentional)

## Testing

- Vitest, 230+ tests (count climbs with each feature; `npx vitest run` for
  the actual current count). Add tests for every behavioral change.
- Tests use `mkdtempSync` + `vi.stubEnv("HOME", ...)` to sandbox file
  system + config; no test should touch real `~/.claude` or `~/.vibebook`.
- For tests that involve git, build a fixture local repo with `git init`
  (not network).
- Source-adapter tests live in `tests/sources/` with fixtures under
  `tests/fixtures/{claude,copilot}/`. Keep them separated — both
  adapters' `discover()` walks recursively and will cross-contaminate if
  fixtures share a parent dir.

## Gotchas (read before doing the thing)

- `npm run build` must `rm -rf dist` first (we set this up after a 0.2.0
  publish accidentally shipped 21 stale files). Don't remove the `clean`
  script.
- `dist/` is `.gitignore`'d but in `npm pack`; don't add it to `.npmignore`.
- `site-template/node_modules` is huge; `.npmignore` excludes it. Don't
  remove that line.
- Don't add `docs/` back to git — it was untracked on 2026-04-29 to
  open-source the repo. `docs/superpowers/roadmap.md` is Yue's local
  working notes; never `git add docs/`.
- **Multiple vibebook installs gotcha**: a user can have `vibebook` on
  PATH from both Homebrew's npm prefix (`/opt/homebrew/bin/vibebook`)
  AND nvm's npm prefix simultaneously. `which vibebook` resolves by
  PATH order, so `vibebook upgrade` might install 0.X to one prefix
  while the user's shell keeps resolving the old version from the
  other. When debugging "user says they ran 0.X but the symptoms say
  0.Y", check both prefixes and `which vibebook` in the user's actual
  shell.

## Where to find more

- Public docs: `README.md` (rendered on github.com/june9593/vibebook)
- Plugin docs: `~/edge/vibebook-plugin/README.md` + its `skills/vibebook/SKILL.md`
- Yue's working roadmap: `docs/superpowers/roadmap.md` (gitignored;
  audit it periodically — most "open" items there have actually
  shipped, the roadmap just lags behind)
- Design specs: `docs/superpowers/specs/` (also gitignored)
- License: MIT.
