# Chronicle format (AI-first frontmatter, short body)

vibebook chronicles are read by AI agents far more often than by humans.
The frontmatter is the index — it MUST contain everything an agent
needs to decide "is this chronicle relevant to my task?" without
reading the body. The body is the receipt — short prose that backs
up the frontmatter facts.

```markdown
---
title: <human-readable, ≤30 chars>
created: YYYY-MM-DD
updated: YYYY-MM-DD
project: <project-slug>
threadId: <slug>
sessionIds: [<shortId>, <shortId>, ...]
tags: [domain, scope, type]            # 1-5 tags

# AI-index fields — fill these from the source session, NOT made up
files_touched:                         # absolute repo paths the work changed
  - chrome/browser/ui/cocoa/edge_menu_bar/edge_menu_bar_controller.mm
  - chrome/browser/edge_copilot_window/floating_window/copilot_floating_window_widget.cc
commits:                               # git SHAs that landed
  - 7bc9ef48b654
  - abcd1234ef56
decisions:                             # 1-line architectural calls
  - Use Glic widget framework over CopilotBubbleView for floating window
  - Move init from startup to idle task (perf)
blockers:                              # what's still in the way
  - macOS 26 NSVisualEffectMaterialGlass requires private SDK fork
next_steps:                            # what would the next session do
  - Land MSA pref helper PR #15397229
  - Verify on M1 Pro
status: shipped | in-progress | blocked | abandoned
---

# <title>

## What — what was done
1-3 sentences. NOT 1-3 paragraphs. The bullet list of work is in
`files_touched` + `commits`; here you give the *narrative* glue.

## Why — why it was needed
1-3 sentences. Trigger / motivation. The bug ticket or PRD reference
goes in tags or wikilinks.

## How — how it was done
2-5 sentences. Cite the key code path. Paste at most ONE small code
block (≤10 lines) when verbatim form genuinely matters (DCHECK message,
critical regex, magic constant). Otherwise reference by file path.

## Outcome
1-2 sentences. The result — what shipped, what blocked.
`status` field already encodes the bottom line; this just adds color.
```

Rules:

- **Frontmatter is non-negotiable**. files_touched / commits / decisions /
  blockers / next_steps / status are how AI agents triage. Missing fields
  mean the chronicle is invisible to recall queries that filter on those.
- **Body keeps short**. If you find yourself writing a 4th paragraph in
  a section, the content probably belongs in a topic page (subsystem
  level) or in a memex card (atomic insight) — NOT in the chronicle.
- **NO blogger narrative**. No "let me walk you through", no
  "interestingly enough", no recap of what's already in the frontmatter.
- **No hallucination**. If something didn't land, write
  `status: blocked` and put the reason in `blockers`. Don't write Outcome
  sentences that overstate.
- **Verbatim preservation policy applies to file paths and commit
  hashes** — paste them as the source session has them. Code snippets
  inside `## How` should match the source byte-for-byte where they
  appear; do not "tidy up" syntax.
- Use the same language as the source session for the body content
  (Chinese sessions → Chinese chronicle; English sessions → English).
  The frontmatter field NAMES stay in English for consistency.
- Wikilinks: `[[chronicle/<threadId>]]` (vibebook) or
  `[[memex:<cardSlug>]]` (memex card, left as text — readers know).
