# vibebook — Vibe Coding Memory Book

> Sync your AI coding sessions across machines. Digest them into a
> per-project book of **chronicles**, **topics**, and **cards**. Read the
> book back through a Claude Code skill so future-you doesn't re-discover
> what past-you already wrote down.

vibebook captures every Claude Code + VS Code Copilot Chat session, syncs
them to a private Git repo, and gives you two Claude Code slash commands:

- **`/vibebook`** — write the book. In-session Claude reads new sessions and
  produces three artifact types per project (chronicles / topics / cards).
- **`/vibebook-recall`** — read the book. When you start work in any repo,
  Claude pulls the matching project's catalog (~30 KB of titles + summaries),
  triages what's relevant, and reads the entries that bear on the task.

The CLI never spawns an LLM itself. All writing + recall happens in your
own Claude Code session, where the model has full context and you can
interrupt at any time.

## Why three artifact types

| | grain | example |
|---|---|---|
| **chronicle** | one thread = one piece of work | "Fix Edge fullscreen bookmark bar bug" — 4 sections (What/Why/How/Outcome), preserves commit hashes & code blocks verbatim |
| **topic** | one subsystem | "Edge macOS Menu Bar Copilot" — full-rewritten as new threads land, preserves historical fact |
| **card** | one atomic insight | `gotcha-rounded-corners-must-match` — "next time I do similar work, will I lose this?" If no, don't write it |

Per-project isolation is **enforced**: `edge-src` content lives only in
`book/edge-src/`. `_global/cards/` is the one exception, for cross-project
insights (git tricks, OS quirks, tool configs).

## Install

```sh
npm install -g vibebook
```

The npm package ships:
- `vibebook` CLI (sync, prepare, publish, recall, serve, build-site, …)
- Claude Code plugin (skills + slash commands + Stop hook) under
  `~/.claude/skills/vibebook*` and `~/.claude/commands/vibebook*.md`
  (you symlink or copy these from `node_modules/vibebook/`)

## Setup

```sh
vibebook init
```

The interactive wizard walks through:

| Q | Asks | Default |
|---|---|---|
| 0 | Sync to a remote git repo? (no = local-only mode) | yes |
| 1 | Repo URL | — |
| 2 | Local path | `~/.vibebook/session-repo` ← do not change |
| 3 | Encrypt raw session files? | yes |
| 4 | Passphrase (saved to `~/.vibebook/passphrase`, mode 0600) | — |
| 5 | Summarize sessions into a book? | yes |
| 6 | Enable cross-device CI aggregation? | no |
| 7 | Include assistant `reasoning/thinking` in synced md? | yes |

**Why the path matters.** `/vibebook` and `/vibebook-recall` use cwd-equality
against `~/.vibebook/session-repo` to switch modes — keep the default unless
you have a specific reason not to.

Non-interactive mode (CI-friendly):

```sh
vibebook init git@github.com:you/work-memory.git --encrypt --passphrase 'secret'
```

## Daily flow

```sh
# 1. From any project, capture today's sessions
vibebook sync

# 2a. Open Claude Code in your project, then write up just this project's work
cd ~/code/some-project
claude
> /vibebook

# 2b. Or sweep every project at once (one subagent per pending project)
cd ~/.vibebook/session-repo
claude
> /vibebook

# 3. Whenever you start new work, recall past notes
cd ~/code/some-project
claude
> /vibebook-recall    # or just "let's debug X" — the skill auto-triggers
```

`vibebook sync` does no LLM work. It scans
`~/.claude/projects/` + VS Code Copilot Chat storage, renders each session
to markdown, and pushes to your device branch. Encryption (if enabled) is
transparent — the working tree is always plaintext; only git objects hold
ciphertext.

`/vibebook` auto-detects mode by cwd:
- **Project mode** (cwd ≠ session-repo): digests just the project matching
  cwd. Writes into `book/<project>/{chronicle,topics,cards}/` without
  touching anything else.
- **Global mode** (cwd = session-repo): fans out one subagent per project
  with pending sessions, then regenerates the global catalog.

## A web view of your book

```sh
vibebook serve         # http://localhost:4321 — Astro dev server with hot reload
vibebook build-site    # static dist → ~/.vibebook/session-repo/site-dist/
```

The site is styled after the Anthropic palette in `DESIGN.md` — warm
parchment, serif headlines, no chrome. Pages: home (recent chronicles +
project list), per-project landing, chronicle / topic / card readers, and
a `_global` cards index.

To publish to GitHub Pages on every push to `main`:

```sh
vibebook workflow pages-init    # writes .github/workflows/vibebook-pages.yml
# Then in GitHub: Settings → Pages → Source: GitHub Actions
```

## Cross-device aggregation (optional)

If multiple machines push to the same repo, install the merge workflow:

```sh
vibebook sync                # push first so 'main' has something to merge into
vibebook workflow init       # writes .github/workflows/vibebook-aggregate.yml
                             # + scripts/merge-books.mjs
```

