import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "../src/git-ops.js";

describe("expandHome", () => {
  it("expands bare ~", () => {
    expect(expandHome("~")).toBe(homedir());
  });
  it("expands ~/foo to <home>/foo", () => {
    expect(expandHome("~/foo")).toBe(join(homedir(), "foo"));
    expect(expandHome("~/edge/sub")).toBe(join(homedir(), "edge", "sub"));
  });
  it("leaves absolute paths alone", () => {
    expect(expandHome("/tmp/x")).toBe("/tmp/x");
  });
  it("does not expand ~ in the middle of a string", () => {
    expect(expandHome("foo~bar")).toBe("foo~bar");
    expect(expandHome("/home/user/~back")).toBe("/home/user/~back");
  });
  it("leaves relative paths alone", () => {
    expect(expandHome("./foo")).toBe("./foo");
    expect(expandHome("foo/bar")).toBe("foo/bar");
  });
});
