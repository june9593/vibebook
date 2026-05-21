# Changelog

## 0.6.1 — 2026-05-21

Fast follow-up to 0.6.0 covering the gaps exposed by Yue's fresh-init
test on mini2: a real bug that blocked auto workflow install, plus
overdue wizard polish.

### Bug fixes

- **`vibebook workflow init` no longer fails when the user's primary
  working tree is on `main`.** Previously the worktree helper used
  `git checkout -B main` inside the temp worktree, which git refuses
  when `main` is already checked out elsewhere (very common after
  fresh `vibebook init` — local default branch is `main`). Failure was:
  `fatal: 'main' is already used by worktree at <repoPath>`. Fix:
  worktree now uses a unique temp branch name (`vibebook-tmp-main-<ts>-<rand>`)
  and pushes with `git push origin HEAD:main`, then cleans up the
  temp branch ref in `finally`.

### Wizard polish (init wizard goes from 9 questions to 7)

- **Q6 (Enable CI aggregation?) dropped** — now auto-true when
  sync-to-remote, auto-false when local-only. Workflow init still
  runs at the end of init (now succeeds even on `main` thanks to
  the bug fix above). Escape hatch: edit `~/.vibebook/config.json`
  to set `enableAggregateCI: false`.
- **Q7 (Include reasoning?) dropped** — reasoning blocks are part
  of the context.md content-block stream by design in 0.6+;
  truncation already handles size. The config field is retained for
  backward compat but is always `true`.
- **Q6 (was Q8): device name default now strips `.local`, `.lan`,
  and corp FQDN suffixes**. So `Mac-mini-2.local` defaults to
  `Mac-mini-2` rather than the volatile mDNS form. Still warns if
  the cleaned name looks DHCP-like.
- **Closing message refreshed** to make cross-device flow obvious:
  "Try on this machine: vibebook sync", then "On ANOTHER machine
  after vibebook init + vibebook sync: vibebook list-sessions +
  vibebook resume `<id>`".

## 0.6.0 — 2026-05-21

### BREAKING — Spool format simplified to single context.md per session

Pre-0.6: each session produced `.md` + `.raw.json` + `.jsonl` in the spool.
0.6: only `.md`, but the `.md` is now a *full conversation context* —
includes `tool_use` blocks, `tool_result` blocks, `thinking` blocks, and
YAML frontmatter with session metadata.

### BREAKING — `vibebook resume` mechanism changed

Pre-0.6: tried to inject jsonl into `~/.claude/projects/` so
`claude --resume <id>` would pick it up. Dogfooded on 2026-05-20 — doesn't
work cross-device because Claude Code reads more state than just the
jsonl file.

0.6: spawns a fresh `claude` session passing the prior session's context
markdown as the first user prompt. Claude reads it, acknowledges,
awaits next instruction. No reverse-engineering of Claude Code internals;
uses standard `claude [prompt]` public CLI.

### NEW commands / flags

- `vibebook resume <id-or-prefix> [--print] [--cwd <path>]` — shortId,
  prefix, or full UUID all accepted. `--print` skips spawn, prints the
  invocation for manual paste. `--cwd` overrides project-match validation.

### Drops

- `~/.vibebook/resume-forks.json` registry (no fork tracking needed)
- `IndexEntry.originSessionId` field (no longer written; still read for
  back-compat)
- jsonl + raw.json in spool (no longer written)
- `vibebook doctor` orphan-jsonl + oversized-jsonl checks (irrelevant
  when spool has no jsonl). New: 0.5.x residue check + fork-registry
  residue check, both with cleanup commands.

### Truncation

Large `tool_result` / `tool_use.input` blocks (>20 KB) are truncated in
the rendered `.md` to first 30 + last 10 lines (or first 4000 + last
1000 chars for single-line blocks), with a footer noting size. This
keeps long Chromium / Edge sessions (gigabytes of file reads) under
GitHub's 100 MB push limit. Override with `VIBEBOOK_FULL_TOOL_RESULTS=1`.

### Migration

- First `vibebook sync` after upgrade writes new-format `.md` *only* for
  sessions whose source jsonl mtime/sha changed. To force re-extract
  existing sessions in the new format:
  ```
  rm ~/.vibebook/session-repo/.vibebook/index.json
  vibebook sync
  ```
- Old `.raw.json` / `.jsonl` files in the spool aren't auto-deleted;
  `vibebook doctor` reports them with cleanup commands.
- `~/.vibebook/resume-forks.json` from 0.5.1 is dead; `doctor` reports it.
- vibebook-plugin needs no update — it already reads `.md` (just sees
  richer content now).

## 0.5.3 — 2026-05-20

