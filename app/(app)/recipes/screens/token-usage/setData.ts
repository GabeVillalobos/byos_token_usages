import { withDeviceApiKey } from "@/lib/database/scoped-db";
import { checkDbConnection } from "@/lib/database/utils";
import { TokenUsageEntry } from "./aggregate";

export default async function setData(
	entries: TokenUsageEntry[],
	apiKey: string,
	userId: string,
) {
	const { ready } = await checkDbConnection();
	if (!ready) {
		return Response.json({ error: "Database not ready" }, { status: 503 });
	}
	await withDeviceApiKey(apiKey, async (scopedDb) => {
		for (const entry of entries) {
			await scopedDb
				.insertInto("token_usage_events")
				.values({
					event_id: entry.id,
					ts: entry.ts,
					session_id: entry.session_id,
					prompt_id: entry.prompt_id,
					agent_id: entry.agent_id,
					is_sidechain: entry.is_sidechain,
					model: entry.model,
					input_tokens: entry.input_tokens,
					output_tokens: entry.output_tokens,
					cache_creation_input_tokens: entry.cache_creation_input_tokens,
					cache_read_input_tokens: entry.cache_read_input_tokens,
					// The device-api-key policy in 0023 matches rows against the
					// owner of the device the token belongs to, so an unstamped
					// row is rejected rather than landing as shared data.
					user_id: userId,
				})
				// Emitters replay batches; event_id is unique for exactly this.
				.onConflict((oc) => oc.column("event_id").doNothing())
				.execute();
		}
	});
}
