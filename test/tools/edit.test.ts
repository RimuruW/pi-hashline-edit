import { describe, expect, it } from "bun:test";
import { writeFile } from "fs/promises";
import Ajv from "ajv";
import {
  assertEditRequest,
  hashlineEditToolSchema,
  prepareEditArguments,
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

      expect(rendered).toContain("Changes: +1 -1");
      expect(rendered).toContain("```diff");
      expect(rendered).toContain(`+2#${computeLineHash(2, "BBB")}:BBB`);
      expect(rendered).not.toContain("Updated sample.txt");
      expect(rendered).not.toContain("```text");
      // Diff preview stays out of LLM-visible text but is rendered for humans from details.diff.
      expect(result.content[0].text).not.toContain("```diff");
      expect(result.details?.diff).toContain("+2");
    });
  });

  it("renders details diff when LLM-visible anchors are omitted", async () => {
    const content = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
    await withTempFile("sample.txt", `${content}\n`, async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const editArgs = {
        path: "sample.txt",
        edits: [
          {
            op: "replace",
            pos: `2#${computeLineHash(2, "line-2")}:line-2`,
            lines: ["LINE-2"],
          },
          {
            op: "replace",
            pos: `25#${computeLineHash(25, "line-25")}:line-25`,
            lines: ["LINE-25"],
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

      expect(result.content[0].text).toContain("Anchors omitted; use read");
      expect(result.content[0].text).not.toContain("LINE-25");

      const component = editTool.renderResult(
        result,
        { expanded: false, isPartial: false },
        {
          bold: (text: string) => text,
          fg: (_token: string, text: string) => text,
        },
        {
          args: editArgs,
          isError: false,
          lastComponent: undefined,
        } as any,
      ) as { render: (width: number) => string[] };
      const rendered = component.render(200).join("\n");

      expect(rendered).toContain("Changes: +2 -2");
      expect(rendered).toContain("```diff");
      expect(rendered).toContain("+ 2#");
      expect(rendered).toContain(":LINE-2");
      expect(rendered).toContain("+25#");
      expect(rendered).toContain(":LINE-25");
      expect(rendered).not.toContain("Anchors omitted; use read");
    });
  });

  it("does not synchronously invalidate while clearing a stale preview after result render", async () => {
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
      const theme = {
        bold: (text: string) => text,
        fg: (_token: string, text: string) => text,
      };
      const state: Record<string, unknown> = {};
      let invalidations = 0;
      const callContext = {
        argsComplete: true,
        state,
        cwd,
        expanded: false,
        lastComponent: undefined,
        invalidate() {
          invalidations += 1;
        },
      } as any;

      const callComponent = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      callContext.lastComponent = callComponent;

      const deadline = Date.now() + 2_000;
      while (!(state as { preview?: unknown }).preview) {
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for edit preview");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const previewComponent = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      const previewRendered = previewComponent.render(200).join("\n");
      expect(previewRendered).toContain(`+2#${computeLineHash(2, "BBB")}:BBB`);

      const result = await editTool.execute(
        "e1",
        editArgs,
        undefined,
        undefined,
        { cwd } as any,
      );
      const invalidationsBeforeResult = invalidations;
      const resultComponent = editTool.renderResult(
        result,
        { expanded: false, isPartial: false },
        theme,
        {
          args: editArgs,
          state,
          isError: false,
          lastComponent: undefined,
          invalidate() {
            invalidations += 1;
          },
        } as any,
      ) as { render: (width: number) => string[] };
      const resultRendered = resultComponent.render(200).join("\n");

      expect(resultRendered).toContain("Changes: +1 -1");
      expect((state as { preview?: unknown }).preview).toBeUndefined();
      expect(invalidations).toBe(invalidationsBeforeResult);

      callContext.lastComponent = previewComponent;
      const postResultCall = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      const postResultRendered = postResultCall.render(200).join("\n");
      expect(postResultRendered).not.toContain(`+2#${computeLineHash(2, "BBB")}:BBB`);
    });
  });

  it("clears a noop preview after the settled noop result renders", async () => {
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
            lines: ["bbb"],
          },
        ],
      };
      const theme = {
        bold: (text: string) => text,
        fg: (_token: string, text: string) => text,
      };
      const state: Record<string, unknown> = {};
      const callContext = {
        argsComplete: true,
        state,
        cwd,
        expanded: false,
        lastComponent: undefined,
        invalidate() {},
      } as any;

      const callComponent = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      callContext.lastComponent = callComponent;

      const deadline = Date.now() + 2_000;
      while (!(state as { preview?: unknown }).preview) {
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for noop preview");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const previewComponent = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      expect(previewComponent.render(200).join("\n")).toContain("No changes made");

      const result = await editTool.execute(
        "e1",
        editArgs,
        undefined,
        undefined,
        { cwd } as any,
      );
      editTool.renderResult(
        result,
        { expanded: false, isPartial: false },
        theme,
        {
          args: editArgs,
          state,
          isError: false,
          lastComponent: undefined,
          invalidate() {},
        } as any,
      );

      expect((state as { preview?: unknown }).preview).toBeUndefined();
      callContext.lastComponent = previewComponent;
      const postResultCall = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      expect(postResultCall.render(200).join("\n")).not.toContain("No changes made");
    });
  });

  it("clears a stale preview after success even when the actual diff changed on disk", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const editArgs = {
        path: "sample.txt",
        edits: [
          {
            op: "replace",
            pos: `2#${computeLineHash(2, "bbb")}:bbb`,
            lines: ["BETA"],
          },
        ],
      };
      const theme = {
        bold: (text: string) => text,
        fg: (_token: string, text: string) => text,
      };
      const state: Record<string, unknown> = {};
      const callContext = {
        argsComplete: true,
        state,
        cwd,
        expanded: false,
        lastComponent: undefined,
        invalidate() {},
      } as any;

      const callComponent = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      callContext.lastComponent = callComponent;

      const deadline = Date.now() + 2_000;
      while (!(state as { preview?: unknown }).preview) {
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for edit preview");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const previewComponent = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      expect(previewComponent.render(200).join("\n")).toContain(":BETA");

      await writeFile(path, "AAA\nbbb\nccc\n", "utf-8");

      const result = await editTool.execute(
        "e1",
        editArgs,
        undefined,
        undefined,
        { cwd } as any,
      );
      editTool.renderResult(
        result,
        { expanded: false, isPartial: false },
        theme,
        {
          args: editArgs,
          state,
          isError: false,
          lastComponent: undefined,
          invalidate() {},
        } as any,
      );

      expect((state as { preview?: unknown }).preview).toBeUndefined();
      callContext.lastComponent = previewComponent;
      const postResultCall = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      expect(postResultCall.render(200).join("\n")).not.toContain(":BETA");
    });
  });
  it("clears preview after an error result renders", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const { pi, getTool } = makeFakePiRegistry();
      registerEditTool(pi);
      const editTool = getTool("edit");
      const editArgs = {
        path: "sample.txt",
        edits: [
          {
            op: "replace",
            pos: `2#${computeLineHash(2, "bbb")}:bbb`,
            lines: ["BETA"],
          },
        ],
      };
      const theme = {
        bold: (text: string) => text,
        fg: (_token: string, text: string) => text,
      };
      const state: Record<string, unknown> = {};
      const callContext = {
        argsComplete: true,
        state,
        cwd,
        expanded: false,
        lastComponent: undefined,
        invalidate() {},
      } as any;

      const callComponent = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      callContext.lastComponent = callComponent;

      const deadline = Date.now() + 2_000;
      while (!(state as { preview?: unknown }).preview) {
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for edit preview");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const previewComponent = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      expect(previewComponent.render(200).join("\n")).toContain(":BETA");

      await writeFile(path, "aaa\nchanged\nccc\n", "utf-8");

      let errorMessage = "";
      try {
        await editTool.execute(
          "e1",
          editArgs,
          undefined,
          undefined,
          { cwd } as any,
        );
      } catch (error: unknown) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      expect(errorMessage).toContain("stale anchor");

      editTool.renderResult(
        { content: [{ type: "text", text: errorMessage }] },
        { expanded: false, isPartial: false },
        theme,
        {
          args: editArgs,
          state,
          isError: true,
          lastComponent: undefined,
          invalidate() {},
        } as any,
      );

      expect((state as { preview?: unknown }).preview).toBeUndefined();
      callContext.lastComponent = previewComponent;
      const postErrorCall = editTool.renderCall(
        editArgs,
        theme,
        callContext,
      ) as { render: (width: number) => string[] };
      expect(postErrorCall.render(200).join("\n")).not.toContain(":BETA");
    });
  });
});
