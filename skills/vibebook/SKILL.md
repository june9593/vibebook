---
name: vibebook
description: Digest already-synced raw_sessions into per-project book artifacts (chronicle / topics / cards). Triggers on `/vibebook`. Two modes auto-selected by cwd — project-mode (cwd ≠ session-repo, digests just the matching project) or global-mode (cwd = session-repo, fan-out one subagent per pending project then regen catalog). Per-project isolated; never crosses project boundaries except for `_global/cards/`.
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
  an error message, a decision marker ("决定 / let's go with / ok merged").
- Sessions where the user attached an image or a log and asked for analysis,
  even if your reply was short.
- Sessions with `untitled` filename — read the body; usually they're real
  work where the first message wasn't a question.

Write the segmentation to `/tmp/vibebook-groups.json`:

```json
[
  { "threadId": "fix-fullscreen-bookmark-bar",
    "title": "修复 Edge 全屏书签条 bug",
    "sessionIds": ["abc12345", "def67890"],
    "skip": false },
  { "threadId": "ping-test",
    "sessionIds": ["xyz99999"],
    "skip": true, "skipReason": "纯 ping 测试,无任何工作内容" }
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

### Step P4 — Write chronicles (4-section)

For each non-skip thread, write a chronicle markdown using the strict
4-section format. Refer to `references/chronicle-format.md` (same directory)
for the schema; keep the rules:

- 周报风,流水账;不要博客叙事
- 保留 commit hash / 文件路径 / code block / command line verbatim
- 不要 hallucinate: 没说成的写 "**未完成**" / "**未验证**" / "**阻塞:<原因>**"
- 写 Why 和 Outcome 时,扫一下原 session 末尾几条消息

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
(`project` + `topicSlug`) and cards (`project` + `cardSlug`). Schema:

```json
[
  { "threadId": "fix-fullscreen", "project": "edge-src",
    "title": "修复 Edge 全屏书签条 bug",
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

**Wikilinks** — write `[[chronicle/<threadId>]]` and `[[<cardSlug>]]` (or
`[[cards/<cardSlug>]]`) directly in topic + card + chronicle bodies as
human-friendly placeholders. `vibebook publish` mechanically rewrites them
to real relative-path markdown links. Use bare `threadId`, NOT a date-prefixed
filename. Cards prefer same-project then `_global/`; you write the slug, the
publisher resolves.

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

### Step P6 — Extract atomic cards

For each chronicle, extract **0 to N atomic insight cards**. Most chronicles
yield 0–2 cards. A few yield 5+. **Don't pad** — a card is for future-you,
not for completeness.

**Hard rules:**

1. **Atomic** — 一张卡一个事。能拆就拆。
2. **Non-obvious** — "下次做类似事会失去这个 insight 吗?不会就别写。"
   API 文档里有的东西不写。
3. **Own words / Feynman** — 用自己的话复述。**不要粘 API 文档原文 / 错误信息原文**.
4. **Fact Hygiene** — 写完每张卡自检三问 (一条不过关就重写):
   - **WHO** — 项目/库/工具是用户自己的还是外部的?陌生人能分清吗?
   - **WHAT-WHEN** — 数字 (耗时/token/commit hash) 是否绑定到具体场景和时间?
   - **RELATIONSHIP** — "基于/参照" 这类词展开成具体关系
     (fork from / benchmark against / inspired by / extends / contradicts)。
5. **Dedup before write** — `Glob book/<project>/cards/*.md` 和
   `Glob book/_global/cards/*.md`,看有没有相似的:
   - 内容增量 → `action: "update"` 在已有卡片末尾追加一段。
   - 内容重复 → 跳过。
6. **Wikilink in context** — `[[link]]` 必须嵌在解释关系的句子里。
   ❌ `Related: [[x]]`
   ✅ `这与 [[gotcha-foo]] 的修法相反 — 那里用 widget 监听,这里用 NSWindow API`

**Slug naming**:

- `gotcha-<具体名>` — 一个坑 (UAF / order dependency / 配置陷阱)
- `pattern-<具体名>` — 一个可复用的做法
- `decision-<具体名>` — 一个架构决策 (含理由)
- `howto-<具体名>` — 一个具体怎么做
- `tool-<具体名>` — 工具用法/配置

**Per-project vs `_global/`**:

| 卡片关于... | 放哪 |
|---|---|
| 跟具体 codebase / 业务 / 公司项目绑定 | `book/<project>/cards/` |
| 跟工具 / 语言 / OS / 通用 best-practice 绑定 | `book/_global/cards/` |
| 二者都涉及 | per-project (主),`_global/` 留 wikilink 入口 |

Card schema in `references/card-format.md`. Write cards to
`/tmp/vibebook-cards.json`.

### Step P7 — Confirm + publish

Show the user:

```
About to publish to book/<project>/:
  Chronicles: N (S SKIP'd)
  Topics:     M (X update / Y new)
  Cards:      K (X update / Y new / Z _global)

Confirm? (y/n)
```

If user wants to tweak something, do it now (you can rewrite any artifact —
just re-emit the JSON). Then publish:

```bash
vibebook publish \
  --chronicles /tmp/vibebook-chronicles.json \
  --topics /tmp/vibebook-topics.json \
  --cards /tmp/vibebook-cards.json \
  --no-catalog
```

`--no-catalog` because project-mode is incremental — the catalog will be
regenerated next time the user runs global-mode `/vibebook`. Skipping it
here keeps the commit small and avoids touching files for other projects.

publish does:

1. Inserts each chronicle to `<repoPath>/book/<project>/chronicle/...md`
   (refuses on threadId collision).
2. Topics: backs old `.md` up to `<slug>.md.bak` if existed, writes new.
3. Cards: insert / update on slug match.
4. Resolves `[[wikilinks]]` against the live BookIndex.
5. Stages ONLY the files it wrote + `.vibebook/index.book.json`.
6. Commits + pushes the device branch.

If unresolved wikilinks remain, publish prints them at the end. Read the
warning, fix in a follow-up batch (`vibebook publish` is idempotent — already-
inserted chronicles refuse via threadId collision, so you can re-run with
just the new artifacts).

### Step P8 — Done

Print a one-line summary:

```
✓ Published to book/<project>/: N chronicles, M topics, K cards.
✓ Pushed to <device-branch>.
```

That's it for project-mode. The user can now `cd ~/.vibebook/session-repo && claude → /vibebook`
later to do a global sweep across all projects.

---

# Global mode

Triggered when cwd = `~/.vibebook/session-repo`. The user wants a full
sweep across every project. You orchestrate; subagents do the per-project
work using the same project-mode flow.

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
  4. Write a 4-section chronicle for each non-skip thread (周报风, no blogger
     narrative, preserve commit hashes / file paths / code blocks verbatim).
  5. Update or insert topic pages (mid-grain subsystem level). Read existing
     topic pages and preserve historical facts when rewriting.
  6. Extract 0..N atomic cards per chronicle (Fact Hygiene check; dedup vs
     existing cards).
  7. Run: vibebook publish --chronicles ... --topics ... --cards ... --no-catalog

Write your three input JSON files under /tmp/vibebook/<slug>/ so we don't
collide with sibling subagents.

Return a one-line summary of counts. Do NOT regen the catalog — the
orchestrating session will do that once after all subagents finish.
```

**Don't run them all at once if there are 10+ projects** — Claude Code has
limits on concurrent subagents. Cap at 4 in flight; queue the rest.

If a subagent fails, log it but continue — the user can re-run
`/vibebook` against that one project later in project-mode.

### Step G3 — Catalog regen

After all subagents return:

```bash
vibebook catalog-regen
```

This regenerates `book/index.md`, `book/_meta/timeline.md`, and
`book/<project>/index.md` for every project, then commits + pushes.

### Step G4 — Summary

```
✓ Global sweep complete.
  edge-src:        +6 chronicle, +2 topic, +12 cards
  chromium-src:    +5 chronicle, +1 topic, +7 cards
  ...
  catalog regenerated and pushed.
```

---

## Things you should NEVER do

- ❌ `Write` directly into `book/<project>/{chronicle,topics,cards}/*.md` —
  always go through `vibebook publish` so wikilinks resolve and the index
  stays in sync.
- ❌ Write a chronicle for a SKIP'd session.
- ❌ Force-merge unrelated sessions to make a "bigger thread".
- ❌ Write blogger-style "let me walk you through" prose.
- ❌ Hallucinate outcomes. If user didn't say it worked, don't say it worked.
- ❌ Cross project boundaries (edge-src content ending up in chromium-src/).
- ❌ Skip the dedup `Glob` before writing cards.
- ❌ Skip the `Read` of an existing topic page before rewriting it.
- ❌ Write a card for something that's API documentation or obvious knowledge.
- ❌ Touch any file in `raw_sessions/` — those are immutable source data.
- ❌ Run global-mode `/vibebook` with cwd ≠ `~/.vibebook/session-repo`. The
  cwd check is the mode trigger; do not override.

## Things you should always do

- ✅ Run `vibebook list-projects` FIRST to detect mode.
- ✅ In project-mode, derive project from cwd (`vibebook prepare --cwd`).
- ✅ Default to one-thread-per-session; merge only when continuous.
- ✅ Be conservative with SKIP — write the chronicle if in any doubt.
- ✅ Use Read / Glob / Grep to inspect existing book/ before writing cards.
- ✅ Preserve exact code blocks, command lines, file paths, commit hashes.
- ✅ Mark uncertainty: "未完成", "未验证", "阻塞".
- ✅ Stop and ask if user said something contradicting your plan.
