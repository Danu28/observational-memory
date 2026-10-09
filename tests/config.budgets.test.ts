import { describe, expect, it } from "vitest";

import { DEFAULTS, resolveBudgets, type Config } from "../src/config.js";

const none = new Set<string>();

describe("resolveBudgets", () => {
	it("falls back to the 200K-tuned absolute defaults when the window is unknown", () => {
		expect(resolveBudgets(DEFAULTS, none, undefined)).toEqual({
			chunkTokens: 10_000,
			poolTargetTokens: 10_000,
			consolidateAtPoolTokens: 15_000,
			compactAtContextTokens: 150_000,
			tailTokens: 20_000,
		});
	});

	it("scales every budget to a 1M window (the reported model)", () => {
		// 1M window: chunk 5% = 50K, pool = 1 chunk = 50K, consolidate = 1.5 chunks = 75K,
		// compact 60% = 600K, tail 10% = 100K.
		expect(resolveBudgets(DEFAULTS, none, 1_000_000)).toEqual({
			chunkTokens: 50_000,
			poolTargetTokens: 50_000,
			consolidateAtPoolTokens: 75_000,
			compactAtContextTokens: 600_000,
			tailTokens: 100_000,
		});
	});

	it("keeps the historical 200K numbers (except compaction, now 60%)", () => {
		expect(resolveBudgets(DEFAULTS, none, 200_000)).toEqual({
			chunkTokens: 10_000,
			poolTargetTokens: 10_000,
			consolidateAtPoolTokens: 15_000,
			compactAtContextTokens: 120_000,
			tailTokens: 20_000,
		});
	});

	it("honors an explicit absolute chunkTokens and derives the pool from it", () => {
		const config: Config = { ...DEFAULTS, chunkTokens: 8_000 };
		const budgets = resolveBudgets(config, new Set(["chunkTokens"]), 1_000_000);
		expect(budgets.chunkTokens).toBe(8_000); // pinned, not 50K
		expect(budgets.poolTargetTokens).toBe(8_000);
		expect(budgets.consolidateAtPoolTokens).toBe(12_000);
		expect(budgets.compactAtContextTokens).toBe(600_000); // still percent-scaled
		expect(budgets.tailTokens).toBe(100_000);
	});

	it("honors an explicit absolute compaction threshold over the percent", () => {
		const config: Config = { ...DEFAULTS, compactAtContextTokens: 250_000 };
		const budgets = resolveBudgets(config, new Set(["compactAtContextTokens"]), 1_000_000);
		expect(budgets.compactAtContextTokens).toBe(250_000);
		expect(budgets.chunkTokens).toBe(50_000);
	});

	it("honors explicit pool budgets when both are pinned", () => {
		const config: Config = { ...DEFAULTS, poolTargetTokens: 7_000, consolidateAtPoolTokens: 9_000 };
		const budgets = resolveBudgets(config, new Set(["poolTargetTokens", "consolidateAtPoolTokens"]), 1_000_000);
		expect(budgets.poolTargetTokens).toBe(7_000);
		expect(budgets.consolidateAtPoolTokens).toBe(9_000);
	});

	it("respects a tuned percent", () => {
		const config: Config = { ...DEFAULTS, observerChunkPercent: 0.02, compactAtContextPercent: 0.45 };
		const budgets = resolveBudgets(config, none, 1_000_000);
		expect(budgets.chunkTokens).toBe(20_000);
		expect(budgets.consolidateAtPoolTokens).toBe(30_000);
		expect(budgets.compactAtContextTokens).toBe(450_000);
	});

	it("clamps tiny windows so the observer chunk stays usable", () => {
		const budgets = resolveBudgets(DEFAULTS, none, 20_000);
		expect(budgets.chunkTokens).toBe(2_000); // min clamp (5% would be 1K)
		expect(budgets.poolTargetTokens).toBe(2_000);
		expect(budgets.consolidateAtPoolTokens).toBe(3_000);
		expect(budgets.tailTokens).toBe(2_000);
	});

	it("treats a non-positive or non-finite window as unknown", () => {
		const fallback = resolveBudgets(DEFAULTS, none, undefined);
		expect(resolveBudgets(DEFAULTS, none, 0)).toEqual(fallback);
		expect(resolveBudgets(DEFAULTS, none, Number.NaN)).toEqual(fallback);
	});
});
