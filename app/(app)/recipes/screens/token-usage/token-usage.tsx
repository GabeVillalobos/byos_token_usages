import { z } from "zod";
import {
	MetricHero,
	MIN_SCREEN_BODY_FONT_SIZE,
	ScreenCanvas,
	ScreenFooter,
	screenFontSize,
	screenMetric,
} from "@/components/trmnl/screen-layout";
import {
	DEFAULT_IMAGE_HEIGHT,
	DEFAULT_IMAGE_WIDTH,
} from "@/lib/recipes/constants";
import type { RecipeDefinition } from "@/lib/recipes/types";
import {
	createScreenProfile,
	type ScreenProfile,
} from "@/lib/trmnl/screen-profile";
import { PreSatori } from "@/utils/pre-satori";
import {
	aggregateUsage,
	formatTokens,
	type TokenUsageEntry,
} from "./aggregate";
import getTokenUsageData from "./getData";
import { UsageBarRow, UsageLegend } from "./usage-bar";

export const paramsSchema = z.object({
	title: z
		.string()
		.default("Token Usage")
		.describe("Heading shown in the top-right corner of the screen.")
		.meta({ title: "Title", placeholder: "Token Usage" }),
	lookbackHours: z.coerce
		.number()
		.default(0)
		.describe("Only count records from the last N hours. 0 means all time.")
		.meta({ title: "Lookback (hours)", placeholder: "0" }),
	includeSidechains: z
		.boolean()
		.default(true)
		.describe("Include records marked is_sidechain in the totals.")
		.meta({ title: "Include Sidechains" }),
});

