import {
	aggregateUsage,
	allocateSegmentWidths,
	formatModelLabel,
	formatTokens,
	formatWindowLabel,
	OTHER_MODEL_KEY,
	type TokenUsageEntry,
} from "./aggregate";

const NOW = Date.parse("2026-08-17T18:00:00Z");

function entry(overrides: Partial<TokenUsageEntry> = {}): TokenUsageEntry {
	return {
		id: "e",
		ts: "2026-08-17T17:00:00Z",
		session_id: "s",
		prompt_id: null,
		agent_id: null,
		is_sidechain: false,
		model: "claude-opus-5",
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		...overrides,
	};
}

const OPTS = {
	now: NOW,
	lookbackHours: 0,
	includeSidechains: true,
	maxRows: 8,
};

describe("aggregateUsage", () => {
	it("groups by model and sums all four counters", () => {
		const result = aggregateUsage(
			[
				entry({ model: "a", input_tokens: 10, output_tokens: 5 }),
				entry({
					model: "a",
					cache_creation_input_tokens: 3,
					cache_read_input_tokens: 100,
				}),
				entry({ model: "b", input_tokens: 7 }),
			],
			OPTS,
		);

		expect(result.rows).toHaveLength(2);
		expect(result.rows[0].model).toBe("a");
		expect(result.rows[0].segments).toEqual([10, 5, 3, 100]);
		expect(result.rows[0].total).toBe(118);
		expect(result.grandTotal).toBe(125);
		expect(result.maxTotal).toBe(118);
		expect(result.entryCount).toBe(3);
		expect(result.modelCount).toBe(2);
	});

	it("sorts descending by total and tie-breaks on model name", () => {
		const result = aggregateUsage(
			[
				entry({ model: "zed", input_tokens: 50 }),
				entry({ model: "big", input_tokens: 90 }),
				entry({ model: "abe", input_tokens: 50 }),
			],
			OPTS,
		);

		expect(result.rows.map((r) => r.model)).toEqual(["big", "abe", "zed"]);
	});

	it("folds the tail into a single Other row at maxRows", () => {
		const entries = ["a", "b", "c", "d", "e"].map((model, index) =>
			entry({ model, input_tokens: (5 - index) * 100 }),
		);

		const result = aggregateUsage(entries, { ...OPTS, maxRows: 3 });

		expect(result.rows).toHaveLength(3);
		expect(result.rows.map((r) => r.model)).toEqual([
			"a",
			"b",
			OTHER_MODEL_KEY,
		]);
		expect(result.rows[2].label).toBe("Other (3)");
		// c + d + e = 300 + 200 + 100
		expect(result.rows[2].total).toBe(600);
		expect(result.rows[2].segments).toEqual([600, 0, 0, 0]);
		// Folding must not change the overall total or the model count.
		expect(result.grandTotal).toBe(1500);
		expect(result.modelCount).toBe(5);
	});

	it("does not fold when the model count fits exactly", () => {
		const entries = ["a", "b", "c"].map((model) =>
			entry({ model, input_tokens: 10 }),
		);

		const result = aggregateUsage(entries, { ...OPTS, maxRows: 3 });

		expect(result.rows.map((r) => r.model)).toEqual(["a", "b", "c"]);
	});

	it("excludes sidechain entries when asked", () => {
		const entries = [
			entry({ model: "a", input_tokens: 10 }),
			entry({ model: "a", input_tokens: 90, is_sidechain: true }),
		];

		expect(aggregateUsage(entries, OPTS).grandTotal).toBe(100);
		expect(
			aggregateUsage(entries, { ...OPTS, includeSidechains: false }).grandTotal,
		).toBe(10);
	});

	it("drops entries older than the lookback window", () => {
		const entries = [
			entry({ ts: "2026-08-17T17:30:00Z", input_tokens: 10 }),
			entry({ ts: "2026-08-16T09:00:00Z", input_tokens: 90 }),
		];

		const result = aggregateUsage(entries, { ...OPTS, lookbackHours: 2 });

		expect(result.grandTotal).toBe(10);
		expect(result.entryCount).toBe(1);
		expect(result.windowLabel).toBe("Last 2h");
	});

	it("keeps entries whose timestamp cannot be parsed", () => {
		const result = aggregateUsage(
			[entry({ ts: "not-a-date", input_tokens: 42 })],
			{ ...OPTS, lookbackHours: 1 },
		);

		expect(result.grandTotal).toBe(42);
	});

	it("coerces missing, negative, and non-numeric counters to zero", () => {
		const result = aggregateUsage(
			[
				entry({
					input_tokens: -50,
					output_tokens: Number.NaN,
					cache_read_input_tokens: 20,
				}),
				{ ...entry(), input_tokens: undefined } as unknown as TokenUsageEntry,
			],
			OPTS,
		);

		expect(result.rows[0].segments).toEqual([0, 0, 0, 20]);
		expect(result.grandTotal).toBe(20);
	});

	it("buckets blank model names under 'unknown'", () => {
		const result = aggregateUsage(
			[entry({ model: "  ", input_tokens: 5 })],
			OPTS,
		);

		expect(result.rows[0].model).toBe("unknown");
	});

	it("returns an empty, safe result for no input", () => {
		const result = aggregateUsage([], OPTS);

		expect(result.rows).toEqual([]);
		expect(result.grandTotal).toBe(0);
		expect(result.maxTotal).toBe(0);
		expect(result.modelCount).toBe(0);
		expect(result.windowLabel).toBe("All time");
	});
});

