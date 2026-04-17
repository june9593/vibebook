# memvc — Memory of Vibe Coding

Sync your AI coding sessions (Claude Code, VS Code Copilot Chat) across machines
via a private Git repo. Manual, transparent, encryption-optional.

## Install

    npm install -g memvc

## Setup

    memvc init git@github.com:you/your-memory-repo.git
    # optional: --encrypt  (then export MEMVC_PASSPHRASE=...)

## Daily use

    memvc sync          # extract + commit + push
    memvc list          # show synced sessions
    memvc show <ref>    # dump one session as Markdown

## Layout

    work-memory/
      raw_sessions/
        <tool>/<project>/<YYYY-MM-DD>/<slug>__<shortId>.raw.json
        <tool>/<project>/<YYYY-MM-DD>/<slug>__<shortId>.md
      .memvc/index.json
      summaries/     (future: hand-written or LLM-generated digests)
      decisions/     (future: ADRs)

## Security

- Repo MUST be private. Enable GitHub secret scanning + push protection.
- `--encrypt` uses AES-256-GCM with scrypt KDF from `MEMVC_PASSPHRASE`.
- Passphrase is never stored on disk.
