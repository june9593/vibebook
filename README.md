# vibebook — Vibe Coding Memory Book

> Sync your AI coding sessions across machines. Digest them into a
> per-project book of **chronicles** and **topics**. Read the book back
> through a Claude Code skill so future-you (and future AI agents)
> don't re-discover what past-you already wrote down.

vibebook captures every Claude Code + VS Code Copilot Chat session, syncs
them to a private Git repo, and gives you two Claude Code slash commands:

- **`/vibebook`** — write the book. In-session Claude reads new sessions and
  produces two artifact types per project (chronicles + topics).
- **`/vibebook-recall`** — read the book. When you start work in any repo,
  Claude does **three-stage progressive recall**: a project's topic list
  first (~5 KB), then drill into the relevant topic for chronicle frontmatter,
  then `Read` the full body of the chronicles that match.

The CLI never spawns an LLM itself. All writing + recall happens in your
own Claude Code session, where the model has full context and you can
interrupt at any time.

For atomic Zettelkasten cards, vibebook **delegates to
[memex](https://github.com/iamtouchskyer/memex)** when it's installed.
See "Memex hand-off" below.

## Two artifact types

| | grain | example |
|---|---|---|
| **chronicle** | one thread = one piece of work | "Fix Edge fullscreen bookmark bar bug" — AI-first frontmatter (files_touched / commits / decisions / blockers / status) + a short 4-section body |
| **topic** | one subsystem | "Edge macOS Menu Bar Copilot" — full-rewritten as new threads land, preserves historical fact, indexes contributing chronicles |

Per-project isolation is **enforced**: `edge-src` content lives only in
`book/edge-src/`. (Cross-project atomic insights belong in memex, not
vibebook — see Memex hand-off.)

## Install

vibebook ships in two pieces — both required:

**1. The CLI** (handles sync, prepare, publish, recall, site, …):

```sh
npm install -g vibebook
```

**2. The Claude Code plugin** (registers `/vibebook` and `/vibebook-recall`
skills + slash commands + Stop hook). Run these inside Claude Code's REPL,
once per machine:

```
/plugin marketplace add june9593/vibebook
/plugin install vibebook@vibebook
```

Without step 2 the slash commands won't appear in Claude Code — `vibebook init`
prints a reminder of these two lines at the end of the wizard.

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
  cwd. Writes into `book/<project>/{chronicle,topics}/` without touching
  anything else.
- **Global mode** (cwd = session-repo): fans out one subagent per project
  with pending sessions, then regenerates the global catalog.

## A web view of your book

```sh
vibebook serve         # http://localhost:4321 — Astro dev server with hot reload
vibebook build-site    # static dist → ~/.vibebook/session-repo/site-dist/
```

The site is styled after the Anthropic palette in `DESIGN.md` — warm
parchment, serif headlines, no chrome. Pages: home (recent chronicles +
project list), per-project landing, chronicle reader, topic reader.
(No card pages — cards live in memex; see Memex hand-off.)

To publish to GitHub Pages on every push to `main`:

```sh
vibebook workflow pages-init    # writes .github/workflows/vibebook-pages.yml
# Then in GitHub: Settings → Pages → Source: GitHub Actions
```

## Memex hand-off

vibebook covers chronicle + topic; for atomic Zettelkasten-style cards
(one insight per card, with backlinks, organize, orphan detection), it
**delegates to [memex](https://github.com/iamtouchskyer/memex)**.

When you install memex:

```sh
npm install -g @touchskyer/memex
# In Claude Code REPL:
/plugin marketplace add iamtouchskyer/memex
/plugin install memex@memex
```

then:

- `/vibebook` asks once at the start of every run: "after I finish, also
  kick off /memex-retro?" — if you say yes, vibebook chains into the
  memex skill at the end of project mode (P8) or global mode (G4).
- `/vibebook-recall` folds memex's catalog (`memex read index`) into its
  stage-1 result, so an in-session Claude sees both layers in one
  triage pass. Memex card entries appear with `path: "memex:<slug>"`;
  the agent calls `memex read <slug>` to fetch the body.

memex isn't required. vibebook works fine without it; you just won't
have an atomic-card layer.

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
- **catalog** — `book/index.md`, `book/_meta/timeline.md`, per-project
  `index.md` regenerated

(Legacy `cards/` directories from pre-0.4 vibebook runs are unioned by
`(project, slug)` for backward compat, but new vibebook runs no longer
generate cards — that workflow is now memex's.)

No GitHub secrets needed — uses the default `GITHUB_TOKEN`.

### Why no CI digest?

vibebook used to support summarizing sessions inside GitHub Actions
(`vibebook digest` running `claude -p` in the workflow). We **removed
that path** in v0.2 because of two compounding limits:

- GitHub-hosted runners have an 8 KB / 4 KB token cap on the free tier
  for hosted models, far below the 50–200 KB a typical session needs.
- Self-hosting a runner with a real LLM key just to write three files
  per push is the wrong amount of effort for the wrong audience.

The CI lane that survived is **mechanical** only: `vibebook workflow
init` installs a cross-device merge job that deterministically combines
each machine's `book/` into `main` — no LLM in CI, no API keys, no rate
limits.

If you want summarization, run `vibebook sync` then `/vibebook` in your
local Claude Code session — that's where context, interrupt-ability, and
quality all live. If you really want to summarize in CI, write your own
`.github/workflows/*.yml` that calls `vibebook prepare`, pipes the
output to your LLM of choice, then calls `vibebook publish` with the
result. We're happy to keep the I/O surface stable for that use case;
we just don't ship the LLM glue ourselves.

## CLI reference

| Command | Purpose |
|---|---|
| `vibebook init [repoUrl]` | Interactive wizard or flag-mode setup |
| `vibebook sync` | Extract Claude/Copilot sessions; commit + push to device branch |
| `vibebook prepare [--cwd \| --project]` | Emit JSON: which sessions need digesting (used by `/vibebook`) |
| `vibebook publish --chronicles … --topics … [--no-catalog]` | Write artifacts + resolve `[[wikilinks]]` + commit + push. (`--cards` accepted for back-compat with vibebook ≤ 0.3 skill versions; deprecated.) |
| `vibebook list-projects` | Per-project session + artifact counts (used by global-mode `/vibebook`) |
| `vibebook recall [--cwd \| --project] [--topic <slug>] [--all] [--no-memex]` | Three-stage catalog (used by `/vibebook-recall`). Default: project's topic list + 1-line summaries. `--topic <slug>`: chronicles for that topic with frontmatter. |
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
    index.book.json         # book index v2: chronicles + topics
    repo-salt.json          # crypto material (only when --encrypt)
  book/
    <project>/
      chronicle/<YYYY-MM-DD>__<threadId>__<short>.md
      topics/<slug>.md      # or <slug>.<device>.md after CI merge
      index.md
    _meta/timeline.md
    index.md
  site-dist/                # `vibebook build-site` output (gitignored or pushed for Pages)
```

(Pre-0.4 repos may also have `book/<project>/cards/` and
`book/_global/cards/` from the time vibebook still wrote cards. They're
read-only now; new chronicles + topics keep getting added but no new
cards are created. Atomic cards have moved to memex.)

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
- **[memex](https://github.com/iamtouchskyer/memex)** — atomic card prompt
  rules (atomic / non-obvious / Feynman own-words / Fact Hygiene Check),
  proactive Stop-hook reminders for retro-after-task. **vibebook
  optionally integrates with memex**: install
  `npm install -g @touchskyer/memex` and add the memex Claude Code plugin,
  and `vibebook recall` will fold memex's catalog into its own. Use
  `/memex-retro` for atomic cards instead of vibebook's built-in card
  path — it has richer Zettelkasten support (backlinks, organize,
  archive). vibebook still owns sync, chronicle, topic, and the per-project
  scoping.

## License

MIT
