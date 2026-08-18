import { withExplicitUserScope, withUserScope } from "@/lib/database/scoped-db";
import { checkDbConnection } from "@/lib/database/utils";
import type { RecipeDataContext } from "@/lib/recipes/types";
import type { TokenUsageEntry } from "./aggregate";

// Usage data is live; never serve a statically-rendered snapshot.
export const dynamic = "force-dynamic";

/**
 * Reads token usage from `token_usage_events` (migration 0022).
 *
 * Rows are returned raw and aggregated in `aggregate.ts`, because the grouping
 * has to fold its tail into an "Other" row at a row count that depends on the
 * screen height — something this layer never sees. The `ts` window and the
 * sidechain filter are still applied in SQL so the read stays bounded; the
 * same filters in `aggregateUsage` are then no-ops on already-filtered rows.
 */

export type TokenUsageParams = {
	lookbackHours?: number | string;
	includeSidechains?: boolean;
};

export type TokenUsageFetchResult = {
	entries: TokenUsageEntry[];
	fetchedAt: string;
	sourceLabel: string;
};

/**
 * Ceiling on rows pulled into memory per render. Ordering is `ts DESC`, so
 * hitting the cap drops the oldest events in the window rather than a random
 * slice — and `sourceLabel` says so instead of quietly under-reporting.
 */
const MAX_EVENTS = 5_000;

export const SAMPLE_SOURCE_LABEL = "Sample data";
const LIVE_SOURCE_LABEL = "token_usage_events";

/**
 * Rendered for the in-browser preview, and when the database is unreachable or
 * un-migrated so `/recipes/token-usage` still previews in the README's no-DB
 * mode. On the device path a reachable-but-empty table deliberately falls
 * through to the component's "No usage in this window" state rather than
 * inventing numbers.
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

/** A row as Kysely hands it back, before wire types are normalised. */
type UsageRow = {
	event_id: string;
	ts: Date | string;
	session_id: string;
	prompt_id: string | null;
	agent_id: string | null;
	is_sidechain: boolean;
	model: string;
	input_tokens: string | number | bigint;
	output_tokens: string | number | bigint;
	cache_creation_input_tokens: string | number | bigint;
	cache_read_input_tokens: string | number | bigint;
};

/** `bigint` columns arrive from node-postgres as strings; `dataSchema` wants numbers. */
function toNumber(value: string | number | bigint): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function toEntry(row: UsageRow): TokenUsageEntry {
	return {
		// The recipe's entry shape keys off the emitter's own id, not the
		// table's surrogate UUID.
		id: row.event_id,
		ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
		session_id: row.session_id,
		prompt_id: row.prompt_id,
		agent_id: row.agent_id,
		is_sidechain: row.is_sidechain,
		model: row.model,
		input_tokens: toNumber(row.input_tokens),
		output_tokens: toNumber(row.output_tokens),
		cache_creation_input_tokens: toNumber(row.cache_creation_input_tokens),
		cache_read_input_tokens: toNumber(row.cache_read_input_tokens),
	};
}

function normalizeLookbackHours(value: number | string | undefined): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Not wrapped in `unstable_cache`: this is a local indexed read, and the
 * no-explicit-userId path resolves the session through `headers()`, which
 * throws inside a cache scope. `getScreenParams` — the other DB read in this
 * same render pipeline — is uncached for the same reason.
 */
async function fetchEntries({
	userId,
	lookbackHours,
	includeSidechains,
}: {
	userId?: string;
	lookbackHours: number;
	includeSidechains: boolean;
}): Promise<{ entries: TokenUsageEntry[]; truncated: boolean }> {
	const query = (
		scopedDb: Parameters<Parameters<typeof withUserScope>[0]>[0],
	) => {
		let builder = scopedDb
			.selectFrom("token_usage_events")
			.select([
				"event_id",
				"ts",
				"session_id",
				"prompt_id",
				"agent_id",
				"is_sidechain",
				"model",
				"input_tokens",
				"output_tokens",
				"cache_creation_input_tokens",
				"cache_read_input_tokens",
			]);

		if (lookbackHours > 0) {
			builder = builder.where(
				"ts",
				">=",
				new Date(Date.now() - lookbackHours * 3_600_000),
			);
		}
		if (!includeSidechains) {
			builder = builder.where("is_sidechain", "=", false);
		}

		// One past the cap, so a full page is distinguishable from an exact fit.
		return builder
			.orderBy("ts", "desc")
			.limit(MAX_EVENTS + 1)
			.execute();
	};

	const rows = userId
		? await withExplicitUserScope(userId, query)
		: await withUserScope(query);

	const truncated = rows.length > MAX_EVENTS;
	return {
		entries: rows.slice(0, MAX_EVENTS).map((row) => toEntry(row as UsageRow)),
		truncated,
	};
}

function formatFetchedAt(): string {
	return new Date().toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
}

export default async function getData(
	params?: TokenUsageParams,
	context?: RecipeDataContext,
): Promise<TokenUsageFetchResult> {
	// The preview is a layout surface: it renders whatever tenant happens to be
	// signed in, which is empty as often as not, and the reader cannot tell a
	// working chart from a broken one. Fixed sample data keeps it legible and
	// keeps a design tweak from costing a query. Devices are unaffected — only
	// `/recipes/{slug}/preview` sets this flag.
	if (context?.preview) {
		return {
			entries: SAMPLE_ENTRIES,
			fetchedAt: formatFetchedAt(),
			sourceLabel: SAMPLE_SOURCE_LABEL,
		};
	}

	const { ready, error } = await checkDbConnection();
	if (!ready) {
		console.warn(
			"[recipe:token-usage] database not ready, using sample data:",
			error,
		);
		return {
			entries: SAMPLE_ENTRIES,
			fetchedAt: formatFetchedAt(),
			sourceLabel: SAMPLE_SOURCE_LABEL,
		};
	}

	try {
		const { entries, truncated } = await fetchEntries({
			userId: context?.userId,
			lookbackHours: normalizeLookbackHours(params?.lookbackHours),
			includeSidechains: params?.includeSidechains ?? true,
		});

		if (truncated) {
			console.warn(
				`[recipe:token-usage] window exceeds ${MAX_EVENTS} events; totals cover the most recent ${MAX_EVENTS}`,
			);
		}

		return {
			entries,
			fetchedAt: formatFetchedAt(),
			sourceLabel: truncated
				? `${LIVE_SOURCE_LABEL} (latest ${MAX_EVENTS})`
				: LIVE_SOURCE_LABEL,
		};
	} catch (queryError) {
		// A query failure is not a missing database, so do not pretend there is
		// sample data — render the empty state and say the read failed.
		console.error("[recipe:token-usage] usage query failed:", queryError);
		return {
			entries: [],
			fetchedAt: formatFetchedAt(),
			sourceLabel: "Usage query failed",
		};
	}
}
