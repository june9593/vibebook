const SIGNAL_CATEGORIES: Record<string, string[]> = {
  debugging: ["bug", "error", "fix", "debug", "root cause", "traceback", "broken", "问题", "修复"],
  architecture: ["architecture", "design", "pattern", "trade-off", "decision", "approach", "架构", "设计"],
  discovery: ["learned", "discovered", "insight", "gotcha", "trap", "pitfall", "trick", "发现", "陷阱", "关键"],
  reasoning: ["because", "instead of", "rather than", "why", "the reason", "原因", "所以", "因为"],
  evaluation: ["review", "evaluate", "score", "verdict", "assessment", "评估", "审查"],
};

export interface SessionSignals {
  title: string;
  preview: string;
  insightScore: number;
}

/**
 * Extract per-session signals from a rendered session .md body.
 * Pure; no IO.
 *
 * The .md body is produced by `src/writer.ts` and looks like:
 *   # <displayName>
 *   **Tool:** ... etc
 *   ---
 *   ## User _(timestamp)_
 *   <text>
 *   ## Assistant _(timestamp)_
 *   <text>
 *   ## User _(timestamp)_
 *   ...
 *
 * We extract user-message text only (assistant is too noisy for a topic preview).
 */
export function extractSessionSignals(mdBody: string): SessionSignals {
  const userTexts = extractUserTexts(mdBody);
  const joined = userTexts.join(" ").replace(/\s+/g, " ").trim();

  const titleSrc = userTexts[0] ?? "";
  const titleClean = titleSrc.replace(/\s+/g, " ").trim();
  const title = titleClean.length > 80 ? titleClean.slice(0, 80) : titleClean;

  const preview = joined.length > 300 ? joined.slice(0, 300) + "…" : joined;

  const score = scoreText(joined, userTexts.join(" ").length, mdBody.length);

  return { title, preview, insightScore: score };
}

/** Pull text from every "## User" block. Stops at the next "## " heading. */
function extractUserTexts(md: string): string[] {
  const out: string[] = [];
  const lines = md.split("\n");
  let inUser = false;
  let buf: string[] = [];
  for (const line of lines) {
    if (/^## User\b/.test(line)) {
      if (buf.length > 0) {
        out.push(buf.join("\n").trim());
        buf = [];
      }
      inUser = true;
      continue;
    }
    if (/^## /.test(line)) {
      if (inUser && buf.length > 0) {
        out.push(buf.join("\n").trim());
        buf = [];
      }
      inUser = false;
      continue;
    }
    if (inUser) buf.push(line);
  }
  if (inUser && buf.length > 0) out.push(buf.join("\n").trim());
  return out.filter((s) => s.length > 0);
}

function scoreText(joinedLower: string, userTextLen: number, totalLen: number): number {
  if (!joinedLower) return 0;
  const lower = joinedLower.toLowerCase();
  let categoryHits = 0;
  let totalHits = 0;
  for (const keywords of Object.values(SIGNAL_CATEGORIES)) {
    const hits = keywords.filter((kw) => lower.includes(kw)).length;
    if (hits > 0) {
      categoryHits++;
      totalHits += hits;
    }
  }
  if (categoryHits < 2) return 0.1;
  const userRatio = userTextLen / Math.max(totalLen, 1);
  const score = (categoryHits / 5) * 0.4 + (totalHits / 15) * 0.3 + userRatio * 0.3;
  return Math.min(1.0, score);
}
