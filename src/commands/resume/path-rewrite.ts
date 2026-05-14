/**
 * Path rewrite for cross-device resume.
 *
 * When a session jsonl is moved from machine A to machine B, absolute paths
 * embedded inside (cwd, tool_input.file_path, tool_result text, etc.) still
 * point at A's filesystem. We do a simple but boundary-aware string replace
 * driven by a user-configured pathMap.
 *
 * "Boundary-aware" means we only match prefixes followed by `/` or end-of-token,
 * so /Users/yueA does NOT accidentally rewrite /Users/yueA-archive.
 *
 * "Longest prefix wins" — useful when a user maps both a home dir and a
 * subpath of it to different destinations.
 */

export type PathMap = Record<string, string>;

export function rewriteJsonlPaths(content: string, pathMap: PathMap): string {
  if (Object.keys(pathMap).length === 0) return content;

  // Sort entries by source-prefix length descending so longer matches win.
  const entries = Object.entries(pathMap).sort(([a], [b]) => b.length - a.length);

  let out = content;
  for (const [from, to] of entries) {
    // Boundary: prefix must be followed by `/` (most common path separator)
    // OR a non-path-component character (quote, space, colon, end-of-string).
    // Use a regex that only matches when next char is one of those, so
    // /Users/yueA doesn't rewrite /Users/yueA-archive (where next char is '-').
    const fromEsc = escapeRegExp(from);
    const re = new RegExp(`${fromEsc}(?=[/"\\s:]|$)`, "g");
    out = out.replace(re, to);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
