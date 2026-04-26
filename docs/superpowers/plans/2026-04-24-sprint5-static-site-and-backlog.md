# Sprint 5 + ongoing backlog (post-v0.2.0)

**Captured**: 2026-04-24, after v0.2.0 implementation complete.

## Status quo

v0.2.0 ships:
- Three artifact types (chronicle / topics / cards), per-project isolation, `_global/cards/`
- LLM completely in-session via `/vibebook` slash command (npm CLI never spawns LLM)
- git clean/smudge filter encryption (working tree always plaintext)
- wikilink resolver (`[[chronicle/<threadId>]]`, `[[<cardSlug>]]` → real markdown links)
- Skill batch sizing rule (Step 0 of SKILL.md — picks top N to avoid context blow-out)
- Cross-device aggregate workflow + `merge-books.mjs` v2 schema
- 170/170 tests, README + SKILL.md current
- Q6 (claude model) wizard question removed — model is chosen in Claude Code via `/model`

## Sprint 5 — mdBook static site for `book/`

Picked over CLI polish + spinoff plugin because the user wants something
visually browsable on the web. mdBook is the simplest mature renderer for
markdown + cross-page links.

### MVP scope

1. **`vibebook site init`** — write into the user's repo:
   - `book.toml` (mdbook config: title, src=book/, build-dir=site/, default theme)
   - `book/SUMMARY.md` (auto-generated from book index v2)
   - `.github/workflows/vibebook-site.yml` (build + deploy to gh-pages on push to main)
   - Optional: tiny shell preprocessor to strip yaml frontmatter so mdBook doesn't render `---` literally
2. **`vibebook site build`** — local preview:
   - Re-generate `SUMMARY.md` from current book index
   - Run `mdbook build`
   - Print `open book/site/index.html`
3. **SUMMARY.md generation rules**:
   - Top: link to `book/index.md` as the landing page
   - Per project: `## <project>` heading, then `chronicle/`, `topics/`, `cards/` subsections
   - Chronicles sorted newest-first by `updatedAt`, link text = chronicle title
   - Topics + cards sorted alphabetically by slug
   - `_global/` rendered as its own top-level project
   - `_meta/timeline.md` linked at the bottom
4. **CI**: extend `vibebook-aggregate.yml` (or add a sibling job) that runs after the merge step:
   - Install mdbook (cargo binstall mdbook OR cached download from GitHub releases)
   - Re-gen SUMMARY.md (call `vibebook site build --skip-mdbook` or run a copy of the gen script bundled in the workflow)
   - `mdbook build`
   - Push `book/site/` → `gh-pages` branch via `peaceiris/actions-gh-pages`
   - User enables Pages → branch=gh-pages, /=root in repo settings

### Open questions before implementation

- **Frontmatter strategy**: write a `mdbook-strip-frontmatter` preprocessor (small JS file the workflow downloads), or strip in the SUMMARY-gen step (preprocess `book/` into `book-rendered/`)? Preprocessor is cleaner; preprocessing into a sibling dir means git history is on the source.
- **Backlinks**: skip in MVP. Add later via `mdbook-backlinks` if traffic justifies it.
- **CJK search**: mdBook's default search is whitespace-tokenized — Chinese content won't search well. Acceptable for MVP; flag as known limitation.
- **Per-device or merged view?** The aggregated `main` branch already has merged view; `<topicSlug>.<device>.md` shows up as separate pages. Acceptable for MVP.
- **Cost of running mdBook in CI**: tiny (cached binary + ~5s build). No concern.

### Risks

- mdBook's link checker may flag the post-resolve markdown links (now relative paths) as broken if it can't follow `..` references across `book/<project>/<artifact>/<file>.md`. Test early.
- yaml frontmatter literal display is the most likely surprise. Strip-step needs unit test.
- The `_meta/` directory is currently outside the per-project tree but inside `book/`. SUMMARY.md needs to handle it specially.

### Tasks (rough sketch, refine when starting)

1. Pure function `generateSummaryMd(bookIndex, devices)` + tests
2. `vibebook site init` writes book.toml + workflow yaml + commits
3. `vibebook site build` runs gen + mdbook build (mdbook check on PATH, friendly error if missing)
4. The frontmatter preprocessor (decide approach first)
5. `vibebook-site.yml` workflow, gh-pages deploy, tested via local `act` if feasible
6. README section "view your book on the web"

---

## Other backlog items

### Polish (small wins, can be opportunistic)

- **`vibebook prepare --top N`** — let CLI return only top-N by insightScore (skill currently does this in prose). Cleaner contract, easier for skill to follow.
- **`vibebook publish --dry-run`** — write files but skip commit/push, so user can inspect before merging into the device branch.
- **Persist unresolved wikilinks** — write `.vibebook/unresolved-links.json` after publish so next `/vibebook` skill can surface "you have N unresolved links from last batch, fix them?"
- **`vibebook regenerate <threadId>`** — overwrite a single chronicle without going through the full prepare/publish flow. Useful when the user iterates on writing style.

### Quality / cross-device

- **Cross-device topic LLM merge** — currently `<topicSlug>.<device>.md` accumulates one file per device. Eventually run an in-session merge that reconciles N device versions into one canonical topic. Keeps `<device>.md` as audit trail.
- **Card dedup across devices** — currently union by `(project, slug)` with latest-`updatedAt` wins. Should optionally invoke the skill to merge two semantically-similar cards (different slugs, same insight). Hard to automate; might just be a `vibebook cards review` command.

### Marketplace plugin (separate repo, see backlog file)

See `2026-04-24-backlog-claude-only-plugin.md` — Claude-only plugin with zero
npm dependency. Picked up after Sprint 5 if site has traction.

---

## Out of scope (for now or forever)

- **anthropic-api runner** — permanently cancelled. The whole v0.2 architecture is "LLM in user's session", which means no CLI-spawned LLM. Schema field `runner` kept for backwards compat in case we ever need to discriminate, but no other runner is planned.
- **`runnerModel` config field** — removed in v0.2. Model lives in Claude Code's `/model`.
- **Auto-cron `vibebook sync`** — explicitly user-triggered. No daemon, no launchd.
