# vibebook — contributor / AI-agent guide

> If you're an AI agent working in this repo (Claude Code, Codex, Copilot,
> etc.), read this once at the start of any non-trivial task. If you're
> a human contributor, this is the short version of the README's "how
> things are organized".

## What this project is

vibebook = npm CLI + Claude Code plugin for syncing AI coding sessions
across machines and digesting them into per-project chronicle + topic
books. Detailed user-facing docs are in `README.md`. This file is
about contributing.

**Active version**: v0.4.0 (chronicle + topic only; cards delegated to
memex). Always check `package.json` for the current number — never
hard-code a version in code or in chat.

## Architecture sketch

```
src/
  cli.ts                     # commander setup; thin command registry
  commands/                  # one file per CLI subcommand
    init-wizard.ts           # interactive wizard (also writes Claude plugin)
    sync.ts                  # extract sessions → push raw md
    prepare.ts               # emit JSON for /vibebook skill
    publish.ts               # write chronicle/topic md, commit, push
    recall.ts                # 3-stage progressive catalog
    list-projects.ts         # per-project session counts
    catalog-regen.ts         # rebuild book/index.md after global sweep
    site.ts                  # vibebook serve / build-site (Astro wrapper)
    plugin-install.ts        # auto-install plugin into ~/.claude
    workflow.ts              # CI workflow installers
    crypt.ts                 # git clean/smudge filter setup
    cat.ts, list.ts, show.ts # read-side CLI
  digest/
    book-index-v2.ts         # BookIndex schema (chronicle + topic + legacy cards field)
    book-catalog.ts          # generates book/index.md and friends
    wikilinks.ts             # [[chronicle/threadId]] → relative md links
    session-signal.ts        # insightScore + isVibebookMetaSession
    project-filter.ts        # isRealProjectPath
  sources/
    claude-code.ts           # parses ~/.claude/projects jsonl
    vscode-copilot.ts        # parses VS Code Copilot Chat storage
  writer.ts, crypto.ts, git-ops.ts, ...

skills/
  vibebook/SKILL.md          # /vibebook write skill (P0–P8 + G0–G4)
  vibebook/references/       # chronicle-format.md, topic-format.md
  vibebook-recall/SKILL.md   # /vibebook-recall 3-stage read skill

commands/
  vibebook.md                # slash command thin wrapper
  vibebook-recall.md

site-template/               # Astro source for `vibebook serve`/`build-site`
assets/
  workflows/                 # vibebook-aggregate.yml, vibebook-pages.yml
  scripts/merge-books.mjs    # CI cross-device merge logic
.claude-plugin/
  plugin.json
  marketplace.json
hooks/                       # Stop hook (prints "💡 run vibebook sync ...")
```

## Hard rules

1. **vibebook does not write atomic cards.** Cards belong to memex.
   `src/commands/publish.ts` accepts `--cards` only for backward compat
   with old skill versions and prints a deprecation warning. Never add
   new code paths that generate cards.

2. **Chronicle frontmatter is AI-first**. Required fields:
   `files_touched`, `commits`, `decisions`, `blockers`, `next_steps`,
   `status`. Body is short (1-3 sentences per `## What/Why/How/Outcome`
   section). Spec: `skills/vibebook/references/chronicle-format.md`.

3. **`vibebook recall` is 3-stage**. Default = topic-only; `--topic
   <slug>` = chronicles for that topic; agent uses `Read` tool for
   bodies. Don't dump every chronicle into the catalog — that defeats
   the purpose.

4. **Per-project isolation is enforced by `publish.ts` fail-fast**.
   Chronicle/topic JSON missing `project` field → throws
   `chronicle.project is required`. Don't relax this; it's the only
   thing preventing legacy "undefined cards" silent-write bugs.

5. **CLI never spawns an LLM.** All writing/recall is in-session via
   skills. The CLI only does I/O (file system, git, Astro). Anything
   that smells like "vibebook should call Claude" is wrong.

## Versioning + publish workflow

After any meaningful code/skill change:

```sh
npm run build && npx vitest run        # gate on green
npm version patch|minor --no-git-tag-version
git add -A && git commit -m "..."
git tag -a vX.Y.Z -m "..."
git push origin main && git push origin vX.Y.Z
```

**Then stop.** `npm publish` is a manual step Yue runs himself (OTP
gate). Don't suggest "now do `npm publish`" — just say the tag is
ready.

Bump rules:
- Bug fix or doc-only → patch (0.4.0 → 0.4.1)
- New feature, schema-compatible → minor (0.4.x → 0.5.0)
- Breaking schema change → minor too (we're pre-1.0; don't bump major
  until 1.0 is intentional)

## Testing

- Vitest, 200+ tests. `npx vitest run` for the full suite.
- Tests use `mkdtempSync` + `vi.stubEnv("HOME", ...)` to sandbox file
  system + config; no test should touch real `~/.claude` or
  `~/.vibebook`.
- For tests that involve git, build a fixture local repo with `git
  init` (not network). The plugin-install test uses
  `VIBEBOOK_PLUGIN_REPO_URL_OVERRIDE` env to point at a local path
  instead of github.com.

## Gotchas (read before doing the thing)

- `npm run build` must `rm -rf dist` first (we set this up after a
  v0.2.0 publish accidentally shipped 21 stale files from before the
  v0.1 → v0.2 deletion). Don't remove the `clean` script.
- `dist/` is `.gitignore`'d but in `npm pack`; don't add it to `.npmignore`.
- `site-template/node_modules` is huge; `.npmignore` excludes it. Don't
  remove that line.
- Don't add `docs/` back to git — it was untracked on 2026-04-29 to
  open-source the repo. Local working copy is fine; just never `git
  add docs/`.
- The Claude Code plugin ships from `.claude-plugin/marketplace.json`
  with `source: "./"` (whole repo = the plugin). When bumping vibebook
  npm version, also bump `.claude-plugin/{plugin,marketplace}.json`
  versions to match.

## Where to find more

- Public docs: `README.md` (rendered at https://github.com/june9593/vibebook)
- Skill specs: `skills/vibebook/SKILL.md` + references
- Inspirations + integration with memex: README "Inspirations" + "Memex
  hand-off" sections.
- License: MIT.
