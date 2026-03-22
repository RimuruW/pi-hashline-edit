import { describe, expect, it } from "bun:test";
import { assertEditRequest, registerEditTool } from "../../src/edit";

describe("assertEditRequest", () => {
  it("rejects unknown or unsupported root fields", () => {
    expect(() =>
      assertEditRequest({ path: "a.ts", legacy_field: [] } as any),
    ).toThrow(/unknown or unsupported fields/i);
  });

  it("accepts hidden complete legacy replace fields when edits is absent", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        oldText: "before",
        newText: "after",
      } as any),
    ).not.toThrow();
  });

  it("rejects half-specified legacy replace payloads", () => {
    expect(() =>
      assertEditRequest({ path: "a.ts", oldText: "before" } as any),
    ).toThrow(/legacy|both/i);
  });

  it("rejects mixed-case legacy replace payloads", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        oldText: "before",
        new_text: "after",
      } as any),
    ).toThrow(/cannot mix legacy camelCase and snake_case/i);
  });

  it("rejects append with end", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        edits: [{ op: "append", end: "1#ZZ", lines: ["x"] }],
      } as any),
    ).toThrow(/does not support "end"/i);
  });

  it("rejects replace without pos", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        edits: [{ op: "replace", lines: ["x"] }],
      } as any),
    ).toThrow(/requires a "pos" anchor string/i);
  });
});

describe("registerEditTool", () => {
  it("publishes only the strict public hashline schema", () => {
    let registered: { parameters?: any } | undefined;
    const pi = {
      registerTool(tool: { parameters?: any }) {
        registered = tool;
      },
    } as any;

    registerEditTool(pi);

    expect(registered?.parameters).toBeDefined();
    expect(registered!.parameters.type).toBe("object");
    expect(Object.keys(registered!.parameters.properties)).toEqual(["path", "edits"]);
    expect(registered!.parameters.required).toEqual(["path", "edits"]);
    expect(registered!.parameters.additionalProperties).toBeUndefined();
    expect(registered!.parameters.properties.edits).toBeDefined();
    expect(registered!.parameters.properties.oldText).toBeUndefined();
    expect(registered!.parameters.properties.newText).toBeUndefined();
    expect(registered!.parameters.properties.old_text).toBeUndefined();
    expect(registered!.parameters.properties.new_text).toBeUndefined();
  });
});
