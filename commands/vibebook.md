---
description: Digest synced sessions into chronicle / topics / cards (per-project)
---

Invoke the **vibebook** skill via the `Skill` tool with `skill: "vibebook"`.

The skill walks you through:
1. Run `vibebook prepare` to discover unprocessed sessions.
2. Segment sessions into threads (one chronicle per thread).
3. Write per-project chronicles + topic pages + atomic cards (memex-style).
4. Run `vibebook publish` to commit + push.

Per-project isolation is a hard rule — the exception is `book/_global/cards/`
for cross-project insights (git, shell, OS, generic patterns).
