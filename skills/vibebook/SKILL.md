---
name: vibebook
description: Digest already-synced raw_sessions into per-project book artifacts (chronicle / topics). Triggers on `/vibebook`. Two modes auto-selected by cwd — project-mode (cwd ≠ session-repo, digests just the matching project) or global-mode (cwd = session-repo, fan-out one subagent per pending project then regen catalog). Per-project isolated. When memex is installed, atomic cards are delegated to /memex-retro instead of being written by vibebook.
---

# /vibebook — write your book

This skill walks the **in-session Claude** (you) through digesting the user's
already-synced AI coding sessions into three per-project book artifacts. Pure
mechanical CLI handles I/O (`vibebook prepare` / `vibebook publish` /
`vibebook list-projects` / `vibebook catalog-regen`); the LLM work —
segmentation + writing — is yours, in this conversation, with full context.

## Inputs you assume

- User has already run `vibebook sync` so `~/.vibebook/session-repo/` exists
  with `raw_sessions/` + `.vibebook/index.json` populated. (If you can't
  read that path, ask user to run `vibebook sync` first and stop.)
- `vibebook --version` is on PATH; user's config at `~/.vibebook/config.json`
  pins `repoPath = ~/.vibebook/session-repo`.

---

## Step 0 — Detect the mode (DO THIS FIRST)

Before anything else, run:

```bash
vibebook list-projects
```

Read `meta.isInSessionRepo` and `meta.sessionRepoPath` in the output.

| `meta.isInSessionRepo` | Mode | What you do |
|---|---|---|
| `false` | **project-mode** | Digest only the project matching the user's cwd. Most common case — user opened Claude Code inside a normal coding repo and is asking you to write up that project's recent work. |
| `true` | **global-mode** | User is sitting in `~/.vibebook/session-repo`, asking for a full sweep. Fan out one subagent per project that has pending sessions; finish with a catalog regen. |

**Tell the user which mode you detected** in one line, then proceed to the
matching section below. Do not try to guess; trust `list-projects`.

---

# Project mode

### Step P0 — Memex hand-off prompt (if memex is installed)

Before doing any chronicle/topic work, check if `memex` is on PATH:

```bash
command -v memex >/dev/null && memex --version
```

If memex IS available, ask the user **once** at the very start:

> Memex (atomic-card system) is installed. After I finish chronicles +
> topics, do you want me to also kick off `/memex-retro` to capture any
> reusable atomic insights from these sessions? (y/n)

Remember the answer for Step P8. If memex is NOT available, skip this
question entirely — don't suggest installing it here. (Wizard already
covered that path in `vibebook init`.)

### Step P1 — Prepare for cwd's project

```bash
vibebook prepare --cwd "$(pwd)"
```

If this errors with `no synced sessions found for cwd '...'`, the user is in
a directory whose work has never been synced. Tell them which `project` slug
you tried, and either:
- ask them to `vibebook sync` first (most common), or
- ask them to pass `--project <slug>` if they meant a different project.

The payload shape:

```json
{
  "project": "edge-src",
  "newSessions": [
    {
      "sessionId": "abc12345", "shortId": "abc12345",
      "tool": "claude" | "copilot",
      "endedAt": "2026-04-22T15:30:00Z",
      "mdPath": "raw_sessions/claude/edge-src/2026-04-22/...md",
      "preview": "first 300 chars of user's first real message",
      "insightScore": 0.62
    }
  ],
  "existingTopics": ["native-ui-fullscreen", "bookmark-bar", ...],
  "existingCards": ["gotcha-immersive-mode-mac-uaf", ...]
}
```

**Show the user** a summary line (`N new sessions in <project>`) and ask
to proceed. **Don't print the full table** unless the user asks — just the
count + first-3 displayName previews so they can sanity-check.

### Step P2 — Segment into threads

**Default: one thread = one session.** Only merge sessions if they are
demonstrably the same continuous effort (same threadId style, same files
touched, narrative obviously picks up where the previous one left off).
When in doubt, leave them separate. **Many small chronicles beat one bloated
mega-thread** — and you will under-count if you over-merge.

