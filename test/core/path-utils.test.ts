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

  it("preserves a leading @ in relative paths", () => {
    expect(resolveToCwd("@src/main.ts", cwd)).toBe(
      resolve(cwd, "@src/main.ts"),
    );
  });

  it("preserves unicode spaces in file names", () => {
    expect(resolveToCwd("src/my\u00A0file.ts", cwd)).toBe(
      resolve(cwd, "src/my\u00A0file.ts"),
    );
  });

  it("does not treat @~ as home-directory expansion", () => {
    expect(resolveToCwd("@~/notes.md", cwd)).toBe(
      resolve(cwd, "@~/notes.md"),
    );
  });
});
