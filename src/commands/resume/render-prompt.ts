import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexEntry } from "../../types.js";

/** macOS default ARG_MAX is 1 MB total args; Linux often higher. We use a
 *  conservative cap matching the smaller platform, leaving 10% headroom.
 *  The full prompt body + framing must fit under this; otherwise we fall
 *  back to writing the prompt to /tmp and asking Claude to Read it. */
export const ARG_MAX_BYTES = 256 * 1024;

export interface PromptCtx {
  device?: string;
}

/** Build the user-prompt text we'll feed Claude as the first turn. */
export function renderResumePrompt(
  entry: IndexEntry,
  contextMd: string,
  ctx: PromptCtx = {},
): string {
  return [
    `I had a coding session on another machine that I'd like to continue.`,
    `Below is the full conversation history. Read it carefully — pay`,
    `attention to what files were touched, what was decided, and any open`,
    `questions or TODOs at the end. Then summarize back to me what state`,
    `we're in, and ask me what I'd like to do next.`,
    ``,
    `---`,
    `Session: ${entry.displayName}`,
    `Source device: ${ctx.device ?? "(unknown)"}`,
    `Started: ${entry.startedAt}`,
    `Ended: ${entry.endedAt}`,
    `---`,
    ``,
    contextMd,
    ``,
    `---`,
    `End of prior session. What's our next step?`,
  ].join("\n");
}

/** Decide how to pass the prompt to claude. Short prompts go via argv
 *  (`claude "prompt"`); long ones get spilled to /tmp and Claude reads
 *  them with its Read tool. The threshold leaves 10% headroom under
 *  ARG_MAX_BYTES so other argv components have room. */
export function chooseInvocation(prompt: string, shortId: string): string[] {
  if (Buffer.byteLength(prompt, "utf8") < ARG_MAX_BYTES * 0.9) {
    return ["claude", prompt];
  }
  const tmpPath = join(tmpdir(), `.vibebook-resume-${shortId}.md`);
  writeFileSync(tmpPath, prompt, "utf8");
  return ["claude", `Read ${tmpPath} and act on the instructions there.`];
}
