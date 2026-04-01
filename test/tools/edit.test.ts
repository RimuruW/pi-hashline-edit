import { describe, expect, it } from "bun:test";
import Ajv from "ajv";
import {
  assertEditRequest,
  hashlineEditToolSchema,
  prepareEditArguments,
  registerEditTool,
} from "../../src/edit";

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

  it("still reports mixed legacy-key semantics explicitly after schema tightening", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);
    const payload = {
      path: "a.ts",
      edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
      oldText: "before",
      new_text: "after",
    };

    expect(validate(payload)).toBeFalse();
    expect(() => assertEditRequest(payload as any)).toThrow(
      /cannot mix legacy camelCase and snake_case/i,
    );
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

  it("rejects non-string legacy key values after prepareEditArguments normalization", () => {
    const prepared = prepareEditArguments({
      path: "a.ts",
      edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
      oldText: 123,
    });
    expect(() => assertEditRequest(prepared)).toThrow(
      /must be a string/i,
    );
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

  it("publishes a schema that rejects top-level camelCase legacy payloads", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        oldText: "before",
        newText: "after",
      }),
    ).toBeFalse();
  });

  it("publishes a schema that rejects top-level snake_case legacy payloads", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        old_text: "before",
        new_text: "after",
      }),
    ).toBeFalse();
  });

  it("publishes a schema that rejects strict edits mixed with top-level legacy fields", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
        oldText: "before",
        newText: "after",
      }),
    ).toBeFalse();
  });

  it("publishes a top-level object schema for pi tool registration", () => {
    expect((hashlineEditToolSchema as any).type).toBe("object");
    expect((hashlineEditToolSchema as any).anyOf).toBeUndefined();
  });

  it("prepareEditArguments hides legacy top-level fields while keeping execute compatibility", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);
    const prepared = prepareEditArguments({
      path: "a.ts",
      oldText: "before",
      newText: "after",
    }) as Record<string, unknown>;

    expect(validate(prepared)).toBeTrue();
    expect(prepared.oldText).toBe("before");
    expect(prepared.newText).toBe("after");
    expect(Object.keys(prepared)).toEqual(["path"]);
  });

  it("registers prepareArguments so new pi runtimes can normalize resumed legacy calls before validation", () => {
    let registered:
      | {
          parameters?: any;
          prepareArguments?: (args: unknown) => unknown;
        }
      | undefined;
    const pi = {
      registerTool(tool: {
        parameters?: any;
        prepareArguments?: (args: unknown) => unknown;
      }) {
        registered = tool;
      },
    } as any;

    registerEditTool(pi);

    expect(registered?.parameters).toEqual(hashlineEditToolSchema);
    expect(typeof registered?.prepareArguments).toBe("function");
    expect(
      (registered?.prepareArguments as (args: unknown) => unknown)({
        path: "a.ts",
        oldText: "before",
        newText: "after",
      }),
    ).toEqual(prepareEditArguments({
      path: "a.ts",
      oldText: "before",
      newText: "after",
    }));
  });
});
