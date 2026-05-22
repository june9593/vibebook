export type Tool = "claude" | "copilot";

/** A single rich content block from the source jsonl. Mirrors the
 *  Anthropic API content block shape so renderers can produce markdown
 *  that captures the full conversation, including tool calls and results
 *  (which previous vibebook versions stripped).
 *
 *  Sources that don't expose tool data (e.g. Copilot Chat) emit only
 *  `text` and `thinking` blocks. Sources that do (Claude Code) emit
 *  the full set. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; name: string; input: unknown; id?: string }
  | { type: "tool_result"; content: string; toolUseId?: string };

export interface SessionMessage {
  role: "user" | "assistant" | "tool" | "system";
  /** Flat plain-text view, used for project inference + first-user-prompt
   *  detection. For messages with tool blocks this is just the text parts
   *  concatenated (no tool data). */
  text: string;
  /** Assistant reasoning / thinking content, flat string view. */
  reasoning?: string;
  /** Rich structured content from the source. When present, the markdown
   *  renderer uses this for full fidelity (tool_use, tool_result, etc.).
   *  When absent, the renderer falls back to text + reasoning fields. */
  contentBlocks?: ContentBlock[];
  timestamp?: string; // ISO 8601
  raw?: unknown;      // original message object for fidelity
}

export interface NormalizedSession {
  tool: Tool;
  sessionId: string;        // source-native id (e.g. Claude uuid)
  shortId: string;          // first 8 chars of sessionId
  project: string;          // human-readable project slug (e.g. "edge-memvc")
  projectRaw: string;       // original path or workspace hash
  startedAt: string;        // ISO 8601 of first message
  endedAt: string;          // ISO 8601 of last message
  nameSlug: string;         // derived from first user message (see slug.ts)
  displayName: string;      // un-slugged version for display
  messages: SessionMessage[];
  sourcePath: string;       // absolute path to original file
  /** When the project field was overridden by content-based inference (the
   *  session's tool-uses pointed to a different project than the cwd
   *  suggested), this records the original cwd-derived project so callers
   *  can audit and the chronicle can carry it as metadata. Absent on the
   *  default cwd-only path. */
  projectInferredFrom?: "content";
  cwdProject?: string;
}

export interface IndexEntry {
  sessionId: string;
  shortId: string;
  tool: Tool;
  project: string;
  /** Original cwd / workspace path the session ran in. Used to reverse-lookup
   *  "what project does the user's current shell belong to" for the project-mode
   *  /vibebook skill — the skill takes process.cwd() and finds the project slug
   *  whose entries' projectRaw matches. */
  projectRaw: string;
  startedAt: string;
  endedAt: string;
  nameSlug: string;
  displayName: string;
  relativePath: string;     // path inside repo
  sourcePath: string;       // original source file (for change detection)
  sourceMtimeMs: number;
  sourceSha256: string;
  /** When this entry was created by `vibebook resume <id>` on this device,
   *  the source device's sessionId. Set on next `vibebook sync` from the
   *  fork registry at ~/.vibebook/resume-forks.json. */
  originSessionId?: string;
}

export interface IndexFile {
  version: 1;
  entries: Record<string, IndexEntry>; // key = `${tool}:${sessionId}`
}

/** Mechanical-fact summary computed at write-time and embedded in the
 *  raw_sessions/*.md frontmatter as `manifest_version: 1` block. Consumers
 *  (digest skill, resume) read this to orient without scanning the body.
 *  Field semantics:
 *   - commits: distinct git commit/tag/push events extracted from Bash
 *     tool_use inputs. `line` is the absolute line number of the
 *     containing tool_use in the final rendered md.
 *   - files_touched: deduplicated union of file_paths from Read/Edit/Write/
 *     MultiEdit tool_uses. Order = first-seen. Capped at 200 to bound size.
 *   - tools_used: histogram of tool_use.name across the session.
 *   - candidate_decisions: user-text turns matching a small decision-marker
 *     keyword set (`我决定` / `decided to` / `let's go with` / `最后采用` /
 *     `ok merged`). Heuristic-only; the digest skill treats these as hints,
 *     not facts. Capped at 20. */
export interface SessionManifest {
  user_turns: number;
  assistant_turns: number;
  tools_used: Record<string, number>;
  commits: { sha: string; msg: string; line: number }[];
  files_touched: string[];
  candidate_decisions: { line: number; preview: string }[];
}

/** One row in the importance-based table-of-contents block. `line` is the
 *  absolute line number of the message's `## User`/`## Assistant` heading
 *  in the final rendered md. Markers (1-3 emojis) describe what makes the
 *  turn noteworthy: 🧑 real user msg, ✏️ file edit, 💾 commit/tag/push,
 *  🤖 substantive assistant reply. */
export interface TocEntry {
  turn: number;
  timestamp: string;
  markers: string;
  preview: string;
  line: number;
}
