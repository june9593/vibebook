import { hostname } from "node:os";

/**
 * Make `raw` safe for use as a git branch name.
 * Keeps [A-Za-z0-9._-]; replaces everything else with '-'; collapses runs of '-';
 * trims leading/trailing '-' or '.'; caps length at 60.
 * Falls back to "device" if empty after sanitize.
 */
export function sanitizeBranchName(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9._-]/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/\.+/g, ".");
  s = s.replace(/^[-.]+|[-.]+$/g, "");
  if (s.length === 0) return "device";
  if (s.length > 60) s = s.slice(0, 60).replace(/[-.]+$/, "");
  if (s.endsWith(".lock")) s = s.slice(0, -5).replace(/[-.]+$/, "");
  if (s.length === 0) return "device";
  return s;
}

export function deviceBranchFromHostname(): string {
  return sanitizeBranchName(hostname());
}
