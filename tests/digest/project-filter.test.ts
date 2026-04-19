import { describe, it, expect } from "vitest";
import { isRealProjectPath } from "../../src/digest/project-filter.js";

describe("isRealProjectPath", () => {
  it("accepts normal project slugs", () => {
    expect(isRealProjectPath("edge-memvc")).toBe(true);
    expect(isRealProjectPath("chromium-src")).toBe(true);
  });
  it("rejects worktree paths", () => {
    expect(isRealProjectPath(".worktrees-38e8767b-6a62-4f6f-b062-96296496fee0")).toBe(false);
  });
  it("rejects workspace.json-derived names", () => {
    expect(isRealProjectPath("1747378825021-workspace.json")).toBe(false);
    expect(isRealProjectPath("commands-pew.code-workspace")).toBe(false);
  });
  it("rejects workspaceStorage hash dirs", () => {
    expect(isRealProjectPath("User-workspaceStorage")).toBe(false);
  });
  it("rejects sentinel values", () => {
    expect(isRealProjectPath("")).toBe(false);
    expect(isRealProjectPath("root")).toBe(false);
    expect(isRealProjectPath("home")).toBe(false);
  });
  it("rejects long-numeric prefixed names", () => {
    expect(isRealProjectPath("1747378825021-something")).toBe(false);
  });
});
