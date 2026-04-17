import type { NormalizedSession } from "../types.js";

export interface SourceAdapter {
  name: "claude" | "copilot";
  /** Scan the local filesystem and yield every session found. */
  discover(): AsyncIterable<DiscoveredSession>;
}

export interface DiscoveredSession {
  sourcePath: string;
  sourceMtimeMs: number;
  sourceSha256: string;
  /** Lazy: parse and normalize on demand (keeps memory low for huge corpora). */
  load(): Promise<NormalizedSession>;
}
