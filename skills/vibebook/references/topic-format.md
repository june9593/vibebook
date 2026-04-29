# Topic page format

```markdown
---
title: <human-readable subsystem name>
project: <project-slug>
topic: <topic-slug>
created: YYYY-MM-DD       # first write
updated: YYYY-MM-DD       # bump on every update
contributingThreads: [<threadId>, ...]
relatedCards: [cards/<slug>.md, ...]
---

# <title>

## What this topic is
<one paragraph overview; subsystem purpose, code root>

## Key concepts
<core concepts, files, abstractions. e.g. responsibilities of
ImmersiveModeControllerMac, relationship to Chromium upstream, key
enums / state machines>

## History (newest first)
- 2026-04-22 [[chronicle/fix-fullscreen-bookmark-bar]] — fixed missed
  telemetry on app switch by listening for widget activation
- 2026-03-15 [[chronicle/immersive-mode-rewrite]] — V1→V2 rewrite,
  introduced the IsImmersiveModeEnabled state machine

## Active gotchas
- [[cards/gotcha-immersive-mode-controller-mac-uaf]] — popup destroy order
- [[cards/pattern-msa-aad-pref-helper]] — MSA / AAD pref adaptation pattern

## Related
- [[chronicle/...]]
- [[cards/...]]
```

Rules:

- Topic = mid-grain subsystem (`native-ui-fullscreen`, `bookmark-bar`,
  `mojo-ipc`, `crash-debugging-macos`). Not a single bug; not a whole project.
- A thread can touch 0, 1, or many topics.
- **Update preserves history**: when rewriting, every old historical fact
  (prior thread entries, prior "active gotchas") MUST survive into the new
  page. The publish step backs the old page up to `<slug>.md.bak` so you
  can recover if something gets dropped.
- Use the same language as the source content for the body. Section
  headings stay in this template's language for cross-project consistency.
- Wikilinks: `[[chronicle/<threadId>]]`, `[[<cardSlug>]]`.
