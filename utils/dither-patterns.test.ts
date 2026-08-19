import { extractResourceUrls, Renderer } from "@takumi-rs/core";
import { fetchResources } from "@takumi-rs/helpers";
import { fromJsx } from "@takumi-rs/helpers/jsx";
import React from "react";
import sharp from "sharp";
import { ditherStyle } from "./dither-patterns";

/**
 * Guards the `backgroundClip` in `ditherStyle`.
 *
 * Takumi paints a repeating background as whole tiles, so without an explicit
 * clip an element narrower than the 8px pattern grid bleeds its last tile over
 * the neighbours — a 13px legend swatch painted 16px and covered its caption.
 * Rendering is the only way to catch that; the style object looks fine either
 * way. Fonts are omitted because the case draws no text.
 */

const renderer = new Renderer({ fonts: [] });
const PAD = 12;
const CELL = 64;

async function render(
	element: React.ReactElement,
	width: number,
	height: number,
) {
	const { node } = await fromJsx(element);
	const urls = extractResourceUrls(node);
	const raw = await renderer.render(node, {
		width,
		height,
		format: "raw",
		fetchedResources: urls.length > 0 ? await fetchResources(urls) : [],
	});
	const buffer = Buffer.from(raw);
	const channels = buffer.length / (width * height);
	return sharp(buffer, { raw: { width, height, channels: channels as 3 | 4 } })
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
}

/** Size of the inked region, in pixels, of a single dithered box on white. */
async function paintedSize(shade: number, size: number) {
	const element = React.createElement(
		"div",
		{
			style: {
				display: "flex",
				width: CELL,
				height: CELL,
				padding: PAD,
				backgroundColor: "#fff",
			},
		},
		React.createElement("div", {
			style: {
				display: "flex",
				...ditherStyle(shade),
				width: size,
				height: size,
			},
		}),
	);

	const { data, info } = await render(element, CELL, CELL);
	let minX = Number.POSITIVE_INFINITY;
	let maxX = -1;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = -1;
	for (let y = 0; y < info.height; y++) {
		for (let x = 0; x < info.width; x++) {
			if (data[(y * info.width + x) * info.channels] < 128) {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
		}
	}
	return {
		width: maxX - minX + 1,
		height: maxY - minY + 1,
		left: minX,
		top: minY,
	};
}

describe("ditherStyle", () => {
	// 13 is the legend swatch, 3 the narrowest bar segment; neither divides 8.
	it.each([13, 3, 22])("confines a %ipx fill to its own box", async (size) => {
		const painted = await paintedSize(700, size);
		expect(painted).toEqual({
			width: size,
			height: size,
			left: PAD,
			top: PAD,
		});
	});

	it("still fills solid shades edge to edge", async () => {
		const painted = await paintedSize(1000, 13);
		expect(painted).toEqual({ width: 13, height: 13, left: PAD, top: PAD });
	});
});
