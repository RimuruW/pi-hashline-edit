import { describe, expect, it } from "bun:test";
import * as os from "os";
import { resolve } from "path";
import { resolveToCwd } from "../../src/path-utils";

describe("resolveToCwd", () => {
  const cwd = "/home/user/project";

  it("resolves a relative path against cwd", () => {
    expect(resolveToCwd("src/main.ts", cwd)).toBe(
      resolve(cwd, "src/main.ts"),
    );
  });

  it("returns absolute paths unchanged", () => {
    expect(resolveToCwd("/etc/hosts", cwd)).toBe("/etc/hosts");
  });

  it("expands ~ to home directory", () => {
    expect(resolveToCwd("~/file.txt", cwd)).toBe(
      os.homedir() + "/file.txt",
    );
  });

  it("expands bare ~ to home directory", () => {
    expect(resolveToCwd("~", cwd)).toBe(os.homedir());
  });

  it("strips leading @ prefix", () => {
    expect(resolveToCwd("@src/main.ts", cwd)).toBe(
      resolve(cwd, "src/main.ts"),
    );
  });

  it("replaces unicode non-breaking spaces with ASCII space", () => {
    // \u00A0 is non-breaking space
    expect(resolveToCwd("src/my\u00A0file.ts", cwd)).toBe(
      resolve(cwd, "src/my file.ts"),
    );
  });

  it("handles @ prefix combined with ~ expansion", () => {
    // @~ → strip @ → ~ → expand to homedir
    expect(resolveToCwd("@~/notes.md", cwd)).toBe(
      os.homedir() + "/notes.md",
    );
  });
});
