import { describe, expect, it } from "bun:test";
import register from "../../index";

describe("extension registration", () => {
  it("registers read/edit tools and compatibility lifecycle hooks", () => {
    const toolNames: string[] = [];
    const eventNames: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        toolNames.push(tool.name);
      },
      on(name: string) {
        eventNames.push(name);
      },
    } as any;

    register(pi);

    expect(toolNames.sort()).toEqual(["edit", "read"]);
    expect(eventNames.sort()).toEqual(["tool_result", "turn_end", "turn_start"]);
  });
});