describe("allocateSegmentWidths", () => {
	const OPTIONS = { trackWidth: 200, scaleTotal: 1000, minSegmentPx: 3 };

	it("splits proportionally and fills the track for the largest row", () => {
		const widths = allocateSegmentWidths([250, 250, 250, 250], OPTIONS);

		expect(widths).toEqual([50, 50, 50, 50]);
	});

	it("scales a smaller row against the largest row's total", () => {
		const widths = allocateSegmentWidths([100, 100, 0, 0], OPTIONS);

		expect(widths).toEqual([20, 20, 0, 0]);
		expect(widths.reduce((a, b) => a + b, 0)).toBe(40);
	});

	it("keeps a tiny non-zero segment visible", () => {
		const widths = allocateSegmentWidths([1, 999, 0, 0], OPTIONS);

		expect(widths[0]).toBeGreaterThanOrEqual(3);
	});

	it("never exceeds the track width, even when every segment is bumped", () => {
		const widths = allocateSegmentWidths([1, 1, 1, 1], {
			trackWidth: 6,
			scaleTotal: 1000,
			minSegmentPx: 3,
		});

		expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6);
		expect(widths.every((w) => w > 0)).toBe(true);
	});

	it("leaves zero-valued segments at zero", () => {
		const widths = allocateSegmentWidths([0, 0, 0, 1000], OPTIONS);

		expect(widths.slice(0, 3)).toEqual([0, 0, 0]);
		expect(widths[3]).toBe(200);
	});

	it("returns all zeros for a degenerate scale or track", () => {
		expect(
			allocateSegmentWidths([10, 10, 10, 10], { ...OPTIONS, scaleTotal: 0 }),
		).toEqual([0, 0, 0, 0]);
		expect(
			allocateSegmentWidths([10, 10, 10, 10], { ...OPTIONS, trackWidth: 0 }),
		).toEqual([0, 0, 0, 0]);
	});
});

describe("formatting helpers", () => {
	it("shortens model identifiers", () => {
		expect(formatModelLabel("claude-opus-5")).toBe("opus-5");
		expect(formatModelLabel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
		expect(formatModelLabel("us.anthropic.claude-sonnet-5")).toBe("sonnet-5");
		expect(formatModelLabel("anthropic/claude-fable-5")).toBe("fable-5");
		expect(formatModelLabel("claude-opus-5[1m]")).toBe("opus-5[1m]");
		expect(formatModelLabel("")).toBe("unknown");
	});

	it("formats token counts compactly", () => {
		expect(formatTokens(940)).toBe("940");
		expect(formatTokens(8_120)).toBe("8.1K");
		expect(formatTokens(812_000)).toBe("812K");
		expect(formatTokens(1_240_000)).toBe("1.2M");
		expect(formatTokens(12_400_000)).toBe("12M");
		expect(formatTokens(2_400_000_000)).toBe("2.4B");
	});

	it("describes the lookback window", () => {
		expect(formatWindowLabel(0)).toBe("All time");
		expect(formatWindowLabel(6)).toBe("Last 6h");
		expect(formatWindowLabel(24)).toBe("Last 1d");
		expect(formatWindowLabel(168)).toBe("Last 7d");
	});
});
