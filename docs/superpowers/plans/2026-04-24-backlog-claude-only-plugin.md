# Backlog: Claude-only "session digest" plugin (post-vibebook spinoff)

**Status:** idea, captured 2026-04-24

## Context

vibebook v0.2 ships as both an npm CLI (`vibebook init` / `sync` / `prepare` /
`publish`) AND a Claude Code plugin (`/vibebook` slash command + skill + Stop
hook). The CLI deliberately covers two source types:

- Claude Code (`~/.claude/projects/<cwd>/<sessionId>.jsonl`)
- VS Code Copilot Chat (`~/Library/Application Support/Code/User/...`)

That dual-source story makes sense for the **CLI** — users sync from whichever
tool(s) they actually use.

## The spinoff idea

For the **marketplace plugin** we'd publish to Claude Code's plugin
marketplace, drop Copilot entirely. Reasoning:

- The marketplace audience is Claude Code users by definition. Copilot
  support is dead weight for them.
- A narrower scope = a sharper pitch ("digest your Claude sessions into a
  per-project book") and a smaller surface to maintain.
- A Claude-only plugin can lean harder on Claude Code conventions: read
  jsonl directly from `~/.claude/projects/`, no need for a config file
  describing where Copilot data lives, no decryption layer (Claude jsonl
  isn't encrypted at rest by default).

## What that plugin would actually be

A self-contained Claude Code plugin (no npm dependency) that:

1. **Scans** `~/.claude/projects/` for jsonl since last digest.
2. **Renders** sessions to markdown in-memory (port of vibebook's
   `claude-code.ts` minus the encrypt path).
3. **Triggers** the same `/vibebook`-style skill workflow:
   chronicle / topics / cards per project, with `_global/cards/`.
4. **Writes** to a user-chosen `book/` directory (could be a git repo or
   just a plain folder — no mandatory remote).
5. **Optional**: a Stop hook that nudges "💡 run /digest" when a session
   ends.

## Open questions

- **Name?** Not "vibebook" — that's the dual-source CLI. Maybe
  "claude-codex" or "session-codex" or "vibe-codex". Branding TBD.
- **Per-device sync?** Probably skip. Plugin = single-machine. Users who
  want cross-device get the full vibebook CLI.
- **How much code reuse with vibebook?** The skill + commands/vibebook.md +
  hooks/session-end.sh are essentially identical. Could publish as a
  separate plugin pointing at the same skill content, or live in this
  repo as a second `.claude-plugin/` entry.
- **Encryption?** Drop. Plugin scope = "my own sessions on my own
  machine". Users who need encrypted git sync get the CLI.

## Why not just ship vibebook plugin as-is to marketplace

vibebook plugin currently *requires* the npm CLI to be installed (the skill
calls `vibebook prepare` / `vibebook publish`). For a marketplace install
we'd want zero npm dependency — the plugin should work standalone.

That's the actual engineering work: re-implement prepare/publish in pure
JavaScript inside the plugin, reading Claude jsonl directly from
`~/.claude/projects/`.

## Decision (if/when we pick this up)

Probably do it as a separate plugin in a separate repo. Keeps vibebook
focused on the "sync across machines + dual-source" story; the new plugin
focused on "Claude-only zero-config digest". Two products, two audiences.
