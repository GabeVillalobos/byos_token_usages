import { unstable_cache } from "next/cache";
import { z } from "zod";
import type { TokenUsageEntry } from "./aggregate";

// Usage data is live; never serve a statically-rendered snapshot.
export const dynamic = "force-dynamic";

/**
 * The transport seam for the token-usage recipe.
 *
 * Everything downstream (`aggregate.ts`, the screen component) consumes raw
 * entries, so moving the source from an HTTP feed to a Postgres query means
 * replacing `fetchEntries` alone.
 */

export type TokenUsageParams = {
	sourceUrl?: string;
	lookbackHours?: number | string;
	includeSidechains?: boolean;
};

export type TokenUsageFetchResult = {
	entries: TokenUsageEntry[];
	fetchedAt: string;
	sourceLabel: string;
};

/** Well under the runtime's 10s hard cap in `lib/recipes/runtime/react.ts`. */
const FETCH_TIMEOUT_MS = 7_000;

/**
 * Counters are optional so a partial record still contributes what it has;
 * `aggregate.ts` treats missing values as zero either way.
 */
const usageEntrySchema = z.object({
	id: z.string().default(""),
	ts: z.string().default(""),
	session_id: z.string().default(""),
	prompt_id: z.string().nullable().default(null),
	agent_id: z.string().nullable().default(null),
	is_sidechain: z.boolean().default(false),
	model: z.string().default("unknown"),
	input_tokens: z.number().default(0),
	output_tokens: z.number().default(0),
	cache_creation_input_tokens: z.number().default(0),
	cache_read_input_tokens: z.number().default(0),
});

/**
 * Rendered whenever no source is configured or the fetch fails, so the recipe
 * shows a meaningful screen the moment it appears in the catalog. Spread over
 * a few hours and models so the lookback and sidechain params visibly do
 * something during authoring.
 */
const SAMPLE_ENTRIES: TokenUsageEntry[] = [
	{
		id: "s1",
		ts: "2026-08-17T14:52:00Z",
		session_id: "sess-a",
		prompt_id: "p-1",
		agent_id: null,
		is_sidechain: false,
		model: "claude-opus-5",
		input_tokens: 18_400,
		output_tokens: 9_600,
		cache_creation_input_tokens: 121_000,
		cache_read_input_tokens: 2_480_000,
	},
	{
		id: "s2",
		ts: "2026-08-17T14:20:00Z",
		session_id: "sess-a",
		prompt_id: "p-2",
		agent_id: null,
		is_sidechain: false,
		model: "claude-opus-5",
		input_tokens: 12_100,
		output_tokens: 14_300,
		cache_creation_input_tokens: 86_500,
		cache_read_input_tokens: 1_910_000,
	},
	{
		id: "s3",
		ts: "2026-08-17T13:05:00Z",
		session_id: "sess-b",
		prompt_id: "p-3",
		agent_id: "explore",
		is_sidechain: true,
		model: "claude-sonnet-5",
		input_tokens: 31_700,
		output_tokens: 6_200,
		cache_creation_input_tokens: 64_000,
		cache_read_input_tokens: 1_240_000,
	},
	{
		id: "s4",
		ts: "2026-08-17T11:41:00Z",
		session_id: "sess-b",
		prompt_id: "p-4",
		agent_id: null,
		is_sidechain: false,
		model: "claude-sonnet-5",
		input_tokens: 9_800,
		output_tokens: 4_100,
		cache_creation_input_tokens: 38_200,
		cache_read_input_tokens: 690_000,
	},
	{
		id: "s5",
		ts: "2026-08-17T09:18:00Z",
		session_id: "sess-c",
		prompt_id: "p-5",
		agent_id: "statusline",
		is_sidechain: true,
		model: "claude-haiku-4-5-20251001",
		input_tokens: 5_600,
		output_tokens: 1_900,
		cache_creation_input_tokens: 12_400,
		cache_read_input_tokens: 318_000,
	},
	{
		id: "s6",
		ts: "2026-08-16T22:07:00Z",
		session_id: "sess-c",
		prompt_id: "p-6",
		agent_id: null,
		is_sidechain: false,
		model: "claude-haiku-4-5-20251001",
		input_tokens: 2_300,
		output_tokens: 800,
		cache_creation_input_tokens: 4_100,
		cache_read_input_tokens: 96_000,
	},
	{
		id: "s7",
		ts: "2026-08-16T18:30:00Z",
		session_id: "sess-d",
		prompt_id: "p-7",
		agent_id: null,
		is_sidechain: false,
		model: "claude-fable-5",
		input_tokens: 4_200,
		output_tokens: 2_600,
		cache_creation_input_tokens: 9_800,
		cache_read_input_tokens: 142_000,
	},
];

