import type { ComponentType } from "react";
import type { z } from "zod";
import type { ScreenProfile } from "@/lib/trmnl/screen-profile";

export type RecipeAuthor = {
	name?: string;
	github?: string;
};

export type RecipeRenderSettings = {
	supersample?: boolean;
	applyEdgeSnap?: boolean;
	/**
	 * Image preparation is enabled by default for reducible device palettes.
	 * Set to false to opt out, or use "floyd-steinberg" for explicitness.
	 */
	imageDither?: false | "floyd-steinberg";
	[key: string]: boolean | string | number | undefined;
};

export type RecipeMeta = {
	slug: string;
	title: string;
	description?: string;
	published?: boolean;
	tags?: string[];
	author?: RecipeAuthor;
	category?: string;
	version?: string;
	createdAt?: string;
	updatedAt?: string;
	renderSettings?: RecipeRenderSettings;
	/**
	 * Hides the recipe from the catalog and parameter form. Used for built-ins
	 * like `not-found` whose props are injected by the runtime, not by users.
	 */
	system?: boolean;
};

export type RecipeRenderProps = {
	width?: number;
	height?: number;
	screen?: ScreenProfile;
};

/**
 * Ambient context the runtime passes to `getData` alongside the user's params.
 *
 * `userId` is the tenant this render belongs to. It is deliberately supplied
 * rather than resolved inside `getData`, because it is not always the session
 * user: device requests authenticate with an `Access-Token` and carry no
 * session, so the bitmap route resolves the owner from the key and hands it
 * down. A `getData` that reads tenant-scoped rows must use this value —
 * resolving the user from the session itself would read the wrong tenant (or
 * nothing) on device renders.
 *
 * Undefined means no tenant was resolved; treat it the way `getScreenParams`
 * does and fall back to the session scope.
 */
export type RecipeDataContext = {
	userId?: string;
	/**
	 * True only for the in-browser React preview at `/recipes/{slug}/preview`.
	 * Device renders and the `/api/bitmap` path leave it unset, so a recipe that
	 * branches on it still serves real data to hardware. Recipes are free to
	 * ignore it; it exists for feeds whose live read is unwanted while
	 * previewing (cost, rate limits, or an empty tenant showing as a blank
	 * screen).
	 */
	preview?: boolean;
};

/**
 * Single source of truth for a built-in React recipe.
 *
 * - `paramsSchema` describes user-configurable inputs (drives the form and
 *   `screen_configs.params` validation). May be `z.object({})` for recipes
 *   with no settings.
 * - `dataSchema` describes the shape the component actually renders against.
 *   For recipes with no fetch, `dataSchema = paramsSchema`. For data-driven
 *   recipes (wikipedia, weather, …), `dataSchema` describes the fetched
 *   payload and `getData(params, context)` produces it. Recipes that need
 *   neither the tenant nor anything else ambient can declare `getData` with a
 *   single `params` argument and ignore the second.
 * - `Component` receives `{ width, height, params, data }` so the runtime can
 *   pass both the user's saved params AND the data the component should
 *   render against, without flattening either.
 */
export type RecipeDefinition<
	P extends z.ZodObject = z.ZodObject,
	D extends z.ZodTypeAny = P,
> = {
	meta: RecipeMeta;
	paramsSchema: P;
	dataSchema: D;
	getData?: (
		params: z.infer<P>,
		context: RecipeDataContext,
	) => Promise<z.infer<D>>;
	Component: ComponentType<
		RecipeRenderProps & {
			params: z.infer<P>;
			data: z.infer<D>;
		}
	>;
};

/**
 * Loosely typed alias used by registry code that handles arbitrary
 * definitions without knowing each recipe's schema generics.
 */
export type AnyRecipeDefinition = RecipeDefinition<any, any>;

/**
 * Module shape returned by recipe loaders. The runtime requires
 * `definition` — recipes without one are flagged at load time. Arbitrary
 * other exports (helpers, the legacy `default` component) are allowed
 * because recipe files are free to expose internal symbols.
 */
export type RecipeModule = {
	definition?: AnyRecipeDefinition;
	[key: string]: any;
};

/**
 * Lazy module loader produced by the recipe index generator. Each entry
 * dynamic-imports the recipe file.
 */
export type RecipeModuleLoader = () => Promise<RecipeModule>;
