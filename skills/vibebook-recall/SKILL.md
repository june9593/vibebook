---
name: vibebook-recall
description: Use when the user starts work in a project repo — debugging a bug, designing a new feature, or running into an unfamiliar subsystem — to surface relevant past notes (chronicles / topics / cards) from the user's vibebook session-repo. Call this skill BEFORE you start exploring code, so you can stand on past learnings instead of rediscovering them. Trigger on: "let's look at X", "I'm working on Y", "fix this bug", "add this feature", "research how Z works", or any task in a repo where the user has run `vibebook sync` before. Auto-detects the project from cwd; reads only the catalog (~30 KB) into context, then selectively `Read`s the full md for relevant entries.
---

# /vibebook-recall — read your own notes before doing the work

You (in-session Claude) just landed in a project repo. The user has been
working in this repo (and others) for weeks/months, and `vibebook sync`
has captured every Claude Code + Copilot session into
`~/.vibebook/session-repo/`. The `/vibebook` skill has digested those
sessions into per-project **chronicles** (4-section diaries),
**topics** (mid-grain knowledge pages), and **cards** (atomic
gotchas / patterns / decisions / howtos / tools). There is also a
`_global/cards/` pool for cross-project insights.

**Your job here**: before you start exploring code, fetch this project's
catalog and check whether the user has already documented something
that bears on the current task. Past-you may have already debugged
this exact thing.

## Why this skill exists

Without recall:
- You re-derive an architecture decision the user made 3 months ago
- You re-discover a Mac quirk that's already a card titled
  `gotcha-macos-fullscreen-coord-convert`
- You write fix #4 for a bug whose root cause is in
  `topics/immersive-fullscreen-mac.md`

With recall:
- 30 KB catalog enters your context
- You pattern-match titles + 1-line summaries against the current task
- You `Read` the 1-3 entries that look relevant
- You start work informed

## Step 1 — Fetch the catalog

Run this **first**, in the user's current cwd:

```bash
vibebook recall --cwd "$(pwd)"
```

The output is a JSON payload:

```json
{
  "project": "edge-src",
  "repoPath": "/Users/me/.vibebook/session-repo",
  "entries": [
    {
      "kind": "card",
      "project": "edge-src",
      "title": "Frameless NSWindow corner radius must match the content radius",
      "summary": "Chromium views frameless NSWindow rounded corners must equal the content radius — otherwise the DCHECK fires and you see blue triangle artifacts at the joins...",
      "path": "book/edge-src/cards/gotcha-rounded-corners-must-match.md",
      "slug": "gotcha-rounded-corners-must-match",
      "cardType": "gotcha",
      "updatedAt": "2026-04-25",
      "tags": ["macos", "views"]
    },
    ...
  ],
  "meta": { "chronicles": 53, "topics": 5, "cards": 19 }
}
```

Entries are sorted **cards first, then memex-cards, then topics, then
chronicles**, newest within each kind. That's deliberate — cards are the
most surgical context (one atomic insight you can apply right away),
topics give subsystem context, chronicles are the full diary.

**About memex-card entries.** If `meta.memexQueried === true`, vibebook
detected the optional [memex](https://github.com/iamtouchskyer/memex) CLI
on PATH and folded its catalog in. memex-card entries have `path`
prefixed `memex:<slug>` — to read the body, run `memex read <slug>`
(NOT the `Read` tool with that path). They're project-agnostic by
construction (memex is global, not per-project), but their tags often
encode the category memex assigned them.

## Step 2 — Triage

Skim every entry's `title` + `summary`. Don't load anything yet. Mark
entries as:

- **directly relevant**: the title or summary mentions the file / API /
  bug / feature you're about to touch. → `Read` full md.
- **probably relevant**: same subsystem, related concern. → `Read` if
  ≤ 3 directly-relevant entries, otherwise hold.
- **adjacent / interesting but off-task**: skip for now. The user can
  always ask "what else do you know about X?" later.

**Heuristics:**
- Match against keywords from the user's request (file names, API names,
  symptoms, feature names).
- Tags help: a card tagged `macos` + `views` matches if you're touching
  Mac UI code.
- `_global/` cards are shown alongside project cards; they apply
  everywhere (git tricks, OS quirks, tool configs).
- Topics are **subsystem-scope** — read one if you're touching that
  subsystem broadly, even if no specific card matches.

## Step 3 — Read selectively

Use the `Read` tool with the absolute path: `${repoPath}/${entry.path}`.

E.g.:
```
Read /Users/me/.vibebook/session-repo/book/edge-src/cards/gotcha-rounded-corners-must-match.md
```

Cards are 1-3 paragraphs. Topics are 1-3 KB. Chronicles can be 3-10 KB
(a single chronicle is a full work-session writeup). Read sparingly —
3-5 entries is usually plenty.

## Step 4 — Use what you read

When you reply to the user:
- **Reference the past finding** explicitly: "Per your earlier note in
  `gotcha-rounded-corners-must-match`, …"
- **Don't paraphrase silently** — it should be obvious to the user that
  you're standing on their past work, not re-deriving it.
- **Update on contradiction**: if what you read no longer reflects
  current code, mention it. The user may want to update the card.
- **No card / topic / chronicle covers it?** Say so explicitly: "I
  didn't find anything in your vibebook about X — proceeding fresh."

## When NOT to invoke recall

- The user's request has nothing to do with code in this repo (e.g.
  asking you to format a JSON, write an essay, debug a config).
- The user explicitly says "ignore my notes" or "fresh start".
- `vibebook recall` errors with "no synced sessions for cwd" — the user
  hasn't synced this project. Fall back to normal exploration; don't
  pester them to sync.
- You're being asked the same question for the second time in one
  session — you already loaded the relevant entries the first time.

## Failure modes to avoid

- ❌ **Loading every entry's full md.** That defeats the point. Triage
  first; Read selectively.
- ❌ **Treating recall as a search engine.** It returns the catalog,
  not search hits. Title + summary triage is your job.
- ❌ **Hallucinating "I checked your notes"** when you didn't run the
  CLI. Always run it explicitly so the user can see you did.
- ❌ **Refusing to do the task because old notes contradict it.** Notes
  are dated; code may have moved on. Recall is one input, not a veto.

## Relationship to /vibebook

| | `/vibebook` (write) | `/vibebook-recall` (read) |
|---|---|---|
| When | After you finished a session, run before moving on | At the START of new work |
| Cwd | session-repo (global) or any project (project mode) | Always a project repo |
| Reads | raw_sessions/ | book/ |
| Writes | book/<project>/{chronicle,topics,cards}/ | nothing |
| LLM | in-session Claude (you) | in-session Claude (you) |

The two skills close the loop: `/vibebook` writes notes for future-you;
`/vibebook-recall` lets future-you read them.