**Read the actual md file** (`mdPath`) for every session before deciding —
not just the preview. The preview can mislead (a session can open with "I
need to research" but turn into a 6KB debugging session).

> **Encryption is transparent.** Working tree is always plaintext. If you
> see `MEMVC1` at the top of any md file, the git filter wasn't installed
> here — tell the user to run `vibebook crypt init` and stop.

#### SKIP rules — be conservative

A session may be marked `skip: true` ONLY when ALL of these hold:

- It contains **no code change, no debugging conclusion, no decision**.
- It's one of: pure greeting, single unanswered question, "test this skill /
  ping", session-resume noise, or a string of API errors with no real reply.
- The user **explicitly abandoned** it ("nvm, gonna try elsewhere") OR the
  whole transcript is < ~500 chars of useful content.

**Always SKIP — vibebook meta-sessions.** A session whose entire content is
the user invoking `/vibebook` (or otherwise driving this skill) has zero
chronicle value — it's the user *running* the digest pipeline, not doing
real work. Detect via any of:

- The first user message is exactly `/vibebook` (or `/vibebook ...`).
- The transcript is dominated by `vibebook prepare` / `vibebook publish` /
  `vibebook list-projects` / `vibebook catalog-regen` tool calls.
- The assistant's output is mostly chronicle/topic/card markdown bodies
  being written to `/tmp/vibebook-*.json` or directly into `book/`.
- Project slug is `home` or any other pseudo project (already filtered by
  `isRealProjectPath`, but double-check at thread-segmentation time).

Mark these `skip: true` with `skipReason: "vibebook meta-session — user
running the digest skill, no original work content"`. Do NOT chronicle
them; they would just be self-referential noise.

**If in doubt, write the chronicle.** A 4-section chronicle for a "I tried X
and it didn't work" session is still valuable — it records the dead end.
Past sessions over-SKIPped and dropped 80%+ of real work; do not repeat
that mistake. The meta-session rule is the ONE exception where SKIP is the
default, not the conservative choice.

In particular, you must NOT SKIP:
- "Continue from where you left off" — read the previous session and merge.
- Sessions whose body has any of: a commit hash, a code block, a file path,
  an error message, a decision marker ("decided / let's go with / ok merged").
- Sessions where the user attached an image or a log and asked for analysis,
  even if your reply was short.
- Sessions with `untitled` filename — read the body; usually they're real
  work where the first message wasn't a question.

Write the segmentation to `/tmp/vibebook-groups.json`:

```json
[
  { "threadId": "fix-fullscreen-bookmark-bar",
    "title": "Fix Edge fullscreen bookmark-bar bug",
    "sessionIds": ["abc12345", "def67890"],
    "skip": false },
  { "threadId": "ping-test",
    "sessionIds": ["xyz99999"],
    "skip": true, "skipReason": "pure ping test, no real work content" }
]
```

Show user the table (one row per non-skip thread) + the skip count + skip
reasons in one block. Ask to proceed.

### Step P3 — Read in parallel via subagents (when ≥ 5 threads)

For 5 or more non-skip threads, dispatch one general-purpose Agent per
thread (or per ~3 grouped sessions). Each agent reads its `mdPath` files
and returns a chronicle body — JSON-serializable, ~500–2000 tokens. This
keeps your context lean and parallelizes I/O.

Below 5 threads, do it inline.

**Anti-pattern:** looping `vibebook show <id>` in the main session for 50
threads — eats your context window and produces lower-quality writing
because you start cargo-culting your own previous chronicles.

#### Permission warm-up — DO THIS BEFORE FAN-OUT, ONCE PER SESSION

Subagents in Claude Code **cannot interactively prompt the user for
Bash / Write permission** — that ability is exclusive to the main
session. If your fan-out fires before the user has approved the
patterns subagents need (writing JSON to `/tmp/vb-<project>/`,
running `vibebook publish`, etc.), each subagent will silently
stall, fall back to a different MCP tool, or return "permission
denied" without doing the work.

Before the first `Agent(...)` call in P3 (and before P5 / P6 sub-
fan-outs that write to `/tmp/`), run these warm-ups **inline in the
main session**. Each will trigger one `[Always allow ?]` prompt the
user can accept once:

```bash
mkdir -p /tmp/vb-<project>/_warmup && rmdir /tmp/vb-<project>/_warmup
# triggers Bash(mkdir -p /tmp/vb-<project>/*) approval

vibebook prepare --help >/dev/null
vibebook publish --help >/dev/null
# triggers Bash(vibebook prepare *) and Bash(vibebook publish *) approval

echo warmup > /tmp/vb-<project>/_warmup.json && rm /tmp/vb-<project>/_warmup.json
# triggers Write to /tmp/vb-<project>/* approval
```

Replace `<project>` with the actual project slug (e.g. `vb-edge-src`).
Tell the user to accept the BROAD pattern (the one with `*`) rather
than the literal call — one acceptance covers every subagent for the
rest of the session.

**Skip this only if** you've already warmed up earlier in the same
session, or the user has the patterns pre-approved in
`~/.claude/settings.json`.

If a subagent comes back with "permission denied", do NOT have the
subagent retry — it can't escalate. Run the warm-up from the main
session, then re-dispatch (or SendMessage to the same agent).

### Step P4 — Write chronicles (AI-first format, agent-reuse body)

For each non-skip thread, write a chronicle markdown using the AI-first
format spec'd in `references/chronicle-format.md` (same directory).
Critical rules:

- **Frontmatter is the index.** Fill files_touched / commits / decisions /
  blockers / next_steps / status from the source session. AI agents
  triage chronicles by reading frontmatter ONLY — missing fields mean
  invisible to recall queries.
- **Body is structured agent-reuse experience, not a weekly report.**
  Four sections — `## Context`, `## What worked`, `## Dead ends`,
  `## Open questions`. NOT What/Why/How/Outcome (that was the human-
  reading template; we deprecated it because agents have to re-parse
  it back into structured form every time).
- **Voice = imperative agent-reuse.** "Use X to achieve Y; commit Z" —
  NOT "we then did X and it was interesting". Imagine the reader is
  another AI agent on a similar task next month.
- **Dead ends matter as much as What worked.** Failed approaches save
  more agent-time than successes by preventing rediscovery. Don't
  skip the Dead ends section. If genuinely none, write `(none)` —
  empty section signals "considered, none came up", missing section
  signals "I forgot to think about it".
- **Atomic insights → memex.** If the chronicle inspires a "next time
  remember X" insight, that's a memex card not a chronicle bullet.
  Skip atomic-insight prose here; the memex hand-off (Step P6) catches it.
- Preserve commit hashes / file paths / code blocks / command lines
  verbatim. Paste at most ONE small code block per section when the
  literal form genuinely matters (DCHECK message, magic constant).
- Do NOT hallucinate. Use `status: blocked` + a `blockers` entry instead
  of overstating. If something didn't land, the `status` field says so.
- When writing What worked / Dead ends / Open questions, scan the last
  few messages of the source session — users often drop "ok merged" /
  "didn't work" / "still don't know if this races" right at the end.

**Build the JSON incrementally** — `Write` to `/tmp/vibebook-chronicles.json`
one chronicle at a time, OR write each chronicle to
`/tmp/vb/chronicle-<threadId>.json` and merge at the end with a small Python
pass. **Never `cat > /tmp/x.json << 'PYEOF'` heredoc with all bodies in
one shot** — that triggers Bash injection prompts and hits cloudflare 524
on big batches.

**`project`, `threadId`, `title` MUST appear at the TOP LEVEL of each JSON
entry, not only inside the markdown frontmatter.** publish reads the JSON
top level to compute paths; if `project` is missing publish refuses with
`chronicle.project is required`. The same rule applies to topics
(`project` + `topicSlug`). Schema:

```json
[
  { "threadId": "fix-fullscreen", "project": "edge-src",
    "title": "Fix Edge fullscreen bookmark-bar bug",
    "sessionIds": ["abc12345"], "tags": ["fullscreen"],
    "body": "---\nproject: edge-src\n...\n---\n# ...\n## What...\n" }
]
```

**Never write a Python script that generates chronicle bodies.** The bodies
ARE your output as the LLM. Python is fine for: merging JSON files, sorting,
deduplicating slugs. NOT for writing prose.

### Step P5 — Update topic pages

Decide which **topic(s)** each non-skip thread touches. Topic = mid-grain
subsystem (`native-ui-fullscreen`, `bookmark-bar`, `mojo-ipc`,
`crash-debugging-macos`). Not a single bug; not the whole project.

A thread can touch 0, 1, or many topics. Multiple threads usually touch
the same topic.

For each affected topic:

- **If it exists** (in `existingTopics[]`): `Read book/<project>/topics/<slug>.md`
  full text → preserve every historical fact → fold the new thread's facts
  + relations into a coherent rewrite (`action: "update"`). The publish
  step backs the old page up to `<slug>.md.bak`.
- **If it doesn't exist**: create it (`action: "insert"`) with the schema in
  `references/topic-format.md`.
- **If a thread is too ad-hoc to fit any topic**: skip topic creation. Not
  every chronicle needs a topic.

**Wikilinks** — write `[[chronicle/<threadId>]]` directly in topic +
chronicle bodies as human-friendly placeholders. `vibebook publish`
mechanically rewrites them to real relative-path markdown links. Use
bare `threadId`, NOT a date-prefixed filename. (If memex is installed
and you want to link to a memex card, write `[[memex:<cardSlug>]]` —
those are left as text but flagged to readers.)

Write topics to `/tmp/vibebook-topics.json`:

```json
[
  { "topicSlug": "native-ui-fullscreen",
    "project": "edge-src",
    "action": "update",
    "contributingThreads": ["fix-fullscreen-bookmark-bar", "immersive-mode-rewrite"],
    "body": "..." }
]
```

### Step P6 — Atomic cards (delegated to memex)

vibebook itself **does not write atomic cards** anymore — that work
belongs to [memex](https://github.com/iamtouchskyer/memex), which has
the right primitives (Zettelkasten links, organize/orphan detection,
archive, dedicated retro hook). vibebook keeps its scope tight:
chronicles + topics, that's it.

If `memex` is on the user's PATH, see "Memex hand-off" below — the
orchestrator may chain into `/memex-retro` after publish to capture
atomic insights. Don't try to write cards inline here.

If `memex` is NOT installed, that's fine too. Atomic cards are a
"future-self insurance policy"; chronicles + topics already cover the
"future-AI search" use case via vibebook-recall.

### Step P7 — Confirm + publish

Show the user:

```
About to publish to book/<project>/:
  Chronicles: N (S SKIP'd)
  Topics:     M (X update / Y new)

Confirm? (y/n)
```

If user wants to tweak something, do it now (you can rewrite any artifact —
just re-emit the JSON). Then publish:

```bash
vibebook publish \
  --chronicles /tmp/vibebook-chronicles.json \
  --topics /tmp/vibebook-topics.json \
  --no-catalog
```

`--no-catalog` because project-mode is incremental — the catalog will be
regenerated next time the user runs global-mode `/vibebook`. Skipping it
here keeps the commit small and avoids touching files for other projects.

publish does:

1. Inserts each chronicle to `<repoPath>/book/<project>/chronicle/...md`
   (refuses on threadId collision).
2. Topics: backs old `.md` up to `<slug>.md.bak` if existed, writes new.
3. Resolves `[[wikilinks]]` against the live BookIndex.
4. Stages ONLY the files it wrote + `.vibebook/index.book.json`.
5. Commits + pushes the device branch.

If unresolved wikilinks remain, publish prints them at the end. Read the
warning, fix in a follow-up batch (`vibebook publish` is idempotent — already-
inserted chronicles refuse via threadId collision, so you can re-run with
just the new artifacts).

### Step P8 — Done (and optional memex hand-off)

Print a one-line summary:

```
✓ Published to book/<project>/: N chronicles, M topics.
✓ Pushed to <device-branch>.
```

If the user said yes at Step P0 (memex is installed AND user opted in),
hand off now by invoking the `memex-retro` skill via the Skill tool:

```
Skill(skill: "memex-retro")
```

That skill will look back at the work this conversation captured and
write atomic cards as appropriate. vibebook's job is done at that
point — memex owns the card layer.

If the user said no, or memex isn't installed, just print the summary
and stop.

That's it for project-mode. The user can now `cd ~/.vibebook/session-repo && claude → /vibebook`
later to do a global sweep across all projects.

---

# Global mode

Triggered when cwd = `~/.vibebook/session-repo`. The user wants a full
sweep across every project. You orchestrate; subagents do the per-project
work using the same project-mode flow.

### Step G0 — Memex hand-off prompt (if memex is installed)

Same as project-mode Step P0: check `command -v memex`. If installed,
ask once at the start:

> Memex is installed. After the global sweep finishes, want me to also
> run /memex-retro on the most insight-dense chronicles? (y/n)

Remember the answer for Step G4. If memex isn't installed, skip.

### Step G1 — Triage

`vibebook list-projects` already ran in Step 0. Show the user the table:

```
project              total  pending  chronicles  topics  cards  lastTouched
edge-src                75       68           7       2     12  2026-04-22
chromium-src            53       43          10       3      8  2026-04-22
edge-claude-code        21       18           3       1      4  2026-04-15
...
edge-misc                4        4           0       0      0  —

12 projects pending; 0 already covered (lastTouched=null AND pending>0 means
"never digested").
```

Confirm with user which projects to process this run. Default: every project
with `pendingSessions > 0`. Let user exclude any.

### Step G2 — Fan out subagents (one per project)

#### Permission warm-up — DO THIS FIRST

Same rationale as project-mode P3 (subagents can't prompt the user
for permission). Before the first `Agent(...)` call, run inline:

```bash
mkdir -p /tmp/vibebook/_warmup && rmdir /tmp/vibebook/_warmup
vibebook prepare --help >/dev/null
vibebook publish --help >/dev/null
echo warmup > /tmp/vibebook/_warmup.json && rm /tmp/vibebook/_warmup.json
```

Tell the user to approve the BROAD pattern (e.g. `Bash(vibebook
prepare *)`, not the literal `--help` invocation). Skip if already
warmed up earlier in the session or pre-approved in
`~/.claude/settings.json`.

#### The actual fan-out

For each project to process, dispatch a `general-purpose` Agent in parallel
(via multiple Agent tool calls in one message). Each agent's prompt:

```
You are running project-mode /vibebook for project '<slug>'. Steps to follow,
verbatim from skills/vibebook/SKILL.md sections P1–P7:

  1. Run: vibebook prepare --project <slug>
  2. For every newSession, Read its mdPath. Apply SKIP rules conservatively
     (read the SKIP rules in SKILL.md project-mode Step P2 — only ping/greeting/
     pure-error sessions get skipped; everything else gets a chronicle).
  3. Segment one-thread-per-session by default; merge only when it's the
     same continuous effort.
  4. Write an agent-reuse 4-section chronicle for each non-skip thread
     (Context / What worked / Dead ends / Open questions; imperative
     voice; preserve commit hashes / file paths / code blocks verbatim).
  5. Update or insert topic pages (mid-grain subsystem level). Read existing
     topic pages and preserve historical facts when rewriting.
  6. Run: vibebook publish --chronicles ... --topics ... --no-catalog

Write your three input JSON files under /tmp/vibebook/<slug>/ so we don't
collide with sibling subagents.

Return a one-line summary of counts. Do NOT regen the catalog — the
orchestrating session will do that once after all subagents finish.

If you hit a `permission denied` on a Bash or Write tool: STOP, return
"permission denied: <pattern>" as your summary, and let the orchestrator
re-run the warm-up. Do NOT retry the same command — you can't escalate.
```

**Don't run them all at once if there are 10+ projects** — Claude Code has
limits on concurrent subagents. Cap at 4 in flight; queue the rest.

If a subagent fails (especially with `permission denied`), log it but
continue with the next batch — the user can re-run `/vibebook` against
that project later in project-mode after the warm-up has approved the
needed patterns.

### Step G3 — Catalog regen

After all subagents return:

```bash
vibebook catalog-regen
```

This regenerates `book/index.md`, `book/_meta/timeline.md`, and
`book/<project>/index.md` for every project, then commits + pushes.

### Step G4 — Summary (and optional memex hand-off)

```
✓ Global sweep complete.
  edge-src:        +6 chronicle, +2 topic
  chromium-src:    +5 chronicle, +1 topic
  ...
  catalog regenerated and pushed.
```

If the user said yes at Step G0, hand off now:

```
Skill(skill: "memex-retro")
```

memex-retro will see the chronicles + topics this sweep just produced
and decide which atomic insights deserve cards. vibebook stops here.

---

## Things you should NEVER do

- ❌ `Write` directly into `book/<project>/{chronicle,topics}/*.md` —
  always go through `vibebook publish` so wikilinks resolve and the index
  stays in sync.
- ❌ Write a chronicle for a SKIP'd session.
- ❌ Force-merge unrelated sessions to make a "bigger thread".
- ❌ Write blogger-style "let me walk you through" / "interestingly
  enough" / "we then" prose. Body voice is imperative agent-reuse:
  "Use X to achieve Y" — not "we did X and discovered Y".
- ❌ Hallucinate outcomes. If user didn't say it worked, don't say it worked.
- ❌ Cross project boundaries (edge-src content ending up in chromium-src/).
- ❌ Try to write atomic cards yourself — that's memex's job. If memex
  isn't installed, just skip the atomic-card layer entirely.
- ❌ Skip the `Read` of an existing topic page before rewriting it.
- ❌ Touch any file in `raw_sessions/` — those are immutable source data.
- ❌ Run global-mode `/vibebook` with cwd ≠ `~/.vibebook/session-repo`. The
  cwd check is the mode trigger; do not override.

## Things you should always do

- ✅ Run `vibebook list-projects` FIRST to detect mode.
- ✅ In project-mode, derive project from cwd (`vibebook prepare --cwd`).
- ✅ Default to one-thread-per-session; merge only when continuous.
- ✅ Be conservative with SKIP — write the chronicle if in any doubt.
- ✅ Use Read / Glob / Grep to inspect existing book/ before writing topics.
- ✅ Preserve exact code blocks, command lines, file paths, commit hashes.
- ✅ Mark uncertainty: "unfinished", "unverified", "blocked".
- ✅ Stop and ask if user said something contradicting your plan.
