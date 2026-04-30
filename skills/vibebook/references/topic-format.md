# Topic page format

A topic page is the **mid-grain index** for a subsystem. Like a
chronicle, it's read by AI agents far more than by humans, so the
frontmatter is dense; the body is short.

```markdown
---
title: <human-readable subsystem name>
project: <project-slug>
topic: <topic-slug>
created: YYYY-MM-DD       # first write
updated: YYYY-MM-DD       # bump on every update
articles_count: 7         # number of contributing chronicles
last_touched: YYYY-MM-DD  # most-recent contributing chronicle date
contributingThreads: [<threadId>, ...]
keyConcepts: [             # one-word/short-phrase tags an agent can match against
  ImmersiveModeControllerMac,
  IsImmersiveModeEnabled,
  bookmark-bar,
  fullscreen-state-machine
]
relatedCards: [memex:gotcha-immersive-mode-controller-mac-uaf, ...]
---

# <title>

## What this topic is
1 sentence. Subsystem purpose + code root path.

## Key concepts
2-5 short bullets, each ≤2 sentences. Core abstractions, key files,
critical state machines. This is the "what the agent must know to
read the chronicles".

## History (newest first)
- 2026-04-22 [[chronicle/fix-fullscreen-bookmark-bar]] — fixed missed
  telemetry on app switch
- 2026-03-15 [[chronicle/immersive-mode-rewrite]] — V1→V2 rewrite

## Active gotchas
Reference relevant memex cards (or vibebook chronicles if no card exists):
- [[memex:gotcha-immersive-mode-controller-mac-uaf]] — popup destroy order
- [[memex:pattern-msa-aad-pref-helper]]
```

Rules:

- Topic = mid-grain subsystem (`native-ui-fullscreen`, `bookmark-bar`,
  `mojo-ipc`, `crash-debugging-macos`). Not a single bug; not a whole project.
- A thread can touch 0, 1, or many topics.
- **Update preserves history**: when rewriting, every old historical fact
  (prior thread entries, prior "active gotchas") MUST survive into the new
  page. The publish step backs the old page up to `<slug>.md.bak` so you
  can recover if something gets dropped.
- **keyConcepts is the AI search hook**. If an agent is debugging
  `ImmersiveModeControllerMac` and that exact symbol is in keyConcepts,
  the topic shows up. Pick concrete identifiers, not generic words.
- **articles_count + last_touched** are duplicated from
  contributingThreads (count + max date) so AI agents can sort/filter
  topics without loading every chronicle. Keep them in sync.
- Use the same language as the source content for the body. Section
  headings stay in English for cross-project consistency.
- Wikilinks: `[[chronicle/<threadId>]]` (vibebook), `[[memex:<slug>]]`
  (memex card, left as text — agents know to `memex read <slug>`).
