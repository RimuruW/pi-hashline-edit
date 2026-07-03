import { describe, expect, it, beforeEach } from "vitest";
import {
	getReadSnapshot,
	getReadSnapshotVersions,
	rememberReadSnapshot,
	resetReadSnapshot,
} from "../../src/read-snapshot";

// Re-export private constants via a trick — we test behaviour, not internals,
// so limits are exercised by calling rememberReadSnapshot enough times.

describe("read-snapshot — multi-version LRU", () => {
	beforeEach(() => {
		resetReadSnapshot();
	});

	// ── Basic get/set ──────────────────────────────────────────────────────

	it("returns null for unknown path", () => {
		expect(getReadSnapshot("/unknown")).toBeNull();
	});

	it("stores and retrieves the most recent version", () => {
		rememberReadSnapshot("/a", "v1");
		expect(getReadSnapshot("/a")).toBe("v1");
	});

	it("getReadSnapshotVersions returns empty array for unknown path", () => {
		expect(getReadSnapshotVersions("/unknown")).toEqual([]);
	});

	it("getReadSnapshotVersions returns single version", () => {
		rememberReadSnapshot("/a", "v1");
		expect(getReadSnapshotVersions("/a")).toEqual(["v1"]);
	});

	it("getReadSnapshotVersions returns newest-first order", () => {
		rememberReadSnapshot("/a", "v1");
		rememberReadSnapshot("/a", "v2");
		rememberReadSnapshot("/a", "v3");
		expect(getReadSnapshotVersions("/a")).toEqual(["v3", "v2", "v1"]);
	});

	it("getReadSnapshot always returns the newest version", () => {
		rememberReadSnapshot("/a", "v1");
		rememberReadSnapshot("/a", "v2");
		expect(getReadSnapshot("/a")).toBe("v2");
	});

	// ── Read fusion (duplicate suppression) ────────────────────────────────

	it("does not store duplicate versions when content is identical (read fusion)", () => {
		rememberReadSnapshot("/a", "same");
		rememberReadSnapshot("/a", "same");
		rememberReadSnapshot("/a", "same");
		expect(getReadSnapshotVersions("/a")).toEqual(["same"]);
	});

	it("does store a new version when content differs", () => {
		rememberReadSnapshot("/a", "v1");
		rememberReadSnapshot("/a", "v2");
		expect(getReadSnapshotVersions("/a")).toHaveLength(2);
	});

	// ── Version-count limit (MAX_VERSIONS_PER_PATH = 4) ───────────────────

	it("caps versions per path at 4, evicting the oldest", () => {
		for (let i = 1; i <= 5; i++) {
			rememberReadSnapshot("/a", `v${i}`);
		}
		const versions = getReadSnapshotVersions("/a");
		expect(versions).toHaveLength(4);
		// newest four: v5, v4, v3, v2 — v1 was evicted
		expect(versions).toEqual(["v5", "v4", "v3", "v2"]);
	});

	// ── Path-count limit (MAX_PATHS = 8) ──────────────────────────────────

	it("evicts the LRU path when the 9th path is written", () => {
		// Write 8 different paths, then a 9th.
		for (let i = 1; i <= 8; i++) {
			rememberReadSnapshot(`/p${i}`, `content-${i}`);
		}
		// /p1 is now the LRU path (written first, never touched since).
		rememberReadSnapshot("/p9", "content-9");

		// /p1 should be gone
		expect(getReadSnapshot("/p1")).toBeNull();
		expect(getReadSnapshotVersions("/p1")).toEqual([]);

		// /p9 should be present
		expect(getReadSnapshot("/p9")).toBe("content-9");
	});

	it("does not evict the 8th path when fewer than 9 paths exist", () => {
		for (let i = 1; i <= 8; i++) {
			rememberReadSnapshot(`/p${i}`, `content-${i}`);
		}
		// All 8 should still be present
		for (let i = 1; i <= 8; i++) {
			expect(getReadSnapshot(`/p${i}`)).toBe(`content-${i}`);
		}
	});

	// ── LRU ordering (recently-used path survives eviction) ───────────────

	it("reading /p1 again promotes it above LRU so /p2 is evicted instead", () => {
		for (let i = 1; i <= 8; i++) {
			rememberReadSnapshot(`/p${i}`, `content-${i}`);
		}
		// Touch /p1 so it moves to MRU position; now /p2 is LRU.
		rememberReadSnapshot("/p1", "content-1-updated");

		// Write a 9th path — /p2 (now LRU) should be evicted.
		rememberReadSnapshot("/p9", "content-9");

		expect(getReadSnapshot("/p2")).toBeNull();
		expect(getReadSnapshot("/p1")).toBe("content-1-updated");
		expect(getReadSnapshot("/p9")).toBe("content-9");
	});

	// ── resetReadSnapshot ──────────────────────────────────────────────────

	it("resetReadSnapshot clears everything", () => {
		rememberReadSnapshot("/a", "v1");
		rememberReadSnapshot("/b", "v2");
		resetReadSnapshot();
		expect(getReadSnapshot("/a")).toBeNull();
		expect(getReadSnapshot("/b")).toBeNull();
	});

	// ── getReadSnapshotVersions returns a copy ─────────────────────────────

	it("mutations to the returned versions array do not affect the store", () => {
		rememberReadSnapshot("/a", "v1");
		rememberReadSnapshot("/a", "v2");
		const versions = getReadSnapshotVersions("/a");
		versions.push("injected");
		expect(getReadSnapshotVersions("/a")).toHaveLength(2);
	});
});
