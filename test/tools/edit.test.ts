import { describe, expect, it } from "vitest";
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

  it("rejects top-level oldText/newText (folded by normalize, not accepted raw)", () => {
    // After normalization these become edits[]; reaching assertEditRequest with
    // them still present means they were not folded, so they are unknown fields.
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        oldText: "before",
        newText: "after",
      } as any),
    ).toThrow(/unknown or unsupported fields/i);
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

  it("rejects an edit item with no op", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        edits: [{ pos: "1#ZZ", lines: ["x"] }],
      } as any),
    ).toThrow(/requires an "op" string/i);
  });

  it("rejects non-array lines (string form no longer accepted at entry)", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        edits: [{ op: "replace", pos: "1#ZZ", lines: "x" }],
      } as any),
    ).toThrow(/lines" must be a string array/i);
  });

  it("rejects null lines at entry", () => {
    expect(() =>
      assertEditRequest({
        path: "a.ts",
        edits: [{ op: "replace", pos: "1#ZZ", lines: null }],
      } as any),
    ).toThrow(/lines" must be a string array/i);
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

  it("publishes a schema with no top-level native text-replace fields", () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(hashlineEditToolSchema as any);

    // Native top-level fields are normalized away before validation; the
    // published schema does not declare them, so AJV rejects them as additional
    // properties.
    expect(
      validate({ path: "a.ts", oldText: "before", newText: "after" }),
    ).toBe(false);

    const props = (hashlineEditToolSchema as any).properties;
    expect(props.oldText).toBeUndefined();
    expect(props.newText).toBeUndefined();
    expect(props.old_text).toBeUndefined();
    expect(props.new_text).toBeUndefined();
  });

  it("publishes a top-level object schema for pi tool registration", () => {
    expect((hashlineEditToolSchema as any).type).toBe("object");
    expect((hashlineEditToolSchema as any).anyOf).toBeUndefined();
  });

  it("registers the edit tool with a normalization prepareArguments hook", () => {
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
    // The hook folds top-level native fields into edits[].
    expect(
      registered?.prepareArguments?.({
        path: "a.ts",
        oldText: "x",
        newText: "y",
      }),
    ).toEqual({
      path: "a.ts",
      edits: [{ op: "replace_text", oldText: "x", newText: "y" }],
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
