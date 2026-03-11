import { describe, it, expect } from "bun:test";
import register from "../../index";

describe("extension registration", () => {
  it("registers only read and edit tools", () => {
    const names: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        names.push(tool.name);
      },
      on() {},
    } as any;

    register(pi);

    expect(names.sort()).toEqual(["edit", "read"]);
  });
});
