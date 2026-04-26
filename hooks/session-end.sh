#!/usr/bin/env bash
# vibebook Stop hook — non-blocking nudge.
#
# Fires at the end of every Claude Code session. Suggests the user run
# /vibebook to digest this session (and any others not yet in the book).
# Never fails the turn — exits 0 unconditionally.
{
  echo "💡 vibebook: run \`vibebook sync\` then /vibebook to add this session to your book"
} 2>/dev/null || true
exit 0
