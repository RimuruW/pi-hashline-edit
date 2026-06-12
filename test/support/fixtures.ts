import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

// Temp dirs live under <repo>/.tmp (gitignored) instead of os.tmpdir() so
// cross-device rename never interferes with the atomic-write tests.
const TEMP_ROOT = join(process.cwd(), ".tmp");

export async function makeTempDir(prefix: string): Promise<string> {
	await mkdir(TEMP_ROOT, { recursive: true });
	return mkdtemp(join(TEMP_ROOT, prefix));
}

export async function withTempFile(
	name: string,
	content: string,
	run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
	const cwd = await makeTempDir("pi-hashline-test-");
	const path = join(cwd, name);
	try {
		await writeFile(path, content, "utf-8");
		await run({ cwd, path });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

export async function withTempBytes(
	name: string,
	bytes: Uint8Array,
	run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
	const cwd = await makeTempDir("pi-hashline-test-");
	const path = join(cwd, name);
	try {
		await writeFile(path, bytes);
		await run({ cwd, path });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

export async function withTempDirectory(
	name: string,
	run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
	const cwd = await makeTempDir("pi-hashline-test-");
	const path = join(cwd, name);
	try {
		await mkdir(path, { recursive: true });
		await run({ cwd, path });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

/**
 * Tool definition as stored by the fake registry. TParams stays at the TSchema
 * base and TDetails is `any` because tests assert the concrete `details` shape
 * at runtime; the static surface this preserves is the execute/render method
 * signatures, where peer-dependency drift would otherwise surface only at
 * runtime.
 */
export type RegisteredToolDefinition = ToolDefinition<TSchema, any, any>;

export function makeFakePiRegistry(): {
	pi: ExtensionAPI;
	getTool(name: string): RegisteredToolDefinition;
} {
	const tools = new Map<string, RegisteredToolDefinition>();
	const fakePi = {
		registerTool(tool: RegisteredToolDefinition): void {
			tools.set(tool.name, tool);
		},
		on(): void {},
	};
	return {
		// The fake implements only the ExtensionAPI members the extension's
		// register() path calls (registerTool/on). The cast names that gap: if
		// registration starts using more of the API, tests fail here at runtime.
		pi: fakePi as unknown as ExtensionAPI,
		getTool(name: string): RegisteredToolDefinition {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Tool not registered: ${name}`);
			return tool;
		},
	};
}

/**
 * Minimal ExtensionContext for driving execute() in tests. The production
 * read/edit execute paths only consume `cwd`; the cast names that assumption.
 * If a tool starts reading more context fields, extend this factory instead of
 * re-introducing `as any` at call sites.
 */
export function makeToolContext(cwd: string): ExtensionContext {
	return { cwd } as unknown as ExtensionContext;
}

export function getText(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	return result.content[0]?.text ?? "";
}

type RenderResultParams = Parameters<
	NonNullable<RegisteredToolDefinition["renderResult"]>
>;

/** Theme type as consumed by the production render seam. */
export type ToolTheme = RenderResultParams[2];

/** Render context type as consumed by the production render seam. */
export type ToolRenderContext = RenderResultParams[3];

/**
 * Stub theme for render tests. The edit render paths consume only bold/fg;
 * the cast names that gap — rendering that touches more Theme surface fails
 * here at runtime instead of passing silently.
 */
export function makeTestTheme(
	overrides: Partial<{
		bold: (text: string) => string;
		fg: (token: string, text: string) => string;
	}> = {},
): ToolTheme {
	return {
		bold: (text: string) => text,
		fg: (_token: string, text: string) => text,
		...overrides,
	} as unknown as ToolTheme;
}