Every push to a non-`main` branch triggers the workflow, which deterministically
merges device branches into `main`:

- **chronicles** deduped by `threadId`; latest `updatedAt` wins
- **topics** preserved per-device as `<slug>.<device>.md` (LLM rewrites
  diverge in voice; mechanical merge would garble both)
- **cards** unioned by `(project, slug)`; collisions resolve to latest
  `updatedAt`. `_global/cards/` unioned unconditionally
- **catalog** — `book/index.md`, `book/_meta/timeline.md`, per-project
  `index.md` regenerated

No GitHub secrets needed — uses the default `GITHUB_TOKEN`.

## CLI reference

| Command | Purpose |
|---|---|
| `vibebook init [repoUrl]` | Interactive wizard or flag-mode setup |
| `vibebook sync` | Extract Claude/Copilot sessions; commit + push to device branch |
| `vibebook prepare [--cwd \| --project]` | Emit JSON: which sessions need digesting (used by `/vibebook`) |
| `vibebook publish --chronicles … --topics … --cards … [--no-catalog]` | Write artifacts + resolve `[[wikilinks]]` + commit + push |
| `vibebook list-projects` | Per-project session + artifact counts (used by global-mode `/vibebook`) |
| `vibebook recall [--cwd \| --project \| --all]` | Lightweight catalog of book artifacts (used by `/vibebook-recall`) |
| `vibebook catalog-regen` | Regenerate `book/index.md` + `_meta/timeline.md` + per-project indexes |
| `vibebook serve` | Local dev server for the site |
| `vibebook build-site [--base \| --site-url]` | Build static site to `<repoPath>/site-dist/` |
| `vibebook list [--tool \| --project]` | List synced sessions |
| `vibebook show <ref>` | Print one session as markdown |
| `vibebook cat <path>` | Print a repo file (auto-decrypts `.enc`) |
| `vibebook crypt {init\|status\|clean\|smudge}` | Manage the git encryption filter |
| `vibebook workflow init` | Install cross-device aggregate CI |
| `vibebook workflow pages-init` | Install GitHub Pages publish CI |

## Repo layout

```
~/.vibebook/session-repo/
  raw_sessions/<tool>/<project>/<YYYY-MM-DD>/<slug>__<shortId>.{raw.json,md}
  .vibebook/
    index.json              # raw-session catalog (per-device)
    index.book.json         # book index v2: chronicles, topics, cards
    repo-salt.json          # crypto material (only when --encrypt)
  book/
    <project>/
      chronicle/<YYYY-MM-DD>__<threadId>__<short>.md
      topics/<slug>.md      # or <slug>.<device>.md after CI merge
      cards/<slug>.md
      index.md
    _global/cards/<slug>.md # cross-project insights
    _meta/timeline.md
    index.md
  site-dist/                # `vibebook build-site` output (gitignored or pushed for Pages)
```

## Encryption

vibebook wires a **git clean/smudge filter** when you enable encryption. The
working tree is always plaintext; only git objects (and therefore the remote)
hold ciphertext.

- `vibebook sync` writes plaintext → `git add` runs the clean filter → blob
  in `.git/objects` is encrypted → push uploads ciphertext.
- `git clone` / `git pull` downloads ciphertext → smudge filter runs on
  checkout → working tree shows plaintext.
- The skills, your editor, and `cat` all see plaintext directly. No `.md.enc`
  files anywhere in the working tree.

Wiring is automatic on `vibebook init` and idempotently re-applied by every
`vibebook sync`. Manual wiring (fresh clone):

```sh
vibebook crypt init      # wires clean/smudge in .git/config + commits .gitattributes
vibebook crypt status    # check whether filter is wired in this clone
```

The IV is **deterministic** (`HMAC-SHA256(key, plaintext)[:12]`) so identical
plaintext yields identical ciphertext — required to keep `git diff` clean
when nothing changed. Trade-off: an attacker with a candidate plaintext can
confirm the guess. Acceptable for AI conversation transcripts in a private
repo; not acceptable for high-value secrets.

## Per-device branches

Each machine pushes to its own branch named after `os.hostname()`
(sanitized). `main` is empty until the aggregate workflow merges devices in.

Override the auto-derived name:

```sh
vibebook init <repoUrl> --device mbp2
```

## Inspirations

vibebook synthesizes ideas from three sibling projects (with
permission/credit):

- **logex** — prepare/publish CLI split, idempotent upserts, skill-driven
  workflow, Stop hook for "💡 you should run /vibebook" nudges
- **edge-dev** (Microsoft Edge knowledge base) — YAML frontmatter
  conventions, "index is a curated catalog, not a TOC", Related Pages
  backlink culture, no-dead-ends rule
- **memex** — atomic card prompt rules: atomic / non-obvious / Feynman
  own-words / Fact Hygiene Check (WHO / WHAT-WHEN / RELATIONSHIP)

## License

MIT
