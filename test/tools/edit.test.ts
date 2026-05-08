import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import Ajv from "ajv";
import {
  assertEditRequest,
  hashlineEditToolSchema,
  registerEditTool,
} from "../../src/edit";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";

describe("assertEditRequest", () => {
  it("rejects unknown or unsupported root fields", () => {
    expect(() =>
      assertEditRequest({ path: "a.ts", legacy_field: [] } as any),
    ).toThrow(/unknown or unsupported fields/i);
  });

  it("accepts complete legacy replace fields when edits is absent", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        oldText: "before",
        newText: "after",
      }),
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

  it("lets assertEditRequest report mixed legacy-key semantics after schema validation", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);
    const payload = {
      path: "a.ts",
      edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
      oldText: "before",
      new_text: "after",
    };

    expect(validate(payload)).toBe(true);
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

  it("rejects non-string legacy key values", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
        oldText: 123,
      } as any),
    ).toThrow(/must be a string/i);
  });
});

  it("requires returnRanges when returnMode is ranges", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        returnMode: "ranges",
        edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
      } as any),
    ).toThrow(/returnRanges/i);
  });

  it("rejects returnRanges outside ranges returnMode", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        returnMode: "changed",
        returnRanges: [{ start: 1, end: 2 }],
        edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
      } as any),
    ).toThrow(/returnRanges/i);
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
    ).toBe(true);
  });

  it("publishes a schema that validates top-level camelCase legacy payloads", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        oldText: "before",
        newText: "after",
      }),
    ).toBe(true);
  });

  it("publishes a schema that validates top-level snake_case legacy payloads", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        old_text: "before",
        new_text: "after",
      }),
    ).toBe(true);
  });

  it("publishes a schema that validates strict edits mixed with top-level legacy fields", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    expect(
      validate({
        path: "a.ts",
        edits: [{ op: "replace", pos: "1#ZZ", lines: ["x"] }],
        oldText: "before",
        newText: "after",
      }),
    ).toBe(true);
  });

  it("publishes a top-level object schema for pi tool registration", () => {
    expect((hashlineEditToolSchema as any).type).toBe("object");
    expect((hashlineEditToolSchema as any).anyOf).toBeUndefined();
  });

  it("keeps legacy top-level fields enumerable and visible through structuredClone", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);
    const payload = {
      path: "a.ts",
      oldText: "before",
      newText: "after",
    };
    const cloned = structuredClone(payload);

    expect(validate(cloned)).toBe(true);
    expect(cloned.oldText).toBe("before");
    expect(cloned.newText).toBe("after");
    expect(Object.keys(cloned)).toEqual(["path", "oldText", "newText"]);
  });

  it("registers the edit tool without a prepareArguments compatibility shim", () => {
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
    expect(registered?.prepareArguments).toBeUndefined();
  });

  it("executes fuzzy legacy top-level replace through the compatibility path", async () => {
    await withTempFile("legacy.txt", "alpha\nconsole.log(\"hi\")\nomega\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");

      const result = await editTool.execute(
        "legacy-1",
        {
          path: "legacy.txt",
          oldText: "console.log(\"hi\")",
          newText: "console.log(\"bye\")",
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(await readFile(path, "utf-8")).toBe("alpha\nconsole.log(\"bye\")\nomega\n");
      expect(result.details?.compatibility).toMatchObject({
        used: true,
        strategy: "legacy-top-level-replace",
        matchCount: 1,
      });
      expect(result.details?.metrics?.legacy_replace).toBe(true);
    });
  });

  it("renders details diff while keeping diff out of LLM-visible text", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const editArgs = {
        path: "sample.txt",
        edits: [
          {
            op: "replace",
            pos: `2#${computeLineHash(2, "bbb")}:bbb`,
            lines: ["BBB"],
          },
        ],
      };

      const result = await editTool.execute(
        "e1",
        editArgs,
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(typeof editTool.renderResult).toBe("function");

      const component = editTool.renderResult(
        result,
        { expanded: false, isPartial: false },
        {
          bold: (text: string) => text,
          fg: (token: string, text: string) => `[${token}]${text}[/${token}]`,
        },
        {
          args: editArgs,
          isError: false,
          lastComponent: undefined,
        } as any,
      ) as { render: (width: number) => string[] };

      const rendered = component.render(200).join("\n");

      expect(rendered).not.toContain("Changes: +1 -1");
      expect(rendered).not.toContain("Diff preview:");
      expect(rendered).not.toContain("```diff");
      expect(rendered).toContain(`+2#${computeLineHash(2, "BBB")}:BBB`);
      expect(rendered).not.toContain("Updated sample.txt");
      expect(rendered).not.toContain("```text");
      expect(result.details?.diff).toContain("+2");
    });
  });
});
