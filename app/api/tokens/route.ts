import { NextResponse } from "next/server";
import setData from "@/app/(app)/recipes/screens/token-usage/setData";
import { withDeviceApiKey } from "@/lib/database/scoped-db";
import { checkDbConnection } from "@/lib/database/utils";
import { parseRequestHeaders } from "@/lib/device/request-headers";
import {
	isResponse,
	parseJsonObjectBody,
} from "@/lib/trmnl/plugin-settings-validation";

export async function POST(request: Request) {
	const headers = parseRequestHeaders(request);
	const accessToken = headers.apiKey;
	const { ready } = await checkDbConnection();
	if (!ready) {
		return Response.json({ error: "Database not ready" }, { status: 503 });
	}

	if (!accessToken) {
		return NextResponse.json(
			{ error: "Access token is required" },
			{ status: 401 },
		);
	}

	const device = await withDeviceApiKey(accessToken, (scopedDb) =>
		scopedDb
			.selectFrom("devices")
			.select(["user_id", "mixup_id", "model", "palette_id"])
			.where("api_key", "=", accessToken)
			.executeTakeFirst(),
	);

	// A device with no owner predates tenancy or was never claimed; there is no
	// tenant to file its usage under, so it cannot ingest.
	if (!device?.user_id) {
		return NextResponse.json({ error: "Device not found" }, { status: 401 });
	}

	const body = await parseJsonObjectBody(request);
	if (isResponse(body)) return body;

	const entries = body.entries;
	if (!Array.isArray(entries)) {
		return NextResponse.json(
			{ error: "entries must be an array" },
			{ status: 400 },
		);
	}

	await setData(entries, accessToken, device.user_id);

	return NextResponse.json({ success: true });
}
