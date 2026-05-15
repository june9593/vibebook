# vibebook

Cross-device sync for your AI coding sessions.

`vibebook` is the npm CLI half of a two-package system. It collects
Claude Code + VS Code Copilot Chat sessions on every machine you use,
pushes them to a private git repo, and lets you `resume` a session
on a different laptop than where it started.

For digest + recall (chronicles, topics, "what did past-me figure out"
queries), install the **Claude Code plugin**:

```text
/plugin marketplace add june9593/vibebook-plugin
/plugin install vibebook
```

The plugin is independent — install it without the npm CLI if you only
work on one machine. Install both if you want sync + digest.

## Install

```sh
npm install -g vibebook
vibebook init
```

The wizard walks you through:

1. **Sync to a remote git repo?** (yes/no — local-only is also valid)
2. **Repo URL** + local checkout path
3. **Encrypt raw sessions before commit?** (git-crypt filter, transparent)
4. **Passphrase** (saved at `~/.vibebook/passphrase` mode 0600)
5. **Enable CI cross-device aggregation?** (GitHub Actions merges device branches into main)
6. **Include assistant reasoning in synced markdown?** (recommended ON for ≥400K-context models)

After init, push your sessions:

```sh
vibebook sync
```

## Cross-device resume (NEW in 0.5.0)

Once you've sync'd from machine A, machine B can resume a session that
started on A:

```sh
# On machine B (after `vibebook sync` pulls A's session-repo):
vibebook list-sessions --since 7d           # Find sessions from this week
vibebook resume <sessionId>                  # Copy jsonl + emit `claude --resume` hint
```

If A and B have different home dir layouts (e.g. `/Users/yueA` vs
`/Users/yueB`), tell vibebook how to translate paths once:

```sh
vibebook config --map-path /Users/yueA=/Users/yueB
```

After that, `vibebook resume` rewrites all absolute paths in the jsonl
during copy, so `claude --resume` lands in the right local cwd.

Each resume is a **fork** — B gets a fresh sessionId so you can
continue on B without colliding with A if A also keeps chatting on
the same source session. The fork's origin is recorded in
`~/.vibebook/resume-forks.json` and stamped onto the spool index entry
on the next `vibebook sync` (as `originSessionId`), so plugin-side
digest tooling can later reason about same-source threads.

## Commands

| Command | What it does |
|---|---|
| `vibebook init` | Interactive wizard. One-time setup. |
| `vibebook sync` | Extract local sessions, push to your device branch. |
| `vibebook list-sessions [--project --since --device]` | List sessions in spool, sortable for resume. |
| `vibebook resume <sessionId>` | Copy jsonl into `~/.claude/projects/`, print `claude --resume` hint. |
| `vibebook config [--map-path FROM=TO]` | Read or modify `~/.vibebook/config.json`. |
| `vibebook upgrade` | `npm install -g vibebook@latest`. |
| `vibebook doctor` | Health check: CLI, config, spool state, plugin install status. |
| `vibebook crypt <init\|verify>` | Wire up the git-crypt filter for encrypted raw sessions. |
| `vibebook workflow <init\|...>` | Install GitHub Actions for cross-device aggregation. |
| `vibebook list` | List sessions in spool (simple table). |
| `vibebook show <ref>` | Print one session's markdown to stdout. |
| `vibebook cat <path>` | Print one file from the spool to stdout. |

## Files written

- `~/.vibebook/config.json` — your settings (`mode 0600`)
- `~/.vibebook/passphrase` — git-crypt passphrase if encryption enabled (`mode 0600`)
- `~/.vibebook/session-repo/` — git working tree of your private memory repo
  - `raw_sessions/<tool>/<project>/<date>/*.{md,raw.json,jsonl}` — sync-rendered session copies plus the original jsonl (preserved for resume)
  - `.vibebook/index.json` — spool index (co-owned with the plugin)
  - `book/` and `.vibebook/index.book.json` — written by the plugin if you have it installed

The npm CLI does not touch `book/` or `.vibebook/index.book.json` — those
are the plugin's domain. The plugin in turn does not touch `.git/`,
`config.json`, `passphrase`, or `repo-salt.json` — those are sync's.

## Migration from v0.4.x

If you upgraded from v0.4.x and miss `vibebook prepare` / `publish` /
`recall` / `serve` / `build-site` — those moved to the Claude Code plugin.
Install it as shown at the top of this README. Your existing
`~/.vibebook/session-repo/` data is unchanged; the plugin reads it and
writes its own additions there.

### Note for v0.4.x upgraders: spool format adds original jsonl

Sync now preserves the original `.jsonl` from `~/.claude/projects/`
into the spool alongside `.md` + `.raw.json`. This is required by
`vibebook resume`. Existing pre-0.5 sessions in your spool only have
`.md` + `.raw.json` — those cannot be resumed across machines. To
enable resume retroactively:

```sh
rm -rf ~/.vibebook/session-repo/raw_sessions
vibebook sync
```

This re-renders all your local sessions and now also preserves their
original `.jsonl`. Bookmarks (the `book/` directory written by the
plugin) are unaffected and stay intact.

If you don't care about resuming pre-0.5 sessions, do nothing — new
sessions sync'd after the upgrade work for resume; old ones trigger a
`vibebook doctor` warning but otherwise behave normally.

See [CHANGELOG](./CHANGELOG.md) for the full breaking-change list.

## Repo layout (for contributors)

- `src/` — TypeScript source
  - `commands/` — one file per CLI subcommand
  - `commands/resume/` — list-sessions, resume, path-rewrite, config-pathmap
  - `digest/{project-filter,session-signal}.ts` — sync-side filtering helpers (the rest of the dir was moved to the plugin)
  - `sources/` — Claude Code + Copilot adapters (sync uses both)
- `tests/` — vitest, parallel structure to src/
- `assets/{workflows,scripts}` — GitHub Actions YAML + cross-device aggregate script
- `bin/vibebook.ts` — commander entry, built to `dist/bin/vibebook.js`

## License

MIT
