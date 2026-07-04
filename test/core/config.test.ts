import { describe, expect, it, afterEach } from "vitest";
import {
	parseHashlineConfig,
	exampleAnchor,
	getHashLength,
	getGrepEnabled,
	__resetConfigForTests,
	__setHashLengthForTests,
} from "../../src/config";

afterEach(() => {
	__resetConfigForTests();
});

describe("parseHashlineConfig — validation", () => {
	it("returns defaults for missing file (null input)", () => {
		// Simulate: file not found path uses defaults directly, but parseHashlineConfig
		// with a non-object input should warn and use defaults.
		const { config, warnings } = parseHashlineConfig(null);
		expect(config).toEqual({ hashLength: 2, grep: false });
		expect(warnings).toHaveLength(1);
	});

	it("returns defaults with no warnings for empty object", () => {
		const { config, warnings } = parseHashlineConfig({});
		expect(config).toEqual({ hashLength: 2, grep: false });
		expect(warnings).toHaveLength(0);
	});

	it("accepts valid hashLength 2", () => {
		const { config, warnings } = parseHashlineConfig({ hashLength: 2 });
		expect(config.hashLength).toBe(2);
		expect(warnings).toHaveLength(0);
	});

	it("accepts valid hashLength 3", () => {
		const { config, warnings } = parseHashlineConfig({ hashLength: 3 });
		expect(config.hashLength).toBe(3);
		expect(warnings).toHaveLength(0);
	});

	it("accepts valid hashLength 4 with grep true", () => {
		const { config, warnings } = parseHashlineConfig({ hashLength: 4, grep: true });
		expect(config.hashLength).toBe(4);
		expect(config.grep).toBe(true);
		expect(warnings).toHaveLength(0);
	});

	it("rejects hashLength 2.5 — falls back to 2 with warning", () => {
		const { config, warnings } = parseHashlineConfig({ hashLength: 2.5 });
		expect(config.hashLength).toBe(2);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/hashLength/);
	});

	it("rejects hashLength 1 — falls back to 2 with warning", () => {
		const { config, warnings } = parseHashlineConfig({ hashLength: 1 });
		expect(config.hashLength).toBe(2);
		expect(warnings).toHaveLength(1);
	});

	it('rejects hashLength "four" — falls back to 2 with warning', () => {
		const { config, warnings } = parseHashlineConfig({ hashLength: "four" });
		expect(config.hashLength).toBe(2);
		expect(warnings).toHaveLength(1);
	});

	it("rejects hashLength 100 — falls back to 2 with warning", () => {
		const { config, warnings } = parseHashlineConfig({ hashLength: 100 });
		expect(config.hashLength).toBe(2);
		expect(warnings).toHaveLength(1);
	});

	it('rejects grep "yes" — falls back to false with warning', () => {
		const { config, warnings } = parseHashlineConfig({ grep: "yes" });
		expect(config.grep).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/grep/);
	});

	it("rejects non-object input (array) — returns defaults with warning", () => {
		const { config, warnings } = parseHashlineConfig([{ hashLength: 3 }]);
		expect(config).toEqual({ hashLength: 2, grep: false });
		expect(warnings).toHaveLength(1);
	});

	it("rejects non-object input (string) — returns defaults with warning", () => {
		const { config, warnings } = parseHashlineConfig("hashLength=3");
		expect(config).toEqual({ hashLength: 2, grep: false });
		expect(warnings).toHaveLength(1);
	});

	it("ignores unknown fields without warnings", () => {
		const { config, warnings } = parseHashlineConfig({ hashLength: 3, unknownField: true });
		expect(config.hashLength).toBe(3);
		expect(warnings).toHaveLength(0);
	});

	it("rejects negative hashLength — falls back to 2 with warning", () => {
		const { config, warnings } = parseHashlineConfig({ hashLength: -1 });
		expect(config.hashLength).toBe(2);
		expect(warnings).toHaveLength(1);
	});

	it("rejects null hashLength — falls back to 2 with warning", () => {
		const { config, warnings } = parseHashlineConfig({ hashLength: null });
		expect(config.hashLength).toBe(2);
		expect(warnings).toHaveLength(1);
	});
});

describe("exampleAnchor", () => {
	it("returns 5#MQ at default length 2", () => {
		expect(exampleAnchor()).toBe("5#MQ");
	});

	it("returns 5#MQQ at length 3", () => {
		__setHashLengthForTests(3);
		expect(exampleAnchor()).toBe("5#MQQ");
	});

	it("returns 5#MQQV at length 4", () => {
		__setHashLengthForTests(4);
		expect(exampleAnchor()).toBe("5#MQQV");
	});

	it("accepts explicit len param overriding current config", () => {
		expect(exampleAnchor(4)).toBe("5#MQQV");
		expect(exampleAnchor(3)).toBe("5#MQQ");
		expect(exampleAnchor(2)).toBe("5#MQ");
	});
});

describe("test helpers isolation", () => {
	it("__setHashLengthForTests changes getHashLength", () => {
		__setHashLengthForTests(4);
		expect(getHashLength()).toBe(4);
	});

	it("__resetConfigForTests restores defaults", () => {
		__setHashLengthForTests(3);
		__resetConfigForTests();
		expect(getHashLength()).toBe(2);
		expect(getGrepEnabled()).toBe(false);
	});
});
