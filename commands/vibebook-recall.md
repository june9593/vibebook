---
description: Three-stage progressive recall of past chronicles + topics from your vibebook session-repo. Stage 1 lists topics; stage 2 (--topic) lists chronicles with frontmatter; stage 3 reads the bodies that match. Use BEFORE exploring code in any project the user has synced.
---

Invoke the **vibebook-recall** skill via the `Skill` tool with
`skill: "vibebook-recall"`.

Use this **before** you start exploring code in a project repo where the
user has run `vibebook sync`. The skill walks you through three stages:

1. **Stage 1**: `vibebook recall --cwd "$(pwd)"` — fetch the project's
   topic list (~5 KB of title + summary). Includes memex cards if memex
   is installed.
2. **Stage 2**: `vibebook recall --cwd "$(pwd)" --topic <slug>` — for
   each topic that matches the task, fetch its chronicles with
   AI-first frontmatter (files_touched / commits / decisions / status).
3. **Stage 3**: `Read` the chronicle bodies that the frontmatter
   suggests are most relevant. For memex cards: `memex read <slug>`.

Reference past findings explicitly when you reply.

This skill closes the read loop on `/vibebook` (chronicle + topic
writer) and `/memex-retro` (atomic-card writer).