export const SAMPLE_SOURCE_LABEL = "Sample data";

/**
 * Accept the three shapes a usage feed plausibly arrives in: a bare JSON
 * array, an envelope with an `entries`/`data` array, or NDJSON (one record per
 * line). Rows that fail validation are skipped rather than failing the render.
 */
export function parseEntries(body: string): TokenUsageEntry[] {
	const trimmed = body.trim();
	if (!trimmed) return [];

	const candidates: unknown[] = [];
	try {
		const parsed = JSON.parse(trimmed);
		if (Array.isArray(parsed)) {
			candidates.push(...parsed);
		} else if (parsed && typeof parsed === "object") {
			const envelope = parsed as Record<string, unknown>;
			const list = envelope.entries ?? envelope.data ?? envelope.rows;
			if (Array.isArray(list)) candidates.push(...list);
			else candidates.push(parsed);
		}
	} catch {
		// Not a single JSON document — try NDJSON/JSONL.
		for (const line of trimmed.split("\n")) {
			const value = line.trim();
			if (!value) continue;
			try {
				candidates.push(JSON.parse(value));
			} catch {
				// Skip malformed lines.
			}
		}
	}

	const entries: TokenUsageEntry[] = [];
	for (const candidate of candidates) {
		const result = usageEntrySchema.safeParse(candidate);
		if (result.success) entries.push(result.data);
	}
	return entries;
}

/** Replace this body with a Postgres query when the table lands. */
async function fetchEntries(sourceUrl: string): Promise<TokenUsageEntry[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(sourceUrl, {
			signal: controller.signal,
			headers: { Accept: "application/json, application/x-ndjson, text/plain" },
		});
		if (!response.ok) {
			throw new Error(`Usage feed responded ${response.status}`);
		}
		const entries = parseEntries(await response.text());
		if (entries.length === 0) {
			throw new Error("Usage feed returned no usable entries");
		}
		return entries;
	} finally {
		clearTimeout(timeout);
	}
}

function hostLabel(sourceUrl: string): string {
	try {
		return new URL(sourceUrl).hostname;
	} catch {
		return "Usage feed";
	}
}

function formatFetchedAt(): string {
	return new Date().toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
}

export default async function getData(
	params?: TokenUsageParams,
): Promise<TokenUsageFetchResult> {
	const sourceUrl = params?.sourceUrl?.trim() ?? "";

	if (!sourceUrl) {
		return {
			entries: SAMPLE_ENTRIES,
			fetchedAt: formatFetchedAt(),
			sourceLabel: SAMPLE_SOURCE_LABEL,
		};
	}

	try {
		const cached = unstable_cache(
			() => fetchEntries(sourceUrl),
			["token-usage-feed", sourceUrl],
			{ tags: ["token-usage", sourceUrl], revalidate: 300 },
		);
		return {
			entries: await cached(),
			fetchedAt: formatFetchedAt(),
			sourceLabel: hostLabel(sourceUrl),
		};
	} catch (error) {
		console.error("Error fetching token usage:", error);
		return {
			entries: SAMPLE_ENTRIES,
			fetchedAt: formatFetchedAt(),
			sourceLabel: SAMPLE_SOURCE_LABEL,
		};
	}
}
