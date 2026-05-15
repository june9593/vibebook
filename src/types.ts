export type Tool = "claude" | "copilot";

export interface SessionMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  /** Assistant reasoning / thinking content. Surfaced where the source
   *  preserves it as plaintext (Copilot's reasoningText field; rare cases
   *  in Claude CLI). Rendered as a `> 💭` blockquote in the md so the
   *  summarizing LLM can distinguish it from the actual assistant reply. */
  reasoning?: string;
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
