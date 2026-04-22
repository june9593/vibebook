# vibebook — Vibe Coding Memory Book

Sync your AI coding sessions (Claude Code, VS Code Copilot Chat) across machines
via a private Git repo. Manual, transparent, encryption-optional.

## Install

    npm install -g vibebook

## Setup

Run the interactive wizard:

    vibebook init

The wizard asks:
1. **Repo URL** — your private memory repo (will be cloned if not present)
2. **Local path** — defaults to `./.vibebook/repo`
3. **Encrypt?** — y/n; if y, asks for a passphrase saved to `~/.vibebook/passphrase` (mode 0600)
4. **Digest into a book?** — y/n
5. **Runner** — local Claude CLI today; GitHub Action coming soon
6. **Model** — blank for runner default
7. **Verify** — checks `claude --version`; offers a real test call

Flag mode (CI-friendly): pass any of `--local-path / --encrypt / --no-digest / --device / --passphrase` (or a positional `<repoUrl>`) and the wizard is bypassed.

    vibebook init git@github.com:you/your-memory-repo.git --encrypt --passphrase secret

## Daily use

    vibebook sync          # extract + commit + push
    vibebook list          # show synced sessions
    vibebook show <ref>    # dump one session as Markdown

## Layout

    work-memory/
      raw_sessions/
        <tool>/<project>/<YYYY-MM-DD>/<slug>__<shortId>.raw.json
        <tool>/<project>/<YYYY-MM-DD>/<slug>__<shortId>.md
      .vibebook/index.json
      summaries/     (future: hand-written or LLM-generated digests)
      decisions/     (future: ADRs)

> Note: legacy repos initialized before v0.2 had this dir as `.memvc/`. The
> first `vibebook sync` run on such a repo automatically renames it via
> `git mv` (preserving history) and stages the rename in the next commit.

## Security

- Repo MUST be private. Enable GitHub secret scanning + push protection.
- `--encrypt` uses AES-256-GCM with scrypt KDF from `VIBEBOOK_PASSPHRASE`.
- Passphrase is never stored on disk.

## Per-device branches (v0.2+)

Each machine pushes to its own branch named after `os.hostname()` (sanitized).
`main` is left empty and serves only as an aggregation target. To see chats
from machine `yuedeMacBook-Pro-2.local`, check out that branch on the remote.

Override the auto-derived name:

    vibebook init <repoUrl> --device mbp2

Existing repos initialized before v0.2 will auto-migrate on the next `vibebook sync`:
the local `main` branch is renamed to `<device>`, and a fresh unborn `main` is left
for you to use as a merge target.

## Run digest in GitHub Actions

If you'd rather not burn local Claude credits / cycles, vibebook can run the digest pipeline inside a GitHub Action using **GitHub Models** (free for personal accounts) as the LLM.

```bash
# One-time setup inside your vibebook repo:
vibebook workflow init
cd ~/memvc-repo  # or wherever your vibebook repo lives
git add .github/workflows/vibebook-digest.yml
git commit -m "add vibebook digest workflow"
git push
```

If your config has `encrypt: true`, also set the **VIBEBOOK_PASSPHRASE** repo secret (Settings → Secrets and variables → Actions → New repository secret). The salt is auto-written to `.vibebook/repo-salt.json` during `vibebook init` (or backfilled by `vibebook sync` on legacy repos) and is safe to commit (security relies on the passphrase, not the salt).

The workflow runs on:
- Every `push` to a device branch (default patterns: `*.lan`, `*-pro`, `*-mbp`, `*-MBP*`, `*-pc`, `*-laptop`). Edit the workflow if your hostname doesn't match.
- Manual `workflow_dispatch` from the **Actions** tab.

It uses model `openai/gpt-4o-mini` by default — change `runnerModel` in the workflow if you want a different one (see [GitHub Models catalog](https://github.com/marketplace?type=models)).
