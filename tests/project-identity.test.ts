import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProjectId, projectSlugFromRemote, resolveProjectId, resolveProjectIdSync, cachedProjectSlug } from "../src/project-identity.js";

describe("canonicalProjectId — collapses every remote form to host/path", () => {
  const cases: [string, string | null][] = [
    // the same repo via every common form → ONE id
    ["git@github.com:june9593/memvc.git", "github.com/june9593/memvc"],
    ["https://github.com/june9593/memvc.git", "github.com/june9593/memvc"],
    ["https://github.com/june9593/memvc", "github.com/june9593/memvc"],
    ["https://github.com/june9593/memvc/", "github.com/june9593/memvc"],
    ["ssh://git@github.com/june9593/memvc.git", "github.com/june9593/memvc"],
    ["git://github.com/june9593/memvc.git", "github.com/june9593/memvc"],
    // credentials stripped
    ["https://x-access-token:ghp_abc@github.com/june9593/memvc.git", "github.com/june9593/memvc"],
    // self-hosted, port, nested groups
    ["ssh://git@gitlab.corp:22/grp/sub/proj.git", "gitlab.corp/grp/sub/proj"],
    ["git@gitlab.corp:grp/sub/proj.git", "gitlab.corp/grp/sub/proj"],
    // host lowercased, path case preserved
    ["git@GitHub.com:June9593/MemVC.git", "github.com/June9593/MemVC"],
    // whitespace
    ["  https://github.com/june9593/memvc.git  ", "github.com/june9593/memvc"],
    // unparseable / local → null (caller falls back to path slug)
    ["", null],
    ["   ", null],
    ["/home/me/edge/memvc", null],
    ["not a url", null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(canonicalProjectId(input)).toBe(expected);
    });
  }

  it("the four canonical-equivalent forms all collapse to the same id", () => {
    const forms = [
      "git@github.com:june9593/memvc.git",
      "https://github.com/june9593/memvc.git",
      "https://github.com/june9593/memvc",
      "ssh://git@github.com/june9593/memvc.git",
    ];
    const ids = new Set(forms.map((f) => canonicalProjectId(f)));
    expect([...ids]).toEqual(["github.com/june9593/memvc"]);
  });
});

describe("projectSlugFromRemote — filesystem/index-safe slug", () => {
  it("turns host/path into a safe slug", () => {
    expect(projectSlugFromRemote("git@github.com:june9593/memvc.git")).toBe("github.com-june9593-memvc");
    expect(projectSlugFromRemote("ssh://git@gitlab.corp:22/grp/sub/proj.git")).toBe("gitlab.corp-grp-sub-proj");
  });
  it("returns null for non-git remotes", () => {
    expect(projectSlugFromRemote("/home/me/memvc")).toBeNull();
    expect(projectSlugFromRemote("")).toBeNull();
  });
});

describe("resolveProjectId — remote first, path fallback", () => {
  it("uses the remote slug when a remote resolves (path-independent)", async () => {
    const get = async () => "git@github.com:june9593/memvc.git";
    // SAME remote, DIFFERENT local paths → SAME slug (the whole point)
    const a = await resolveProjectId("/Users/me/edge/memvc", get);
    const b = await resolveProjectId("/Users/me/work/memvc", get);
    const c = await resolveProjectId("/Users/me/projects/memvc", get);
    expect(a.slug).toBe("github.com-june9593-memvc");
    expect(a.source).toBe("remote");
    expect(a.canonical).toBe("github.com/june9593/memvc");
    expect(b.slug).toBe(a.slug);
    expect(c.slug).toBe(a.slug);
  });

  it("falls back to the path slug when there's no remote", async () => {
    const get = async () => null;
    const r = await resolveProjectId("/Users/me/edge/memvc", get);
    expect(r.slug).toBe("edge-memvc"); // legacy projectSlugFromPath
    expect(r.source).toBe("path");
    expect(r.canonical).toBeNull();
  });

  it("falls back to path slug when getRemote throws", async () => {
    const get = async () => { throw new Error("not a git repo"); };
    const r = await resolveProjectId("/Users/me/edge/memvc", get);
    expect(r.source).toBe("path");
    expect(r.slug).toBe("edge-memvc");
  });

  it("real git fixture: reads remote.origin.url via default resolver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-projid-"));
    try {
      const { simpleGit } = await import("simple-git");
      const repo = join(dir, "memvc");
      mkdirSync(repo);
      const git = simpleGit(repo);
      await git.init();
      await git.addRemote("origin", "git@github.com:june9593/memvc.git");
      const r = await resolveProjectId(repo); // default getRemote (real git)
      expect(r.source).toBe("remote");
      expect(r.slug).toBe("github.com-june9593-memvc");
      // a subdir of the repo resolves to the same id (git walks up)
      const sub = join(repo, "src", "deep");
      mkdirSync(sub, { recursive: true });
      const r2 = await resolveProjectId(sub);
      expect(r2.slug).toBe("github.com-june9593-memvc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("real non-git dir: falls back to path slug", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-projid-nogit-"));
    try {
      const r = await resolveProjectId(dir);
      expect(r.source).toBe("path");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveProjectIdSync + cachedProjectSlug", () => {
  it("sync variant: remote first, path fallback (injected getRemote)", () => {
    expect(resolveProjectIdSync("/a/b/memvc", () => "git@github.com:june9593/memvc.git").slug)
      .toBe("github.com-june9593-memvc");
    expect(resolveProjectIdSync("/a/b/memvc", () => null).slug).toBe("b-memvc");
    expect(resolveProjectIdSync("/a/b/memvc", () => { throw new Error("x"); }).slug).toBe("b-memvc");
  });

  it("real git fixture via the default sync resolver", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-projid-sync-"));
    try {
      const repo = join(dir, "memvc");
      mkdirSync(repo);
      execFileSync("git", ["-C", repo, "init"], { stdio: "ignore" });
      execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/june9593/memvc.git"], { stdio: "ignore" });
      const r = resolveProjectIdSync(repo);
      expect(r.source).toBe("remote");
      expect(r.slug).toBe("github.com-june9593-memvc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cachedProjectSlug memoizes (same dir → stable result)", () => {
    const d = mkdtempSync(join(tmpdir(), "vb-projid-cache-"));
    try {
      const s1 = cachedProjectSlug(d);
      const s2 = cachedProjectSlug(d);
      expect(s1).toBe(s2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
