---
description: Pull this project's vibebook catalog (chronicle / topic / card titles + 1-line summaries) into context, triage what's relevant to the current task, then Read the entries that bear on it.
---

Invoke the **vibebook-recall** skill via the `Skill` tool with
`skill: "vibebook-recall"`.

Use this **before** you start exploring code in a project repo where the
user has synced sessions. The skill walks you through:

1. Run `vibebook recall --cwd "$(pwd)"` to fetch this project's catalog
   (cards + topics + chronicles, ~30 KB of titles + summaries).
2. Triage entries by title/summary — find the 1-3 that bear on the
   current task.
3. Use `Read` to load the full md for those entries.
4. Reference past findings explicitly when you reply.

This skill closes the loop on `/vibebook`: that one writes notes for
future-you; this one lets future-you read them.
