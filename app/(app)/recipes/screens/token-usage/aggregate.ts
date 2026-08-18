/**
 * Pure aggregation for the token-usage recipe.
 *
 * Deliberately free of I/O and of React so the eventual swap from an HTTP feed
 * to a Postgres query touches only `getData.ts`, and so the bucketing math can
 * be unit-tested on its own (same split as `calendar/day-count.ts`).
 */

export type TokenUsageEntry = {
	id: string;
	ts: string;
	session_id: string;
	prompt_id: string | null;
	agent_id: string | null;
	is_sidechain: boolean;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
};

/**
 * The four token counters, in stacking order (left to right on the bar).
 *
 * Shades run darkest to lightest. Cache reads normally dominate by volume, so
 * the biggest area gets the lightest pattern; the reverse would flood the
 * screen with black and bury the small input/output segments.
 */
export const TOKEN_SEGMENTS = [
	{ key: "input", label: "In", field: "input_tokens", dither: 1000 },
	{ key: "output", label: "Out", field: "output_tokens", dither: 700 },
	{
		key: "cacheWrite",
		label: "Cache W",
		field: "cache_creation_input_tokens",
		dither: 400,
	},
	{
		key: "cacheRead",
		label: "Cache R",
		field: "cache_read_input_tokens",
		dither: 150,
	},
] as const;

export type ModelUsage = {
	/** Raw model identifier, or `__other__` for the folded overflow row. */
	model: string;
	/** Display-shortened label. */
	label: string;
	total: number;
	/** Per-counter totals, parallel to `TOKEN_SEGMENTS`. */
	segments: number[];
};

export type AggregateOptions = {
	/** Epoch ms treated as "now" for the lookback window. */
	now: number;
	/** Only count entries newer than this many hours. `0` means all time. */
	lookbackHours: number;
	includeSidechains: boolean;
	/** Hard cap on rendered rows; the tail folds into a single "Other" row. */
	maxRows: number;
};

export type AggregateResult = {
	rows: ModelUsage[];
	/** Sum across every row that survived filtering. */
	grandTotal: number;
	/** Largest single row total — the scale the bars are drawn against. */
	maxTotal: number;
	/** Number of entries that survived filtering. */
	entryCount: number;
	/** Distinct models before overflow folding. */
	modelCount: number;
	windowLabel: string;
};

export const OTHER_MODEL_KEY = "__other__";

/** Coerce a counter to a non-negative integer; anything odd becomes 0. */
function toCount(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.round(n);
}

/**
 * Shorten a model id to something that fits an e-ink label column while
 * keeping the part that distinguishes it: `us.anthropic.claude-opus-5[1m]`
 * and `claude-haiku-4-5-20251001` become `opus-5[1m]` and `haiku-4-5`.
 */
export function formatModelLabel(model: string): string {
	let label = model.trim();
	if (!label) return "unknown";

	label = label.replace(/^(us|eu|apac)\./i, "");
	label = label.replace(/^anthropic[./]/i, "");
	// Bedrock/Vertex suffixes such as ":0" or "-v1:0".
	label = label.replace(/(-v\d+)?:\d+$/i, "");
	// Trailing release stamps: -20251001.
	label = label.replace(/-\d{8}$/, "");
	label = label.replace(/^claude-/i, "");

	return label || model;
}

/** Compact token count: 1200000 -> "1.2M", 8120 -> "8.1K". */
export function formatTokens(value: number): string {
	const n = Math.round(value);
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 10_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return `${n}`;
}

/** "Last 24h" / "Last 7d" / "All time". */
export function formatWindowLabel(lookbackHours: number): string {
	if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) return "All time";
	if (lookbackHours < 1) return `Last ${Math.round(lookbackHours * 60)}m`;
	if (lookbackHours % 24 === 0) return `Last ${lookbackHours / 24}d`;
	return `Last ${Math.round(lookbackHours)}h`;
}

