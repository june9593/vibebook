---
name: vibebook-recall
description: Three-stage progressive recall of past notes from the user's vibebook session-repo. Use this EVEN when you can grep the codebase — past chronicles capture decisions, dead ends, trade-offs, and "why we picked X over Y" that grep can never surface. Especially trigger on design/research/architecture questions ("what pattern should I use for X", "how have we approached Y before", "what did we decide about Z", "is there prior art for W"), retrospective questions ("why does X work this way", "what bug did we hit last time we touched Y"), and any new-feature scoping where past-you may have already explored the same space. Stage 1 reads only the project's topic list (~5 KB). Stage 2 drills into one topic for chronicle frontmatter. Stage 3 reads the full bodies of the chronicles that match. Cheap to invoke (one CLI call, ~5 KB) — when in doubt, run stage 1; if no topic matches the task, drop it and proceed. When the optional memex CLI is on PATH, atomic-card entries fold in automatically.
---

# /vibebook-recall — read your own notes before doing the work

You (in-session Claude) just landed in a project repo. The user has been
working in this repo (and others) for weeks/months, and `vibebook sync`
has captured every Claude Code + Copilot session into
`~/.vibebook/session-repo/`. The `/vibebook` skill has digested those
sessions into per-project **chronicles** (one per work thread,
4-section AI-first body) and **topics** (one per subsystem). When
[memex](https://github.com/iamtouchskyer/memex) is installed, atomic
**cards** also exist — vibebook surfaces them too in the recall payload.

**Your job here**: before you start exploring code, figure out which
past topic(s) bear on the current task, then read the matching
chronicles. Past-you may have already debugged exactly this thing.

## Why three-stage recall

A typical project has 5-15 topics and 30-150 chronicles. Loading all
chronicle bodies = hundreds of KB and crowds out room for the actual
work. So we walk from coarse to fine:

| Stage | Payload | Question it answers |
|---|---|---|
| 1 (default) | ~5 KB — topics + 1-line summaries | "Which subsystem does my task touch?" |
| 2 (`--topic <slug>`) | ~5-15 KB — chronicles in that topic + frontmatter (no body) | "Within this subsystem, which past work is most similar?" |
| 3 (`Read` tool) | full body, ~2-5 KB per chronicle | "What did past-me actually do here?" |

## Step 1 — Stage 1: topic list

Run this **first**, in the user's current cwd:

```bash
vibebook recall --cwd "$(pwd)"
```

The output is a JSON payload like:

```json
{
  "stage": "stage-1-topics",
  "project": "edge-src",
  "repoPath": "/Users/me/.vibebook/session-repo",
  "entries": [
    {
      "kind": "topic",
      "project": "edge-src",
      "title": "Edge macOS Menu Bar Copilot",
      "summary": "Edge for Mac places a Copilot icon in the menu bar; left-click opens a floating widget, right-click opens a context menu.",
      "path": "book/edge-src/topics/menu-bar-copilot-mac.md",
      "slug": "menu-bar-copilot-mac",
      "updatedAt": "2026-04-22",
      "tags": []
    },
    {
      "kind": "memex-card",
      "project": "_memex",
      "title": "Frameless NSWindow corner radius must match content radius",
      "summary": "Chromium views frameless NSWindow rounded corners must equal the content radius — DCHECK fires otherwise.",
      "path": "memex:gotcha-rounded-corners-must-match",
      "slug": "gotcha-rounded-corners-must-match",
      "updatedAt": "2026-04-25",
      "tags": ["macos", "views"]
    }
  ],
  "meta": {
    "topics": 5,
    "chronicles": 0,
    "memexQueried": true,
    "memexCards": 12,
    "nextStep": "Pick a relevant topic, then run: vibebook recall --project <slug> --topic <topicSlug>"
  }
}
```

Stage 1 includes:
- **`kind: "topic"`** — vibebook topics for the current project. Read
  `summary` to gauge subsystem fit.
- **`kind: "memex-card"`** (optional) — when `meta.memexQueried === true`,
  vibebook found memex on PATH and folded its index in. memex-card
  entries have `path: "memex:<slug>"` — to read the body, run
  `memex read <slug>` (NOT the `Read` tool).

## Step 2 — Triage topics

For each topic in stage 1, ask: does the title or summary mention what
I'm about to touch (file / API / bug / feature)? Pick the **1-2 most
likely** topics. Don't try to read everything — most projects have
many topics, but only a few will be relevant to a given task.

If a memex card title matches the task even more directly than any
topic (gotcha for the exact API you're touching, e.g.), `memex read`
it now — those are atomic and quick.

## Step 3 — Stage 2: chronicles for the chosen topic

For each picked topic, fetch its chronicles:

```bash
vibebook recall --cwd "$(pwd)" --topic <topic-slug>
```

Output:

```json
{
  "stage": "stage-2-articles",
  "project": "edge-src",
  "topic": "menu-bar-copilot-mac",
  "repoPath": "/Users/me/.vibebook/session-repo",
  "entries": [
    {
      "kind": "chronicle",
      "project": "edge-src",
      "title": "Native header + 3 PR landing",
      "summary": "status=shipped · 4 files · 3 commits · 2 decisions",
      "path": "/Users/me/.vibebook/session-repo/book/edge-src/chronicle/2026-04-25__menu-bar-app-native-header__menu-bar.md",
      "slug": "menu-bar-app-native-header",
      "frontmatter": {
        "files_touched": [
          "chrome/browser/ui/cocoa/edge_menu_bar/edge_menu_bar_widget_header_view.mm",
          "chrome/browser/ui/cocoa/edge_menu_bar/edge_menu_bar_prefs.cc"
        ],
        "commits": ["7bc9ef48b654", "abcd1234ef56"],
        "decisions": ["Native C++ header over server-side header (audit blocker)"],
        "status": "shipped"
      },
      "updatedAt": "2026-04-25",
      "tags": ["copilot", "macos"]
    }
  ],
  "meta": { "chronicles": 7, "memexQueried": true, ... }
}
```

The frontmatter tells you 80% of what you need *without* reading the body:
- `files_touched` matches the file you're about to edit?
- `commits` includes a SHA you're about to revert / cherry-pick?
- `decisions` already made the architectural call you were about to debate?
- `status: blocked` means past-you tried this and got stuck — read the
  body to see why before retrying.

## Step 4 — Stage 3: read selectively

For chronicles whose frontmatter looks relevant, use the `Read` tool with
the absolute `path`:

```
Read /Users/me/.vibebook/session-repo/book/edge-src/chronicle/2026-04-25__menu-bar-app-native-header__menu-bar.md
```

Chronicles are short (1-3 sentences per section, the body is the receipt
for the frontmatter). 3-5 reads is usually plenty.

For memex cards, run `memex read <slug>` instead.

## Step 5 — Use what you read

When you reply to the user:
- **Reference the past finding explicitly**: "Per your earlier
  chronicle `menu-bar-app-native-header`, you decided native C++ header
  over the server-side approach because of an audit blocker — let me
  follow the same pattern…"
- **Don't paraphrase silently** — it should be obvious to the user that
  you're standing on past work, not re-deriving it.
- **Update on contradiction**: if what you read no longer reflects
  current code, mention it. The user may want to update the chronicle.
- **No relevant chronicle / topic / card?** Say so explicitly: "I
  didn't find anything in your vibebook about X — proceeding fresh."

## When NOT to invoke recall

- The user's request has nothing to do with code in this repo (e.g.
  asking you to format JSON, write an essay, debug a config).
- The user explicitly says "ignore my notes" or "fresh start".
- `vibebook recall` errors with "no synced sessions for cwd" — the user
  hasn't synced this project. Fall back to normal exploration; don't
  pester them to sync.
- You're being asked the same question for the second time in one
  session — you already loaded the relevant entries the first time.

## Failure modes to avoid

- ❌ **Skipping stage 1 and reading a chronicle directly** — without
  the topic list you don't know which chronicles to even ask for.
- ❌ **Reading every chronicle in a topic** — stage 2 is the triage
  layer; only `Read` the 1-3 chronicles whose frontmatter actually
  matches. Reading 7 chronicles to find the 1 useful one wastes
  context.
- ❌ **Treating recall as search** — the catalog is hierarchical
  (topic → chronicle), not keyword-indexed. Match against
  `keyConcepts` in topic frontmatter and `files_touched` in chronicle
  frontmatter.
- ❌ **Hallucinating "I checked your notes"** when you didn't run the
  CLI. Always run it explicitly so the user can see you did.
- ❌ **Refusing to do the task because old notes contradict it.** Notes
  are dated; code may have moved on. Recall is one input, not a veto.

## Relationship to /vibebook and memex

| | `/vibebook` (write) | `/vibebook-recall` (read) | memex (atomic) |
|---|---|---|---|
| When | After a session, run before moving on | At the START of new work | Whenever an atomic insight comes up |
| Cwd | session-repo (global) or project (project mode) | Always a project repo | Anywhere |
| Reads | raw_sessions/ | book/ (+ memex if installed) | ~/.memex/cards/ |
| Writes | book/<project>/{chronicle,topics}/ | nothing | ~/.memex/cards/ |
| LLM | in-session Claude (you) | in-session Claude (you) | in-session Claude via /memex-retro |

The three skills close the loop:
- `/vibebook` writes notes for future-you (chronicle + topic).
- `/memex-retro` writes atomic cards for future-you (when memex is installed).
- `/vibebook-recall` lets future-you read all of the above in one pass.
