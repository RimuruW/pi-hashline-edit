import type { EditToolDetails, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { constants } from "fs";
import { readFileSync } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import {
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff";
import { writeFileAtomically } from "./fs-write";
import {
  applyHashlineEdits,
  resolveEditAnchors,
  type HashlineToolEdit,
} from "./hashline";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";

function StringEnum<T extends string[]>(values: [...T]) {
  return Type.Unsafe<T[number]>({ type: "string", enum: values });
}

const hashlineEditItemSchema = Type.Object(
  {
    op: StringEnum(["replace", "append", "prepend"]),
    pos: Type.Optional(Type.String({ description: "anchor" })),
    end: Type.Optional(Type.String({ description: "limit position" })),
    lines: Type.Union([
      Type.Array(Type.String(), { description: "content (preferred format)" }),
      Type.String(),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

const hashlineEditSchema = Type.Object(
  {
    path: Type.String({ description: "path" }),
    edits: Type.Array(hashlineEditItemSchema, { description: "edits over $path" }),
  },
  { additionalProperties: false },
);

type HashlineParams = Static<typeof hashlineEditSchema>;

const EDIT_DESC = readFileSync(
  new URL("../prompts/edit.md", import.meta.url),
  "utf-8",
).trim();

const ROOT_KEYS = new Set(["path", "edits"]);
const ITEM_KEYS = new Set(["op", "pos", "end", "lines"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertStrictHashlineRequest(
  request: unknown,
): asserts request is HashlineParams {
  if (!isRecord(request)) {
    throw new Error("Edit request must be an object.");
  }

  const unknownRootKeys = Object.keys(request).filter((key) => !ROOT_KEYS.has(key));
  if (unknownRootKeys.length > 0) {
    throw new Error(
      `Edit request contains unknown or unsupported fields: ${unknownRootKeys.join(", ")}.`,
    );
  }

  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('Edit request requires a non-empty "path" string.');
  }

  if (!Array.isArray(request.edits)) {
    throw new Error('Edit request requires an "edits" array.');
  }

  for (const [index, edit] of request.edits.entries()) {
    if (!isRecord(edit)) {
      throw new Error(`Edit ${index} must be an object.`);
    }

    const unknownItemKeys = Object.keys(edit).filter((key) => !ITEM_KEYS.has(key));
    if (unknownItemKeys.length > 0) {
      throw new Error(
        `Edit ${index} contains unknown or unsupported fields: ${unknownItemKeys.join(", ")}.`,
      );
    }
  }
}

export function registerEditTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "Edit",
    description: EDIT_DESC,
    parameters: hashlineEditSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertStrictHashlineRequest(params);

      const rawPath = params.path;
      const path = rawPath.replace(/^@/, "");
      const absolutePath = resolveToCwd(path, ctx.cwd);
      const toolEdits = params.edits as HashlineToolEdit[];

      if (toolEdits.length === 0) {
        return {
          content: [{ type: "text", text: "No edits provided." }],
          isError: true,
          details: { diff: "", firstChangedLine: undefined } as EditToolDetails,
        };
      }

      throwIfAborted(signal);
      try {
        await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
      } catch {
        throw new Error(`File not found: ${path}`);
      }

      throwIfAborted(signal);
      const raw = (await fsReadFile(absolutePath)).toString("utf-8");
      throwIfAborted(signal);

      const { bom, text: content } = stripBom(raw);
      const originalEnding = detectLineEnding(content);
      const originalNormalized = normalizeToLF(content);
      const resolved = resolveEditAnchors(toolEdits);
      const anchorResult = applyHashlineEdits(originalNormalized, resolved, signal);
      const result = anchorResult.content;

      if (originalNormalized === result) {
        let diagnostic = `No changes made to ${path}. The edits produced identical content.`;
        if (anchorResult.noopEdits?.length) {
          diagnostic +=
            "\n" +
            anchorResult.noopEdits
              .map(
                (edit) =>
                  `Edit ${edit.editIndex}: replacement for ${edit.loc} is identical to current content:\n  ${edit.loc}: ${edit.currentContent}`,
              )
              .join("\n");
          diagnostic +=
            "\nYour content must differ from what the file already contains. Re-read the file to see the current state.";
        }
        throw new Error(diagnostic);
      }

      throwIfAborted(signal);
      await writeFileAtomically(
        absolutePath,
        bom + restoreLineEndings(result, originalEnding),
      );

      const diffResult = generateDiffString(originalNormalized, result);
      const warnings = anchorResult.warnings?.length
        ? `\n\nWarnings:\n${anchorResult.warnings.join("\n")}`
        : "";

      return {
        content: [{ type: "text", text: `Updated ${path}${warnings}` }],
        details: {
          diff: diffResult.diff,
          firstChangedLine:
            anchorResult.firstChangedLine ?? diffResult.firstChangedLine,
        } as EditToolDetails,
      };
    },
  });
}
