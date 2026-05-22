import type { SessionMessage, SessionManifest, ContentBlock } from "../types.js";

/** Cap on commits / files_touched / candidate_decisions to bound frontmatter
 *  size. files_touched dominates volume — a long debugging session can hit
 *  Read on 500+ files; we keep first-seen 200, which covers the dense
 *  early-session exploration without exploding YAML parse cost. */
const FILES_CAP = 200;
const COMMITS_CAP = 100;
const DECISIONS_CAP = 20;

/** Heuristic regex for "user signaled a decision here." Intentionally narrow
 *  — false positives waste the digest skill's attention more than false
 *  negatives. The skill is told these are candidates, not facts. */
const DECISION_RE = /(我决定|我们决定|最后采用|最后用|let'?s go with|decided to|going with|ok merged|merged it|ship it as)/i;

/** Match `git commit … -m "msg"` / `-m 'msg'` / heredoc commits. We also
 *  catch `git tag -a vX.Y.Z -m "…"` and bare `git tag <ver>` since releases
 *  matter for the digest. `git push` is excluded — it's procedural, not a
 *  decision point. */
const GIT_COMMIT_RE = /\bgit\s+commit\b[^\n]*?-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/;
const GIT_COMMIT_HEREDOC_RE = /\bgit\s+commit\b[^\n]*?-m\s+"\$\(cat\s+<<\s*'?(\w+)'?[\r\n]+([\s\S]*?)[\r\n]+\1\s*\)"/;
const GIT_TAG_RE = /\bgit\s+tag\b(?:[^\n]*?-(?:a|s)\s+)?\s*(v[\w.\-+]+)(?:[^\n]*?-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'))?/;

/** Tools whose input.file_path contributes to files_touched. */
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Extract a mechanical-facts SessionManifest from already-extracted
 * SessionMessages. Pure function — no I/O.
 *
 * @param messages SessionMessage[] in chronological order.
 * @param messageLineOffsets parallel array where messageLineOffsets[i] is the
 *   line number of the i-th message's `## User`/`## Assistant` heading in
 *   the final rendered md. Used to populate `line` fields so consumers can
 *   `Read offset:line` to jump straight to the source turn.
 */
export function extractManifest(
  messages: SessionMessage[],
  messageLineOffsets: number[],
): SessionManifest {
  const tools_used: Record<string, number> = {};
  const commits: { sha: string; msg: string; line: number }[] = [];
  const filesSeen = new Set<string>();
  const files_touched: string[] = [];
  const candidate_decisions: { line: number; preview: string }[] = [];
  let user_turns = 0;
  let assistant_turns = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const line = messageLineOffsets[i] ?? 0;

    if (m.role === "user") user_turns++;
    else if (m.role === "assistant") assistant_turns++;

    // Decision heuristic: user text only (assistants don't make decisions).
    if (m.role === "user" && m.text && DECISION_RE.test(m.text) && candidate_decisions.length < DECISIONS_CAP) {
      candidate_decisions.push({ line, preview: previewOf(m.text, 100) });
    }

    for (const b of m.contentBlocks ?? []) {
      if (b.type !== "tool_use") continue;
      tools_used[b.name] = (tools_used[b.name] ?? 0) + 1;

      if (FILE_TOOLS.has(b.name)) {
        const fp = readFilePath(b);
        if (fp && !filesSeen.has(fp) && files_touched.length < FILES_CAP) {
          filesSeen.add(fp);
          files_touched.push(fp);
        }
      }

      if (b.name === "Bash" && commits.length < COMMITS_CAP) {
        const cmd = readBashCommand(b);
        if (cmd) {
          const c = parseCommit(cmd);
          if (c) commits.push({ ...c, line });
          else {
            const t = parseTag(cmd);
            if (t) commits.push({ ...t, line });
          }
        }
      }
    }
  }

  return {
    user_turns,
    assistant_turns,
    tools_used,
    commits,
    files_touched,
    candidate_decisions,
  };
}

function readFilePath(b: Extract<ContentBlock, { type: "tool_use" }>): string | null {
  const input = b.input as { file_path?: unknown } | null;
  if (!input || typeof input !== "object") return null;
  return typeof input.file_path === "string" ? input.file_path : null;
}

function readBashCommand(b: Extract<ContentBlock, { type: "tool_use" }>): string | null {
  const input = b.input as { command?: unknown } | null;
  if (!input || typeof input !== "object") return null;
  return typeof input.command === "string" ? input.command : null;
}

function parseCommit(cmd: string): { sha: string; msg: string } | null {
  const h = cmd.match(GIT_COMMIT_HEREDOC_RE);
  if (h) {
    const body = (h[2] ?? "").trim();
    const firstLine = body.split("\n", 1)[0]!.trim();
    return firstLine ? { sha: "", msg: firstLine } : null;
  }
  const m = cmd.match(GIT_COMMIT_RE);
  if (!m) return null;
  const msg = (m[1] ?? m[2] ?? m[3] ?? "").trim();
  return msg ? { sha: "", msg } : null;
}

function parseTag(cmd: string): { sha: string; msg: string } | null {
  const m = cmd.match(GIT_TAG_RE);
  if (!m) return null;
  const tag = m[1]!;
  const msg = (m[2] ?? m[3] ?? "").trim();
  return { sha: tag, msg: msg || `tag ${tag}` };
}

function previewOf(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
}
