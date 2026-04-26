# vibebook — Vibe Coding Memory Book

Sync your AI coding sessions (Claude Code, VS Code Copilot Chat) across machines
via a private Git repo, then digest them into a per-project book of
**chronicles**, **topics**, and **cards** — written by an in-session Claude via
the `/vibebook` slash command. The CLI never spawns an LLM.

- **chronicles** — one diary entry per thread (5W: What / Why / How / Outcome)
- **topics** — mid-grain knowledge pages, full-rewritten as understanding grows
- **cards** — atomic, non-obvious insights (memex-style); `_global/` for
  cross-project ones (git, OS, generic patterns)

Per-project isolation is enforced: edge-src content stays in `book/edge-src/`,
never crosses into other projects. Quality > speed > token cost.

## Install

    npm install -g vibebook

Or install as a Claude Code plugin (ships skill + Stop hook + slash command):
add `june9593/vibebook` from the marketplace.

## Setup

    vibebook init

The interactive wizard asks:

0. **Sync to a remote?** — pick `no` for local-only mode (no remote, no encrypt, no CI).
1. **Repo URL** — your private memory repo (cloned if not present).
2. **Local path** — defaults to `./.vibebook/repo`.
3. **Encrypt?** — y/n; AES-256-GCM with scrypt KDF.
4. **Passphrase** — saved to `~/.vibebook/passphrase` (mode 0600).
5. **Digest into a book?** — y/n.
6. **Claude model** — blank for whatever `claude -p` defaults to.
7. **Enable CI cross-device aggregation?** — opt-in GitHub Actions merge.
8. **Include reasoning in synced md?** — recommended ON for ≥400K-context
   models, OFF for smaller (adds 30–100% to md size).

Flag mode (CI-friendly): pass any of `--local-path / --encrypt / --no-digest /
--device / --passphrase` (or a positional `<repoUrl>`) to skip the wizard.

    vibebook init git@github.com:you/your-memory-repo.git --encrypt --passphrase secret

## Daily use

    vibebook sync          # extract Claude/Copilot sessions, commit + push to your device branch
    cd <repo> && claude    # open Claude Code (cwd doesn't matter — vibebook reads its config)
    /vibebook              # in-session: digests new sessions into chronicle/topics/cards

`vibebook sync` is **pure raw sync** — no LLM call. The writing happens
in-session under the `/vibebook` skill, where Claude has the full project
context and can ask you clarifying questions.

Other commands:

    vibebook list          # show synced sessions
    vibebook show <ref>    # dump one session as Markdown
    vibebook prepare       # JSON output: which sessions need digesting (used by /vibebook)
    vibebook publish       # consume JSON: write chronicle/topic/card files + commit

## Repo layout

    work-memory/
      raw_sessions/<tool>/<project>/<YYYY-MM-DD>/<slug>__<shortId>.{raw.json,md}
      .vibebook/
        index.json         # raw-session catalog (per-device)
        index.book.json    # book index v2: chronicles, topics, cards
        repo-salt.json     # crypto material (only when --encrypt)
      book/
        <project>/
          chronicle/<YYYY-MM-DD>__<threadId>__<short>.md
          topics/<slug>.md             (or .<device>.md after merge)
          cards/<slug>.md
          index.md
        _global/cards/<slug>.md        # cross-project insights
        _meta/timeline.md
        index.md

Legacy repos initialized before v0.2 had `.memvc/`. The first `vibebook sync`
auto-renames via `git mv` (preserving history).

## Per-device branches

Each machine pushes to its own branch named after `os.hostname()` (sanitized).
`main` is left empty and serves only as the aggregation target.

Override the auto-derived name:

    vibebook init <repoUrl> --device mbp2

## Aggregate across devices (GitHub Actions, no LLM)

If you said yes to Q7, install the aggregation workflow:

    vibebook sync             # push sessions FIRST
    vibebook workflow init    # writes .github/workflows/vibebook-aggregate.yml + scripts/merge-books.mjs

From then on, every push to a non-`main` branch triggers the workflow, which
deterministically merges every device's `book/` into `main`:

- **chronicles** — deduped by `threadId`; latest `updatedAt` wins.
- **topics** — preserved per-device as `<slug>.<device>.md` (rewrites diverge
  in voice; mechanical merge would garble both).
- **cards** — unioned by `(project, slug)`; collisions resolve to latest
  `updatedAt`. `_global/cards/` unioned unconditionally.
- **catalog** — `book/index.md`, `book/_meta/timeline.md`, and per-project
  `index.md` regenerated.

No GitHub secrets needed — workflow uses default `GITHUB_TOKEN` and doesn't
call any external services.

## Security

- Repo MUST be private. Enable GitHub secret scanning + push protection.
- `--encrypt` uses AES-256-GCM with scrypt KDF from `VIBEBOOK_PASSPHRASE`.
- Passphrase is never stored in the repo.

### How encryption works (v0.2+)

vibebook wires a **git clean/smudge filter** when you enable encryption. The
working tree always shows plaintext `.md` / `.raw.json`; only git's object
database (and therefore the remote) holds ciphertext. So:

- `vibebook sync` writes plaintext → `git add` runs the clean filter → blob
  in `.git/objects` is encrypted → push uploads ciphertext.
- `git clone` / `git pull` downloads ciphertext → smudge filter runs on
  checkout → working tree shows plaintext.
- The `/vibebook` skill, your editor, and `cat` all see plaintext directly.
  No `.md.enc` files anywhere in the working tree.

Wiring is automatic on `vibebook init` and idempotently re-applied by every
`vibebook sync`. To wire it manually (e.g., on a fresh clone), run:

    vibebook crypt init     # wires clean/smudge in .git/config + commits .gitattributes line
    vibebook crypt status   # check whether filter is wired in this clone

The IV is **deterministic** (`HMAC-SHA256(key, plaintext)[:12]`) so identical
plaintext yields identical ciphertext — required to keep `git diff` clean
when nothing changed. Trade-off: an attacker with a candidate plaintext can
confirm the guess. Acceptable for AI conversation transcripts in a private
repo, not acceptable for high-value secrets.