/**
 * Counters are optional here so a partial upstream record still renders;
 * `aggregateUsage` coerces anything missing to zero. Every field carries a
 * default because the runtime falls back to `dataSchema.safeParse({})` when
 * `getData` fails.
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

export const dataSchema = z.object({
	entries: z.array(usageEntrySchema).default([]),
	fetchedAt: z.string().default(""),
	sourceLabel: z.string().default("No source"),
});

interface TokenUsageProps {
	entries?: TokenUsageEntry[];
	fetchedAt?: string;
	sourceLabel?: string;
	title?: string;
	lookbackHours?: number;
	includeSidechains?: boolean;
	width?: number;
	height?: number;
	screen?: ScreenProfile;
}

export default function TokenUsage({
	entries = [],
	fetchedAt = "",
	sourceLabel = "No source",
	title = "Token Usage",
	lookbackHours = 0,
	includeSidechains = true,
	width = DEFAULT_IMAGE_WIDTH,
	height = DEFAULT_IMAGE_HEIGHT,
	screen,
}: TokenUsageProps) {
	const screenProfile = screen ?? createScreenProfile({ width, height });

	const pad = screenMetric(screenProfile, screenProfile.isCompact ? 14 : 22);
	const gap = screenMetric(screenProfile, screenProfile.isCompact ? 8 : 12);

	const headerHeight = screenMetric(
		screenProfile,
		screenProfile.isHalfScreen ? 82 : screenProfile.isLarge ? 118 : 100,
	);
	const footerHeight = screenMetric(
		screenProfile,
		screenProfile.isCompact ? 34 : 42,
	);
	const labelFontSize = screenFontSize(
		screenProfile,
		screenProfile.isCompact ? 15 : 18,
		MIN_SCREEN_BODY_FONT_SIZE,
	);
	// The legend is tertiary detail: drop it on half screens rather than
	// shrinking the bars, per the screen design guide.
	const showLegend = !screenProfile.isHalfScreen;
	const legendFontSize = screenFontSize(
		screenProfile,
		screenProfile.isCompact ? 14 : 16,
		MIN_SCREEN_BODY_FONT_SIZE,
	);
	const legendHeight = showLegend ? Math.round(legendFontSize * 1.6) : 0;

	const rowGap = screenMetric(screenProfile, screenProfile.isCompact ? 6 : 9);
	const barHeight = screenMetric(
		screenProfile,
		screenProfile.isCompact ? 22 : 28,
	);
	const rowHeight = Math.max(barHeight, Math.round(labelFontSize * 1.25));

	// Same subtract-everything-else approach as the bitcoin-price graph box.
	const regionGaps = showLegend ? gap * 3 : gap * 2;
	const availableChartHeight =
		screenProfile.logicalHeight -
		pad * 2 -
		headerHeight -
		legendHeight -
		footerHeight -
		regionGaps;
	const maxRows = Math.max(
		1,
		Math.min(
			8,
			Math.floor((availableChartHeight + rowGap) / (rowHeight + rowGap)),
		),
	);

	const { rows, grandTotal, maxTotal, entryCount, modelCount, windowLabel } =
		aggregateUsage(entries, {
			now: Date.now(),
			lookbackHours,
			includeSidechains,
			maxRows,
		});

	const contentWidth = screenProfile.logicalWidth - pad * 2;
	const columnGap = screenMetric(screenProfile, 8);
	const labelWidth = Math.round(
		Math.min(
			screenMetric(screenProfile, 190),
			Math.max(screenMetric(screenProfile, 88), contentWidth * 0.26),
		),
	);
	// Sized for the widest total the formatter can produce ("999.9M").
	const valueWidth = Math.round(labelFontSize * 3.9);
	const trackWidth = Math.max(
		screenMetric(screenProfile, 60),
		contentWidth - labelWidth - valueWidth - columnGap * 2,
	);

	const modelSummary = `${modelCount} model${modelCount === 1 ? "" : "s"}`;
	const subtitle =
		entryCount > 0
			? `tokens · ${modelSummary} · ${windowLabel}`
			: `tokens · ${windowLabel}`;

	return (
		<PreSatori
			width={screenProfile.logicalWidth}
			height={screenProfile.logicalHeight}
		>
			<ScreenCanvas screen={screenProfile} style={{ padding: pad, gap }}>
				<div
					className="flex flex-none flex-col border-b border-black"
					style={{ height: headerHeight, paddingBottom: gap }}
				>
					<MetricHero
						screen={screenProfile}
						title={formatTokens(grandTotal)}
						subtitle={subtitle}
						aside={
							<div
								className="font-inter"
								style={{
									fontFamily: "Inter, sans-serif",
									fontSize: screenFontSize(
										screenProfile,
										screenProfile.isCompact ? 16 : 20,
										MIN_SCREEN_BODY_FONT_SIZE,
									),
									lineHeight: 1,
									whiteSpace: "nowrap",
								}}
							>
								{title}
							</div>
						}
					/>
				</div>

				{rows.length > 0 ? (
					<div
						style={{
							display: "flex",
							flex: 1,
							flexDirection: "column",
							justifyContent: "flex-start",
							overflow: "hidden",
							gap: rowGap,
						}}
					>
						{rows.map((row) => (
							<UsageBarRow
								key={row.model}
								screen={screenProfile}
								row={row}
								trackWidth={trackWidth}
								scaleTotal={maxTotal}
								barHeight={barHeight}
								labelWidth={labelWidth}
								valueWidth={valueWidth}
								fontSize={labelFontSize}
							/>
						))}
					</div>
				) : (
					<div
						className="font-inter"
						style={{
							display: "flex",
							flex: 1,
							alignItems: "center",
							justifyContent: "center",
							fontFamily: "Inter, sans-serif",
							fontSize: screenFontSize(
								screenProfile,
								screenProfile.isCompact ? 18 : 24,
								MIN_SCREEN_BODY_FONT_SIZE,
							),
							lineHeight: 1,
						}}
					>
						No usage in this window
					</div>
				)}

				{showLegend ? (
					<UsageLegend screen={screenProfile} fontSize={legendFontSize} />
				) : null}

				<ScreenFooter
					screen={screenProfile}
					left={sourceLabel}
					right={fetchedAt ? `Updated ${fetchedAt}` : ""}
					style={{ height: footerHeight }}
				/>
			</ScreenCanvas>
		</PreSatori>
	);
}

export const definition: RecipeDefinition<
	typeof paramsSchema,
	typeof dataSchema
> = {
	meta: {
		slug: "token-usage",
		title: "Token Usage by Model",
		description:
			"A stacked horizontal bar chart of LLM token consumption grouped by model and sorted by total usage, split into input, output, cache write, and cache read.",
		published: true,
		tags: ["chart", "tokens", "llm", "api", "configurable"],
		category: "display-components",
		version: "0.1.0",
		createdAt: "2026-08-17T00:00:00Z",
		updatedAt: "2026-08-17T00:00:00Z",
		renderSettings: {
			supersample: true,
		},
	},
	paramsSchema,
	dataSchema,
	getData: async (params, context) => {
		const data = await getTokenUsageData(
			{
				lookbackHours: params.lookbackHours,
				includeSidechains: params.includeSidechains,
			},
			context,
		);
		return data as z.infer<typeof dataSchema>;
	},
	Component: ({ width, height, screen, params, data }) => (
		<TokenUsage
			{...data}
			title={params.title}
			lookbackHours={params.lookbackHours}
			includeSidechains={params.includeSidechains}
			width={width}
			height={height}
			screen={screen}
		/>
	),
};
