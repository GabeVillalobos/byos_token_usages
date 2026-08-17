import { screenMetric } from "@/components/trmnl/screen-layout";
import type { ScreenProfile } from "@/lib/trmnl/screen-profile";
import {
	allocateSegmentWidths,
	formatTokens,
	type ModelUsage,
	TOKEN_SEGMENTS,
} from "./aggregate";

/**
 * One `[ label ][ stacked track ][ total ]` row.
 *
 * Bars are plain flex divs with explicit pixel widths rather than SVG: the
 * renderer handles measured flow layout reliably, and `dither-*` fills survive
 * 1-bit quantization (see `bitmap-patterns`). Styles are inline because
 * Tailwind classes inside nested primitives are not reliably preprocessed by
 * `PreSatori` — only the `dither-*` class is, which is exactly what we want.
 */
export function UsageBarRow({
	screen,
	row,
	trackWidth,
	scaleTotal,
	barHeight,
	labelWidth,
	valueWidth,
	fontSize,
}: {
	screen: ScreenProfile;
	row: ModelUsage;
	trackWidth: number;
	scaleTotal: number;
	barHeight: number;
	labelWidth: number;
	valueWidth: number;
	fontSize: number;
}) {
	const borderWidth = screen.isLarge ? 2 : 1;
	const dividerWidth = screen.isLarge ? 2 : 1;
	const innerWidth = Math.max(0, trackWidth - borderWidth * 2);
	const widths = allocateSegmentWidths(row.segments, {
		trackWidth: innerWidth,
		scaleTotal,
		minSegmentPx: screenMetric(screen, 3),
	});
	const lastVisible = widths.reduce(
		(last, width, index) => (width > 0 ? index : last),
		-1,
	);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "row",
				alignItems: "center",
				flex: "none",
				gap: screenMetric(screen, 8),
			}}
		>
			<div
				style={{
					display: "flex",
					flex: "none",
					width: labelWidth,
					overflow: "hidden",
					whiteSpace: "nowrap",
					fontFamily: "Inter, sans-serif",
					fontSize,
					lineHeight: 1,
				}}
			>
				{row.label}
			</div>

			<div
				style={{
					display: "flex",
					flexDirection: "row",
					alignItems: "stretch",
					flex: "none",
					width: trackWidth,
					height: barHeight,
					overflow: "hidden",
					borderStyle: "solid",
					borderWidth,
					borderColor: "#000",
					borderRadius: screenMetric(screen, 3),
					backgroundColor: "#fff",
				}}
			>
				{TOKEN_SEGMENTS.map((segment, index) =>
					widths[index] > 0 ? (
						<div
							key={segment.key}
							className={`dither-${segment.dither}`}
							style={{
								display: "flex",
								flex: "none",
								width: widths[index],
								height: "100%",
								// A white hairline keeps adjacent dither densities
								// readable as separate segments after quantization.
								borderRightWidth: index === lastVisible ? 0 : dividerWidth,
								borderRightStyle: "solid",
								borderRightColor: "#fff",
							}}
						/>
					) : null,
				)}
			</div>

			<div
				style={{
					display: "flex",
					flex: "none",
					width: valueWidth,
					justifyContent: "flex-end",
					overflow: "hidden",
					whiteSpace: "nowrap",
					fontFamily: "Inter, sans-serif",
					fontSize,
					lineHeight: 1,
				}}
			>
				{formatTokens(row.total)}
			</div>
		</div>
	);
}

/** Swatch + caption pairs explaining the stack order. */
export function UsageLegend({
	screen,
	fontSize,
}: {
	screen: ScreenProfile;
	fontSize: number;
}) {
	const swatch = screenMetric(screen, 13);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "row",
				alignItems: "center",
				flex: "none",
				gap: screenMetric(screen, 14),
			}}
		>
			{TOKEN_SEGMENTS.map((segment) => (
				<div
					key={segment.key}
					style={{
						display: "flex",
						flexDirection: "row",
						alignItems: "center",
						gap: screenMetric(screen, 5),
					}}
				>
					<div
						className={`dither-${segment.dither}`}
						style={{
							display: "flex",
							flex: "none",
							width: swatch,
							height: swatch,
							borderStyle: "solid",
							borderWidth: 1,
							borderColor: "#000",
						}}
					/>
					<div
						style={{
							display: "flex",
							whiteSpace: "nowrap",
							fontFamily: "Inter, sans-serif",
							fontSize,
							lineHeight: 1,
						}}
					>
						{segment.label}
					</div>
				</div>
			))}
		</div>
	);
}