Cross-device dogfood round 2 exposed the **CI aggregation workflow was
fundamentally broken**: it lived on the user's device branch but GitHub
Actions only resolves workflows from `main`. Every first-time push hit
`MODULE_NOT_FOUND` on the merge script. Fixed end-to-end in this release
along with three smaller follow-ups.

### Bug fixes

- **`vibebook workflow init` now installs to `origin/main`** via a temp
  worktree (instead of the user's device branch). This means the very
  first push after `vibebook init` triggers a fully-working CI run — no
  more cold-start `MODULE_NOT_FOUND`. The user's working tree, current
  branch, and uncommitted changes are untouched. Existing users with
  workflow/script copies on a device branch should clean those up; see
  the new `vibebook doctor` warning for the exact command.

- **`vibebook init` wizard now actually installs the workflow** when Q6
  (enable CI aggregation) is answered yes. Previously it just set the
  config flag and asked you to run `vibebook workflow init` later. Now
  it does both in one shot — main has the workflow before you ever push.

- **`merge-books.mjs` rendered strings are now localized.** The book
  index, project pages, and timeline page used to hard-code Chinese
  headings ("笔记本", "聚合自 N 台设备", "篇流水账", …). Now driven by
  `bookLocale: "en" | "zh"` in `~/.vibebook/config.json` (default `"en"`),
  substituted into the workflow yml at install time as `VIBEBOOK_LOCALE`.

- **`vibebook doctor` flags workflow residue on the device branch.** Pre-
  0.5.3 users probably still have `.github/workflows/vibebook-aggregate.yml`
  and `scripts/merge-books.mjs` checked in on their device branch. Doctor
  now points it out and prints the exact `git rm` + push commands to clean
  it up.

### Migration

Existing 0.5.x users:

1. `vibebook upgrade` to 0.5.3 (or `npm i -g vibebook@latest`).
2. `vibebook workflow init` — this time it pushes to `origin/main`,
   fixing your CI run. (Idempotent: safe to run even if you already
   manually seeded `main`.)
3. (Optional, but recommended) `vibebook doctor` will tell you if your
   device branch still has stale workflow + script copies, with the
   exact cleanup command.

## 0.5.2 — 2026-05-20

Dogfood pass on a second machine (mini2) exposed six small but real bugs
in 0.5.0 / 0.5.1. All fixed here. No schema changes.

### Bug fixes

- **`hasUnchanged()` now checks the file actually exists in the working tree.**
  Previously sync only compared source mtime + sha256, so after switching
  to a new device branch (where `raw_sessions/` is incomplete), sync looked
  at the still-committed `index.json` and skipped re-extracting — the new
  branch would stay perpetually incomplete. Now any missing indexed file
  is treated as stale.

- **Oversized jsonl no longer breaks `git push`.** When a Claude / Copilot
  session's `.jsonl` exceeds 95 MB, sync now skips the jsonl copy (still
  writes `.md` + `.raw.json` so the digest is intact) and warns. Files
  between 50 – 95 MB still copy but trigger a soft warning. Prevents the
  `GH001: Large files detected` push reject that 0.5.0 / 0.5.1 hit on
  long Copilot sessions in monorepo projects.

- **`vibebook doctor` reports oversized jsonl.** Scans the spool for
  `.jsonl > 50 MB` and shows the worst offenders, with a one-liner fix
  command when any of them exceed GitHub's 100 MB hard cap.

- **`init` wizard adopts plugin-first directories.** If the user installed
  `vibebook-plugin` first and the plugin wrote `book/` + `raw_sessions/`
  before the npm CLI was installed, init used to refuse with
  `"is not empty and is not a git repo"`. It now offers to `git init` in
  place + add the remote + create a fresh branch with the plugin data
  preserved as the first commit. Nothing is deleted or moved.

- **Stable device branch name.** `os.hostname()` on macOS drifts across
  networks (mDNS in home wifi → `Mac-mini-2.local`, corp DHCP → something
  like `MIS-EV2-BB1.surfacescenarios.org`, iPhone hotspot → another),
  causing sync to push to a new branch each time. Two fixes:
  - **Init wizard Q8**: explicitly ask for a stable device name and warn
    when the hostname default looks volatile.
  - **`vibebook config --device <name>`**: existing users can fix their
    config after the fact. Output prints the `git branch -D / git push
    --delete` commands to clean up any drift-created branches.
  - **`vibebook doctor`** flags drift-prone deviceBranch values.

### Migration note (0.4.x → 0.5.x)

