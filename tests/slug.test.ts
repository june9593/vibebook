import { describe, it, expect } from "vitest";
import { deriveSlug, toDisplayName, projectSlugFromPath } from "../src/slug.js";

describe("deriveSlug", () => {
  it("takes first 60 chars of first user message", () => {
    const { slug, display } = deriveSlug("帮我搜一下今天的ai新闻");
    expect(display).toBe("帮我搜一下今天的ai新闻");
    expect(slug).toBe("帮我搜一下今天的ai新闻");
  });

  it("replaces filesystem-unsafe chars with dashes", () => {
    const { slug } = deriveSlug("fix: /auth/login bug (urgent)");
    expect(slug).toBe("fix-auth-login-bug-urgent");
  });

  it("collapses whitespace and trims", () => {
    const { slug } = deriveSlug("  multi   word   title  ");
    expect(slug).toBe("multi-word-title");
  });

  it("truncates to 60 chars on slug, 120 on display", () => {
    const long = "a".repeat(200);
    const { slug, display } = deriveSlug(long);
    expect(slug.length).toBe(60);
    expect(display.length).toBe(120);
  });

  it("falls back to 'untitled' on empty input", () => {
    expect(deriveSlug("").slug).toBe("untitled");
    expect(deriveSlug("   ").slug).toBe("untitled");
  });
});

describe("projectSlugFromPath", () => {
  it("extracts basename of cwd", () => {
    expect(projectSlugFromPath("/Users/yueliu/edge/memvc")).toBe("edge-memvc");
    expect(projectSlugFromPath("/Users/yueliu")).toBe("home");
    expect(projectSlugFromPath("/")).toBe("root");
  });
});

describe("toDisplayName", () => {
  it("is identity for ascii", () => {
    expect(toDisplayName("Hello world")).toBe("Hello world");
  });
});
