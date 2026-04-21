import { createInterface, Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * Minimal readline-promise wrapper. Caller closes the rl interface via
 * `closePrompts()` once all questions are asked. Helpers below all use the
 * SAME shared rl so they stay synchronous-feeling for the user.
 */
let _rl: Interface | undefined;
function rl(): Interface {
  if (!_rl) _rl = createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
export function closePrompts(): void {
  if (_rl) {
    _rl.close();
    _rl = undefined;
  }
}

/** Free-text input. Returns empty string on EOF / Ctrl-D. */
export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const ans = (await rl().question(`${question}${suffix}: `)).trim();
  return ans || defaultValue || "";
}

/** y/n → true/false. Default applies on empty input. */
export async function promptYesNo(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  for (;;) {
    const ans = (await rl().question(`${question} ${hint}: `)).trim().toLowerCase();
    if (!ans) return defaultYes;
    if (ans === "y" || ans === "yes") return true;
    if (ans === "n" || ans === "no") return false;
    console.log(`  please answer y or n`);
  }
}

/** Pick from labeled options. Returns the value of the chosen option. */
export async function promptChoice<T extends string>(
  question: string,
  options: { value: T; label: string; description?: string }[],
  defaultIndex = 0,
): Promise<T> {
  console.log(question);
  for (let i = 0; i < options.length; i++) {
    const o = options[i]!;
    const marker = i === defaultIndex ? "*" : " ";
    const desc = o.description ? `  — ${o.description}` : "";
    console.log(`  ${marker} ${i + 1}) ${o.label}${desc}`);
  }
  for (;;) {
    const raw = (await rl().question(`Choose [1-${options.length}, default ${defaultIndex + 1}]: `)).trim();
    if (!raw) return options[defaultIndex]!.value;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.value;
    console.log(`  please enter a number 1-${options.length}`);
  }
}

/**
 * Hidden input (passphrase). Disables echo by writing the question, then
 * temporarily silencing stdout writes from readline echo via a write-shim.
 * Falls back to plain prompt if stdin isn't a TTY.
 */
export async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return prompt(question);
  const r = rl();
  // Hack: monkey-patch _writeToOutput so each keystroke writes "*".
  // This is the standard Node.js trick for hidden input via readline.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyR = r as any;
  const origWrite = anyR._writeToOutput?.bind(anyR);
  anyR._writeToOutput = (s: string) => {
    if (s.includes(question)) origWrite(s);
    else origWrite("*".repeat(s.length));
  };
  try {
    const ans = await r.question(`${question}: `);
    process.stdout.write("\n");
    return ans;
  } finally {
    if (origWrite) anyR._writeToOutput = origWrite;
  }
}
