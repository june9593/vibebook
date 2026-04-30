---
description: Digest synced sessions into chronicles + topics (per-project). Atomic cards delegated to memex when installed.
---

Invoke the **vibebook** skill via the `Skill` tool with `skill: "vibebook"`.

The skill walks you through:
1. (If memex is installed) Ask once: also kick off `/memex-retro` afterward?
2. Run `vibebook prepare` (auto-detects project from cwd in project mode)
   to discover unprocessed sessions.
3. Segment sessions into threads (one chronicle per thread).
4. Write per-project chronicles (AI-first frontmatter, short body) +
   topic pages (mid-grain subsystem index).
5. Run `vibebook publish` to commit + push.
6. If user opted in at step 1: chain into `/memex-retro` for atomic cards.

Per-project isolation is a hard rule. Cards are no longer written by
vibebook itself — that workflow belongs to memex.
