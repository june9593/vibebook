import { simpleGit } from "simple-git";
import { projectSlugFromPath } from "./slug.js";

/**
 * Canonical, path-INDEPENDENT project identity (P0a).
 *
 * Project memory must aggregate + recall correctly across devices, but the
 * same repo can live at a different filesystem path per machine
 * (`~/edge/memvc` vs `~/work/memvc` vs `~/projects/memvc`). The legacy slug =
 * `projectSlugFromPath` (last two path segments) splits those into different
 * projects, so raw_sessions folders / memory ids / book all diverge and never
 * aggregate. Coding projects are git-maintained, and a repo's `origin` remote
 * is identical on every clone — so the remote is the stable identity.
 *
 * `canonicalProjectId` collapses every remote URL form to one `host/path` id;
 * `resolveProjectId` turns a cwd into a filesystem/index-safe slug, preferring
 * the remote and falling back to the path slug when there's no git remote.
 */

/**
 * Normalize any git remote URL to a canonical `host/path` id, collapsing SSH
 * SCP (`git@host:org/repo.git`), `https://`, `ssh://`, `git://`, and
 * credentialed forms to the same value. Host is lowercased (clones don't drift
 * in host case); path case is preserved (org/repo can be case-significant).
 * Returns null for unparseable / local (no-host) remotes → caller falls back.
 *
 *   git@github.com:june9593/memvc.git           -> github.com/june9593/memvc
 *   https://github.com/june9593/memvc(.git)(/)  -> github.com/june9593/memvc
 *   https://x-token:abc@github.com/o/r.git      -> github.com/o/r
 *   ssh://git@gitlab.corp:22/grp/sub/proj.git   -> gitlab.corp/grp/sub/proj
 */
export function canonicalProjectId(remoteUrl: string | null | undefined): string | null {
  const s0 = (remoteUrl ?? "").trim();
  if (!s0) return null;

  let host: string;
  let path: string;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s0)) {
    // scheme://[user[:pass]@]host[:port]/path
    let rest = s0.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
    rest = rest.replace(/^[^@/]+@/, ""); // strip credentials
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    host = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  } else {
    // SCP-like: [user@]host:path  (reject host:port/... which isn't SCP)
    const m = s0.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
    if (!m) return null; // local path / junk → fallback
    if (/^\d+$/.test(m[2].split("/")[0])) return null; // host:port/path, not SCP
    host = m[1];
    path = m[2];
  }

  host = host.replace(/:\d+$/, "").toLowerCase(); // strip port, lowercase host
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!host || !path) return null;
  return `${host}/${path}`;
}

/** Filesystem/index-safe slug from a remote URL, or null if not parseable.
 *  `github.com/june9593/memvc` -> `github.com-june9593-memvc`. */
export function projectSlugFromRemote(remoteUrl: string | null | undefined): string | null {
  const id = canonicalProjectId(remoteUrl);
  if (!id) return null;
  return id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export interface ProjectIdentity {
  /** Filesystem/index-safe project slug used everywhere a project segment is stored. */
  slug: string;
  /** Where the slug came from. `remote` = stable cross-device; `path` = legacy fallback. */
  source: "remote" | "path";
  /** Canonical `host/path` (only when source === "remote"); null otherwise. */
  canonical: string | null;
}

/**
 * Resolve a cwd / repo-root to its stable project slug. Prefers the git
 * `origin` remote (path-independent → aggregates across devices); falls back to
 * the legacy `projectSlugFromPath` when there's no remote / not a git repo
 * (a non-git project has no cross-device identity anyway). `getRemote` is
 * injectable so the pure logic is testable without a real repo.
 */
export async function resolveProjectId(
  cwdOrRoot: string,
  getRemote: (dir: string) => Promise<string | null> = defaultGetRemote,
): Promise<ProjectIdentity> {
  let remote: string | null = null;
  try { remote = await getRemote(cwdOrRoot); } catch { remote = null; }
  const slug = projectSlugFromRemote(remote);
  if (slug) return { slug, source: "remote", canonical: canonicalProjectId(remote) };
  return { slug: projectSlugFromPath(cwdOrRoot), source: "path", canonical: null };
}

/** Read `remote.origin.url` at `dir` (or any ancestor git repo). Null if none. */
async function defaultGetRemote(dir: string): Promise<string | null> {
  try {
    const v = (await simpleGit(dir).getConfig("remote.origin.url")).value;
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}
