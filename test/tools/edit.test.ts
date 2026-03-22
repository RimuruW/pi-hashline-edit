import { describe, expect, it } from "bun:test";
import Ajv from "ajv";
import { assertEditRequest, hashlineEditToolSchema, registerEditTool } from "../../src/edit";

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
  it("publishes a schema that validates strict hashline payloads", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
      }),
    ).toBeTrue();
  });

  it("publishes a schema that validates camelCase legacy payloads", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        oldText: "before",
        newText: "after",
      }),
    ).toBeTrue();
  });

  it("publishes a schema that validates snake_case legacy payloads", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        old_text: "before",
        new_text: "after",
      }),
    ).toBeTrue();
  });

  it("publishes a schema that still accepts strict edits when legacy fields are also present", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
        oldText: "before",
        newText: "after",
      }),
    ).toBeTrue();
  });

  it("registers the same union schema publicly", () => {
    let registered: { parameters?: any } | undefined;
    const pi = {
      registerTool(tool: { parameters?: any }) {
        registered = tool;
      },
    } as any;

    registerEditTool(pi);

    expect(registered?.parameters).toEqual(hashlineEditToolSchema);
  });
});
