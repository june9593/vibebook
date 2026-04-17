export type Tool = "claude" | "copilot";

export interface SessionMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
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
}

export interface IndexEntry {
  sessionId: string;
  shortId: string;
  tool: Tool;
  project: string;
  startedAt: string;
  endedAt: string;
  nameSlug: string;
  displayName: string;
  relativePath: string;     // path inside repo
  sourcePath: string;       // original source file (for change detection)
  sourceMtimeMs: number;
  sourceSha256: string;
}

export interface IndexFile {
  version: 1;
  entries: Record<string, IndexEntry>; // key = `${tool}:${sessionId}`
}
