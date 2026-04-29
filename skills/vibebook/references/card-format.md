# Card format (atomic insight)

```markdown
---
title: <one sentence stating the insight>
slug: <type>-<descriptive-slug>
type: gotcha | pattern | decision | howto | tool
project: <project-slug> | _global
created: YYYY-MM-DD
tags: [domain, type]            # 1-3 ideal, ≤5 max
---

(One or more paragraphs explaining the fact / pattern / decision.
Embed wikilinks in sentences that explain the relationship.)

ref: [[chronicle/<source-thread-slug>]]
```

Slug type prefix:

- `gotcha-<name>` — a trap (UAF / order dependency / configuration gotcha)
- `pattern-<name>` — a reusable approach
- `decision-<name>` — an architectural decision (with reasoning)
- `howto-<name>` — a concrete how-to
- `tool-<name>` — tool usage / config (e.g. `tool-claude-code-skill-loading`)

Per-project vs `_global/`:

| Card is about... | Goes in |
|---|---|
| A specific codebase / product / company project | `book/<project>/cards/` |
| A tool / language / OS / generic best practice | `book/_global/cards/` |
| Both | per-project (primary); leave a wikilink entry in `_global/` |

Hard rules:

1. **Atomic** — one card, one fact. If it can be split, split it.
2. **Non-obvious** — "Next time I do similar work, would I lose this
   insight?" If no, don't write the card. Don't card things already in
   the API docs.
3. **Own words** — paraphrase in your own voice. **Do NOT paste raw API
   docs or raw error messages**. If pasting is the only way you can
   express it, you didn't actually understand it — don't write the card.
4. **Fact Hygiene check** — after writing, ask three questions; if any
   fail, rewrite:
   - **WHO** — projects/libraries/tools mentioned: are they the user's
     own or external? Can a stranger tell them apart?
   - **WHAT-WHEN** — numbers (time spent / tokens / commit hashes): are
     they pinned to a concrete scenario?
   - **RELATIONSHIP** — words like "based on / inspired by / refer to"
     should expand into a concrete relationship verb (fork from /
     benchmark against / inspired by / extends / contradicts).
5. **Dedup before writing** — `Glob book/<project>/cards/*.md` +
   `Glob book/_global/cards/*.md`, look for similar entries:
   - New material on top of existing → `action: "update"`, append to
     the existing card.
   - Duplicate → skip.
6. **Wikilinks in context** — `[[link]]` must be embedded in a sentence
   that explains the relationship.
   ❌ `Related: [[x]]`
   ✅ `This contrasts with [[gotcha-foo]] — that one listens via the
   widget; here we use the NSWindow API directly.`
