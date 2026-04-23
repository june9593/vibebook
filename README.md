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

## Aggregate book/ across devices (GitHub Actions)

When you run `vibebook sync` on each of your machines, each one pushes to its
own device branch (named after `os.hostname()`). To see **one unified book**
that merges every machine's articles into `main`, use the built-in CI
aggregation workflow.

The workflow does NOT run an LLM — threading / article / chapter generation
happens locally on each device when you `vibebook sync` there. CI just does
a deterministic merge:

- Articles from every device are deduped by `threadId`; the latest-updated
  version wins.
- Each device keeps its own `chapter.md` alongside the others, stored as
  `book/<project>/chapter.<device>.md`, so no device overwrites another.
- `book/index.md` and `book/_meta/timeline.md` are regenerated to list every
  article across every device.

### Setup order (matters)

```bash
# 1. Push your sessions FIRST. CI doesn't fire yet (workflow yaml not on remote).
vibebook sync

# 2. Install the aggregation workflow + push it. THIS push triggers CI for
#    the first time, and the repo already has sessions ready to aggregate.
vibebook workflow init
```

`workflow init` writes two files into your repo and auto-commits + pushes them:

- `.github/workflows/vibebook-aggregate.yml`
- `scripts/merge-books.mjs`

From then on, every push to any non-`main` branch triggers the workflow, which
clones `main`, runs `merge-books.mjs`, and pushes the aggregated `book/` back
to `main`. Manual run also available via the **Actions** tab →
`workflow_dispatch`.

No GitHub secrets needed — the workflow uses the default `GITHUB_TOKEN` for
pushing to `main` and doesn't call any external services.
