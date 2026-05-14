# Changelog

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
