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

/**
 * Heuristic: does the given branch name look like it came from macOS's
 * volatile hostname (mDNS in home wifi, corporate DHCP-given names on VPN,
 * iPhone tethering, etc.)? Used by the init wizard and doctor to nudge users
 * toward a stable physical-label name like "mini2" instead of letting their
 * spool grow a new device branch each time they change networks.
 *
 * Conservative: returns true (stable-looking) by default; we only flag
 * patterns we've actually seen drift in dogfood:
 *   - ends in `.local`               (Bonjour / mDNS, changes when DHCP renames host)
 *   - matches a fully-qualified DNS name (contains a `.` followed by 2+
 *     letters as a TLD) — e.g. `MIS-EV2-BB1.surfacescenarios.org`,
 *     `host42.corp.example.com`. These come from corp DHCP and rotate.
 */
export function isStableDeviceName(name: string): boolean {
  if (name.endsWith(".local")) return false;
  // FQDN-ish: contains `.`, ends in `.<letters>{2+}` (the TLD).
  if (/\.[A-Za-z]{2,}$/.test(name)) return false;
  return true;
}
