# Chronicle format (AI-first frontmatter, agent-reuse body)

vibebook chronicles are read by AI agents. The frontmatter is the
**index** — everything an agent needs to triage "is this relevant?"
without reading the body. The body is **structured experience an agent
can directly reuse**: what worked, what didn't, what's still open.

This is NOT a weekly report. Drop the human-narrative voice.

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
decisions:                             # architectural calls + the rejected alternative
  - Used Glic widget framework over CopilotBubbleView (CopilotBubbleView's lifecycle didn't fit floating UI)
  - Moved init from startup to idle task (saved ~80ms perceived launch)
blockers:                              # what's still in the way
  - macOS 26 NSVisualEffectMaterialGlass requires private SDK fork
next_steps:                            # what would the next session do
  - Land MSA pref helper PR #15397229
  - Verify on M1 Pro
status: shipped | in-progress | blocked | abandoned
---

# <title>

## Context
1-2 sentences. The triggering scenario. Just enough that an agent
landing here cold knows what kind of problem this chronicle is about.

## What worked
The path we ended up shipping. Each bullet 1-2 sentences, written so an
agent can directly reuse the approach.

- Use `[NSStatusBar systemStatusBar]` + `sendActionOn:NSEventMaskLeftMouseUp|RightMouseUp`
  to dispatch left/right click — runtime checks `NSApp.currentEvent.type`.
  Commit `7bc9ef48`.
- Set widget level to `NSPopUpMenuWindowLevel` and collection behavior
  to `CanJoinAllSpaces|Transient|IgnoresCycle` so it floats above
  every space.

The voice here is "if you want this same outcome, do this" — NOT "we
then did X and it was interesting".

## Dead ends
Approaches we tried that didn't work, and **why**, so the next agent
doesn't reproduce them.

- Tried `CopilotBubbleView` for the floating widget first. Failed
  because the widget's lifecycle is owned by `AppController` (not
  `Browser`), and `BubbleView` assumes a `Browser*` is alive for
  positioning. → Switched to Glic widget framework.
- Tried CSS `scaling()` to fit the NTP into the 376×600 widget.
  Failed because the bubble's WebContents is not transformable
  inside a frameless NSWindow without a host view shim. → Wrote
  responsive CSS in the NTP frontend itself.

If a section is empty, write `(none)` — don't omit. Empty section
signals "I considered, none came up" vs missing section signals "I
forgot to think about this".

## Open questions
What's still unresolved. Not a TODO list (those go in `next_steps`
frontmatter); these are *uncertainties* a future agent should be
aware of before extending the work.

- Do we need to handle `NSStatusItem` re-creation when the user logs
  out and back in? Not tested in this session.
- The Glic widget framework is upstream Chromium; if upstream removes
  it, we'd need a fallback. No mitigation path identified.
```

## Rules

- **Frontmatter is non-negotiable.** files_touched / commits /
  decisions / blockers / next_steps / status are how AI agents triage.
  Missing fields = invisible to recall queries.
- **Body is for the things frontmatter can't carry.** Frontmatter says
  "we made decision X"; body says "we tried Y first and Y didn't work
  because Z". If everything you'd write in the body is already in
  frontmatter, the body can be just a 1-line Context section.
- **Each body bullet is "agent-reusable."** "We did X" is bad voice.
  "Use X to achieve Y; commit Z" is the right voice. Imagine the
  reader is another AI agent on a similar task next month.
- **Dead ends matter as much as What worked.** The failed-approach
  bullets often save more agent-time than the success bullets,
  because they prevent rediscovery. Don't skip them.
- **Open questions ≠ next_steps.** next_steps are concrete TODO items
  the work was queued behind ("land PR #15397229"). Open questions
  are uncertainties any future agent should know about.
- **Preserve commit hashes / file paths / DCHECK strings / regexes
  verbatim.** Paste at most ONE small code block per section when the
  literal form genuinely matters. Otherwise reference by file path.
- **Use the same language as the source session for body content**
  (Chinese sessions → Chinese body; English → English). Section
  HEADINGS stay in English for cross-session consistency.
- **Never write "let me walk you through" / "interestingly enough" /
  "we then" — that's blogger voice.** Agent-reuse voice is direct,
  imperative, no narrator.
- **Don't hallucinate.** `status: blocked` + a `blockers` entry beats
  an overstated "Outcome" line. If something didn't land, the
  `status` field already says so.
- Wikilinks: `[[chronicle/<threadId>]]` (vibebook) or
  `[[memex:<cardSlug>]]` (memex card, left as text — readers know to
  `memex read <slug>`).
