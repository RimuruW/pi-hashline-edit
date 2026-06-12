import { execFile } from "child_process";
import { describe, expect, it } from "vitest";
import { access, appendFile, readFile, rm } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { loadFileKindAndText } from "../../src/file-kind";
import {
	getText,
	makeFakePiRegistry,
	makeTempDir,
	makeToolContext,
	withTempBytes,
	withTempDirectory,
	withTempFile,
} from "../support/fixtures";

describe("loadFileKindAndText classification", () => {
	it("classifies directories explicitly", async () => {
		await withTempDirectory("nested", async ({ path }) => {
			await expect(loadFileKindAndText(path)).resolves.toEqual({
				kind: "directory",
			});
		});
	});

	it("classifies supported images separately from text", async () => {
		const imagePath = join(process.cwd(), "assets", "banner.jpeg");

		await expect(loadFileKindAndText(imagePath)).resolves.toMatchObject({
			kind: "image",
			mimeType: "image/jpeg",
		});
	});

	it("classifies plain utf-8 text as text", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\n", async ({ path }) => {
			await expect(loadFileKindAndText(path)).resolves.toMatchObject({ kind: "text" });
		});
	});

	it("classifies utf-8 xml with a declaration as text", async () => {
		await withTempFile(
			"layout.xml",
			'<?xml version="1.0" encoding="utf-8"?>\n<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android" />\n',
			async ({ path }) => {
				await expect(loadFileKindAndText(path)).resolves.toMatchObject({ kind: "text" });
			},
		);
	});

	it("classifies utf-16 xml as binary via the null-byte guard", async () => {
		const xml = '<?xml version="1.0" encoding="utf-16"?>\n<LinearLayout />\n';
		const utf16LeBom = Buffer.from([0xff, 0xfe]);
		const utf16Xml = Buffer.concat([utf16LeBom, Buffer.from(xml, "utf16le")]);

		await withTempBytes("layout-utf16.xml", utf16Xml, async ({ path }) => {
			await expect(loadFileKindAndText(path)).resolves.toEqual({
				kind: "binary",
				description: "null bytes detected",
			});
		});
	});

	it("classifies recognized text/* MIME types as text", async () => {
		await withTempFile(
			"captions.vtt",
			"WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n",
			async ({ path }) => {
				await expect(loadFileKindAndText(path)).resolves.toMatchObject({ kind: "text" });
			},
		);
	});

	it("classifies recognized application/* text-like MIME types as text", async () => {
		await withTempFile(
			"sample.rtf",
			"{\\rtf1\\ansi hello}\n",
			async ({ path }) => {
				await expect(loadFileKindAndText(path)).resolves.toMatchObject({ kind: "text" });
			},
		);
	});

	it("classifies utf-8 text as text when the sniff window ends mid-code-point", async () => {
		const prefix = new Uint8Array(8190).fill(0x61);
		const emDash = new Uint8Array([0xe2, 0x80, 0x94]);
		const suffix = new Uint8Array([0x0a]);
		const bytes = new Uint8Array(prefix.length + emDash.length + suffix.length);
		bytes.set(prefix, 0);
		bytes.set(emDash, prefix.length);
		bytes.set(suffix, prefix.length + emDash.length);

		await withTempBytes("sample.md", bytes, async ({ path }) => {
			await expect(loadFileKindAndText(path)).resolves.toMatchObject({ kind: "text" });
		});
	});

	it("classifies files with null bytes as binary", async () => {
		await withTempBytes(
			"sample.bin",
			new Uint8Array([0x61, 0x00, 0x62, 0x63]),
			async ({ path }) => {
				await expect(loadFileKindAndText(path)).resolves.toEqual({
					kind: "binary",
					description: "null bytes detected",
				});
			},
		);
	});

	it("classifies invalid utf-8 without null bytes as text", async () => {
		await withTempBytes(
			"sample.c",
			new Uint8Array([0xc3, 0x28]),
			async ({ path }) => {
				await expect(loadFileKindAndText(path)).resolves.toMatchObject({ kind: "text" });
			},
		);
	});

	it("tracks whether text decoding used replacement characters for invalid bytes", async () => {
		await withTempBytes(
			"sample.c",
			new Uint8Array([0xc3, 0x28]),
			async ({ path }) => {
				await expect(loadFileKindAndText(path)).resolves.toEqual({
					kind: "text",
					text: "�(",
					hadUtf8DecodeErrors: true,
				});
			},
		);
	});

	it("does not flag a valid utf-8 replacement character as a decode error", async () => {
		await withTempFile("sample.txt", "valid �\n", async ({ path }) => {
			await expect(loadFileKindAndText(path)).resolves.toEqual({
				kind: "text",
				text: "valid �\n",
			});
		});
	});

	it("classifies invalid utf-8 beyond the sniff window as text", async () => {
		const prefix = new Uint8Array(9000).fill(0x61);
		const invalid = new Uint8Array([0xc3, 0x28]);
		const suffix = new Uint8Array([0x0a]);
		const bytes = new Uint8Array(
			prefix.length + invalid.length + suffix.length,
		);
		bytes.set(prefix, 0);
		bytes.set(invalid, prefix.length);
		bytes.set(suffix, prefix.length + invalid.length);

		await withTempBytes("late-invalid.c", bytes, async ({ path }) => {
			await expect(loadFileKindAndText(path)).resolves.toMatchObject({ kind: "text" });
		});
	});

	it("reads until EOF when the file grows after the initial size snapshot", async () => {
		const initialText = "a".repeat(8 * 1024 * 1024);
		await withTempFile("growing.txt", initialText, async ({ path }) => {
			const loadPromise = loadFileKindAndText(path);
			await new Promise((r) => setTimeout(r, 1));
			await appendFile(path, "TAIL\n", "utf-8");

			const loaded = await loadPromise;
			expect(loaded.kind).toBe("text");
			if (loaded.kind !== "text") {
				return;
			}
			expect(loaded.text.endsWith("TAIL\n")).toBe(true);
			expect(loaded.text.length).toBe(initialText.length + 5);
		});
	});

	it("does not try to slurp unbounded special files", async () => {
		if (process.platform === "win32") {
			return;
		}
		try {
			await access("/dev/zero");
		} catch {
			return;
		}

		const result = await loadFileKindAndText("/dev/zero");
		expect(result).toEqual({
			kind: "binary",
			description: "unsupported file type",
		});
	}, 2000);

	it("rejects named pipes without opening them", async () => {
		if (process.platform === "win32") {
			return;
		}

		const cwd = await makeTempDir("pi-hashline-kind-");
		const pipePath = join(cwd, "sample.pipe");
		try {
			await new Promise<void>((resolve, reject) => {
				execFile("mkfifo", [pipePath], (error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});

			const result = await loadFileKindAndText(pipePath);
			expect(result).toEqual({
				kind: "binary",
				description: "unsupported file type",
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 2000);
});

describe("file kind guards in tools", () => {
	it("read reports directories explicitly", async () => {
		await withTempDirectory("nested", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const readTool = getTool("read");

			await expect(
				readTool.execute("r1", { path: "nested" }, undefined, undefined, makeToolContext(cwd)),
			).rejects.toThrow(/Path is a directory: nested/);
		});
	});

	it("read accepts utf-8 text when the sniff window ends mid-code-point", async () => {
		const prefix = new Uint8Array(8190).fill(0x61);
		const emDash = new Uint8Array([0xe2, 0x80, 0x94]);
		const suffix = new Uint8Array([0x0a]);
		const bytes = new Uint8Array(prefix.length + emDash.length + suffix.length);
		bytes.set(prefix, 0);
		bytes.set(emDash, prefix.length);
		bytes.set(suffix, prefix.length + emDash.length);

		await withTempBytes("sample.md", bytes, async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const readTool = getTool("read");

			const result = await readTool.execute(
				"r1",
				{ path: "sample.md" },
				undefined,
				undefined,
				makeToolContext(cwd),
			);

			expect(getText(result)).toContain("—");
		});
	});

	it("read accepts utf-8 xml that file-type recognizes as xml", async () => {
		await withTempFile(
			"layout.xml",
			'<?xml version="1.0" encoding="utf-8"?>\n<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android" />\n',
			async ({ cwd }) => {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const readTool = getTool("read");

				const result = await readTool.execute(
					"r1",
					{ path: "layout.xml" },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				const text = getText(result);
				expect(text).toContain("<LinearLayout");
				expect(text).not.toMatch(/binary file/i);
				// Text path renders hashline-prefixed lines (e.g. "1#<hash>:<?xml ...").
				expect(text).toMatch(/^\s*\d+#[ZPMQVRWSNKTXJBYH]{2}:<\?xml/m);
			},
		);
	});

	it("read rejects utf-16 xml as binary because of null bytes", async () => {
		const declaration = '<?xml version="1.0"?>\n<root/>\n';
		const payload = Buffer.from(declaration, "utf16le");
		const bytes = new Uint8Array(2 + payload.length);
		// UTF-16 LE BOM: file-type still detects this as application/xml, so the
		// regression guard relies on the null-byte check further down.
		bytes[0] = 0xff;
		bytes[1] = 0xfe;
		bytes.set(payload, 2);

		await withTempBytes("layout-utf16.xml", bytes, async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const readTool = getTool("read");

			await expect(
				readTool.execute(
					"r1",
					{ path: "layout-utf16.xml" },
					undefined,
					undefined,
					makeToolContext(cwd),
				),
			).rejects.toThrow(
				/binary file: layout-utf16\.xml \(null bytes detected\)/i,
			);
		});
	});

	it("read rejects binary files with classifier detail", async () => {
		await withTempBytes(
			"sample.bin",
			new Uint8Array([0x61, 0x00, 0x62, 0x63]),
			async ({ cwd }) => {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const readTool = getTool("read");

				await expect(
					readTool.execute("r1", { path: "sample.bin" }, undefined, undefined, makeToolContext(cwd)),
				).rejects.toThrow(
					/Path is a binary file: sample\.bin \(null bytes detected\)/i,
				);
			},
		);
	});

	it("read accepts invalid utf-8 without null bytes as replacement-character text", async () => {
		await withTempBytes(
			"sample.c",
			new Uint8Array([0xc3, 0x28, 0x0a]),
			async ({ cwd }) => {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const readTool = getTool("read");

				const result = await readTool.execute(
					"r1",
					{ path: "sample.c" },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				expect(getText(result)).toContain("�(");
			},
		);
	});

	// Matches pi's built-in read/edit, which both decode with a non-fatal
	// `buffer.toString("utf-8")` and write back as utf-8. Non-UTF-8 bytes
	// therefore survive `read` as U+FFFD and are re-encoded on `edit`, so any
	// invalid byte (even outside the edited region) is rewritten as the 3-byte
	// replacement sequence. This is lossy by design — the null-byte guard is the
	// line we hold to keep genuine binaries (with NUL) out of this path.
	it("edit decodes invalid utf-8 as replacement chars and writes them back as utf-8", async () => {
		await withTempBytes(
			"sample.c",
			new Uint8Array([0xc3, 0x28, 0x0a, 0x69, 0x6e, 0x74, 0x0a]),
			async ({ cwd, path }) => {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const editTool = getTool("edit");

				await editTool.execute(
					"e1",
					{ path: "sample.c", oldText: "int", newText: "long" },
					undefined,
					undefined,
					makeToolContext(cwd),
				);

				await expect(readFile(path)).resolves.toEqual(
					Buffer.from("�(\nlong\n", "utf-8"),
				);
			},
		);
	});

	it("edit still rejects binaries with null bytes before writing", async () => {
		await withTempBytes(
			"sample.bin",
			new Uint8Array([0x69, 0x6e, 0x74, 0x00, 0x0a]),
			async ({ cwd }) => {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const editTool = getTool("edit");

				await expect(
					editTool.execute(
						"e1",
						{ path: "sample.bin", oldText: "int", newText: "long" },
						undefined,
						undefined,
						makeToolContext(cwd),
					),
				).rejects.toThrow(/binary file: sample\.bin \(null bytes detected\)/i);
			},
		);
	});

	it("read delegates supported images to the built-in read tool", async () => {
		const { pi, getTool } = makeFakePiRegistry();
		register(pi);
		const readTool = getTool("read");

		const result = await readTool.execute(
			"r1",
			{ path: "assets/banner.jpeg" },
			undefined,
			undefined,
			makeToolContext(process.cwd()),
		);

		// The built-in tool leads with a "Read image file [mime]" text note in
		// both its inline-image and omitted-image variants; the hashline text
		// path never produces it, so this pins the delegation seam.
		expect(getText(result)).toContain("Read image file");
		expect(getText(result)).not.toMatch(/^\s*\d+#/m);
	});

	it("edit rejects image files without writing", async () => {
		const { pi, getTool } = makeFakePiRegistry();
		register(pi);
		const editTool = getTool("edit");

		await expect(
			editTool.execute(
				"e1",
				{ path: "assets/banner.jpeg", oldText: "a", newText: "b" },
				undefined,
				undefined,
				makeToolContext(process.cwd()),
			),
		).rejects.toThrow(/image file/i);
	});

	it("edit rejects binary files before reading them as text", async () => {
		await withTempBytes(
			"sample.bin",
			new Uint8Array([0x61, 0x00, 0x62, 0x63]),
			async ({ cwd }) => {
				const { pi, getTool } = makeFakePiRegistry();
				register(pi);
				const editTool = getTool("edit");

				await expect(
					editTool.execute(
						"e1",
						{
							path: "sample.bin",
							oldText: "a",
							newText: "A",
						},
						undefined,
						undefined,
						makeToolContext(cwd),
					),
				).rejects.toThrow(/binary file: sample\.bin/i);
			},
		);
	});
});