export function aggregateUsage(
	entries: readonly TokenUsageEntry[],
	{ now, lookbackHours, includeSidechains, maxRows }: AggregateOptions,
): AggregateResult {
	const cutoff =
		Number.isFinite(lookbackHours) && lookbackHours > 0
			? now - lookbackHours * 3_600_000
			: null;

	const totals = new Map<string, ModelUsage>();
	let entryCount = 0;
	let grandTotal = 0;

	for (const entry of entries) {
		if (!entry) continue;
		if (!includeSidechains && entry.is_sidechain) continue;

		if (cutoff !== null) {
			const at = Date.parse(entry.ts);
			// An unparseable timestamp is kept: dropping it would silently
			// understate usage, which is worse than a slightly loose window.
			if (Number.isFinite(at) && at < cutoff) continue;
		}

		const model = entry.model?.trim() || "unknown";
		let bucket = totals.get(model);
		if (!bucket) {
			bucket = {
				model,
				label: formatModelLabel(model),
				total: 0,
				segments: TOKEN_SEGMENTS.map(() => 0),
			};
			totals.set(model, bucket);
		}

		TOKEN_SEGMENTS.forEach((segment, index) => {
			const value = toCount(entry[segment.field]);
			bucket.segments[index] += value;
			bucket.total += value;
			grandTotal += value;
		});
		entryCount += 1;
	}

	const sorted = [...totals.values()].sort(
		(a, b) => b.total - a.total || a.model.localeCompare(b.model),
	);

	const rows = foldOverflow(sorted, maxRows);
	const maxTotal = rows.length > 0 ? Math.max(...rows.map((r) => r.total)) : 0;

	return {
		rows,
		grandTotal,
		maxTotal,
		entryCount,
		modelCount: sorted.length,
		windowLabel: formatWindowLabel(lookbackHours),
	};
}

/**
 * Collapse everything past `maxRows - 1` into one "Other" row so the chart can
 * never outgrow the canvas. Folding only kicks in when it actually saves a row
 * (two models over the limit), otherwise the last model is shown by name.
 */
function foldOverflow(sorted: ModelUsage[], maxRows: number): ModelUsage[] {
	const limit = Math.max(1, Math.floor(maxRows));
	if (sorted.length <= limit) return sorted;

	const head = sorted.slice(0, limit - 1);
	const tail = sorted.slice(limit - 1);

	const other: ModelUsage = {
		model: OTHER_MODEL_KEY,
		label: `Other (${tail.length})`,
		total: 0,
		segments: TOKEN_SEGMENTS.map(() => 0),
	};
	for (const row of tail) {
		other.total += row.total;
		row.segments.forEach((value, index) => {
			other.segments[index] += value;
		});
	}

	return [...head, other];
}

/**
 * Turn a row's per-segment token counts into pixel widths.
 *
 * `scaleTotal` is the largest row's total, so bar lengths are comparable and
 * the top row fills the track. Non-zero segments are floored at
 * `minSegmentPx` — a 0.3% slice must stay a visible sliver rather than
 * disappear — and any resulting overflow is taken back off the widest segment
 * so the row never exceeds `trackWidth`.
 */
export function allocateSegmentWidths(
	segments: readonly number[],
	{
		trackWidth,
		scaleTotal,
		minSegmentPx,
	}: { trackWidth: number; scaleTotal: number; minSegmentPx: number },
): number[] {
	const available = Math.max(0, Math.floor(trackWidth));
	const widths = segments.map(() => 0);
	if (available === 0 || scaleTotal <= 0) return widths;

	const floor = Math.max(1, Math.floor(minSegmentPx));

	segments.forEach((value, index) => {
		if (value <= 0) return;
		const raw = Math.round((value / scaleTotal) * available);
		widths[index] = Math.max(floor, raw);
	});

	let overflow = widths.reduce((sum, w) => sum + w, 0) - available;
	// Shave the widest segment first: it can absorb the loss without changing
	// how the bar reads, whereas trimming a sliver would erase it.
	while (overflow > 0) {
		let widest = -1;
		for (let index = 0; index < widths.length; index += 1) {
			if (
				widths[index] > 1 &&
				(widest === -1 || widths[index] > widths[widest])
			)
				widest = index;
		}
		if (widest === -1) break;
		const take = Math.min(overflow, widths[widest] - 1);
		widths[widest] -= take;
		overflow -= take;
	}

	return widths;
}