If you're upgrading from a 0.4.x install, the first `vibebook upgrade`
will error with `Cannot find module '.../commands/plugin-install.js'`.
This is the old 0.4.x `upgrade.ts` (already loaded in the process) trying
to invoke a subcommand that 0.5.0 removed. The npm install half already
succeeded; **just run `vibebook upgrade` a second time** and it works.
No data loss either way.

## 0.5.1 — 2026-05-14

### NEW — Resume forks the session

`vibebook resume <sessionId>` now treats each resume as a **fork**:
the new copy on this device gets a fresh sessionId so two devices
resuming the same source session can continue in parallel without
clobbering each other when their spools sync up.

- A new `~/.vibebook/resume-forks.json` registry maps every freshly
  forked sessionId to its origin.
- The next `vibebook sync` stamps the origin onto the spool's index
  entry as `originSessionId`, so plugin-side digest tooling can later
  group same-source threads.
- `vibebook resume` output now shows the fork: `Session forked: abc123 → <new-uuid>`.

This closes the open design question from the v0.5.0 roadmap: "B 推回时怎么标记是 resumed-from-A".

## 0.5.0 — 2026-05-14

### BREAKING — Major slim, paired with the new vibebook plugin

`vibebook` 0.5.0 is **a deliberate amputation** of the npm package
to its sync transport responsibility. Digest + recall + the static
site renderer all moved to the Claude Code plugin at
[june9593/vibebook-plugin](https://github.com/june9593/vibebook-plugin).
The two products co-own the same `~/.vibebook/session-repo/` spool
with sessionId-keyed entries — install one, both, or neither.

If you used these commands in v0.4.x, they're gone:

| Removed | Where it lives now |
|---|---|
| `vibebook prepare` | Plugin (`/vibebook` skill drives this internally) |
| `vibebook publish` | Plugin |
| `vibebook recall` | Plugin (`/vibebook-recall` skill) |
| `vibebook serve` / `build-site` | Plugin (`/vibebook` site rendering) |
| `vibebook catalog-regen` | Plugin |
| `vibebook list-projects` | Plugin |
| `vibebook plugin-install` | Marketplace install: `/plugin install vibebook` |
| `init` Q5 (digest enabled), Q8 (memex), plugin-install side effect | Removed from wizard |

To recover digest + recall:

```text
/plugin marketplace add june9593/vibebook-plugin
/plugin install vibebook
```

Your existing `~/.vibebook/session-repo/` data continues to work
unchanged — the plugin reads it and writes its own additions there.

### BREAKING — Spool format adds original jsonl

Sync now preserves the original `.jsonl` from `~/.claude/projects/`
into the spool alongside the existing `.md` + `.raw.json`. This is
required by the new `vibebook resume` command.

**If you upgraded from v0.4.x:** your existing spool only has
`.md` + `.raw.json` — those sessions cannot be resumed across
machines. To enable resume retroactively:

```sh
rm -rf ~/.vibebook/session-repo/raw_sessions
vibebook sync
```

This re-renders all your local sessions and now also preserves
their original `.jsonl`. Bookmarks (the `book/` directory written
by the plugin) are unaffected and stay intact.

If you don't care about resuming pre-0.5 sessions, do nothing —
new sessions sync'd after the upgrade work for sync + push + the
plugin's chronicle digest. Old ones trigger a `vibebook doctor`
warning but otherwise behave normally.

### NEW — Cross-device session resume

Three new commands:

- `vibebook list-sessions [--project --since --device]` — find resumable sessions across all devices in the spool.
- `vibebook resume <sessionId>` — copy a spool session's jsonl into `~/.claude/projects/<encoded-cwd>/<id>.jsonl` and print the `cd <project> && claude --resume <id>` command to run.
- `vibebook config --map-path FROM=TO` — register a cross-device path translation (e.g. `/Users/yueA=/Users/yueB`) used by `resume` to rewrite jsonl paths.

Resume does NOT yet do fork bookkeeping (if both A and B resume the same session and continue, the diverging jsonls each ship at next sync). That's deferred to v0.5.1.

### Other changes

- `runner-check` removed (the runner abstraction died in v0.4.0 when digest moved to in-session Claude).
- `init-wizard` slimmed: 9 questions → 7. Closing message now suggests `/plugin install vibebook` for digest + recall.
- `doctor` checks for the vibebook plugin (`~/.claude/plugins/marketplaces/vibebook-plugin/`) and prints a `warn` line if missing. Also warns about `.raw.json` files without sibling `.jsonl` (pre-0.5 sessions that can't be resumed).
- `upgrade` no longer runs `plugin-install` at the end — recommends `/plugin update vibebook` instead.
- Config schema gains optional `pathMap?: Record<string, string>` for cross-device path translation.
- Test suite: 158 tests pass (down from 203 after removing tests for deleted commands; 17 new resume tests added).
