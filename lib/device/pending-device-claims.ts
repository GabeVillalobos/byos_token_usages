import { createHmac } from "crypto";
import { sql } from "kysely";
import { db } from "@/lib/database/db";
import { resolveModelForStorage } from "@/lib/trmnl/model-storage";

const CLAIM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CLAIM_CODE_LENGTH = 8;
const CLAIM_TTL_HOURS = 24;

type PendingClaimInput = {
	apiKey: string;
	macAddress: string | null;
	model: string | null;
	width: number | null;
	height: number | null;
};

function claimSecret(): string {
	return (
		process.env.BETTER_AUTH_SECRET ||
		process.env.AUTH_SECRET ||
		process.env.DATABASE_URL ||
		"byos-dev-claim-secret"
	);
}

function hmacHex(label: string, value: string): string {
	return createHmac("sha256", claimSecret())
		.update(label)
		.update("\0")
		.update(value)
		.digest("hex");
}

function formatClaimCode(raw: string): string {
	return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeClaimCode(code: string): string {
	return code.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export function hashClaimCode(code: string): string {
	return hmacHex("device-claim-lookup-v1", normalizeClaimCode(code));
}

/**
 * Derived from the API key alone so that a device gets the same code whether it
 * was provisioned by /api/setup or first seen by /api/display, and so reported
 * metadata changing (model, resolution) can't strand a device on a code that no
 * longer maps to a stored row.
 */
export function generateClaimCode(apiKey: string): string {
	const bytes = Buffer.from(hmacHex("device-claim-code-v1", apiKey), "hex");
	let code = "";
	for (let index = 0; index < CLAIM_CODE_LENGTH; index += 1) {
		code += CLAIM_ALPHABET[bytes[index] % CLAIM_ALPHABET.length];
	}
	return formatClaimCode(code);
}

export async function createOrRefreshPendingDeviceClaim(
	input: PendingClaimInput,
): Promise<{ claimCode: string; claimHash: string }> {
	const claimCode = generateClaimCode(input.apiKey);
	const claimHash = hashClaimCode(claimCode);
	const modelResolution = await resolveModelForStorage(input.model);

	await pruneStalePendingClaims();

	await db
		.insertInto("pending_device_claims")
		.values({
			claim_hash: claimHash,
			api_key: input.apiKey,
			api_key_suffix: input.apiKey.slice(-4),
			mac_address: input.macAddress,
			model: modelResolution.modelName ?? null,
			width: input.width,
			height: input.height,
			last_seen_at: sql`NOW()`,
		})
		.onConflict((oc) =>
			oc.column("claim_hash").doUpdateSet({
				api_key: input.apiKey,
				api_key_suffix: input.apiKey.slice(-4),
				mac_address: input.macAddress,
				model: modelResolution.modelName ?? null,
				width: input.width,
				height: input.height,
				last_seen_at: sql`NOW()`,
			}),
		)
		.execute();

	return { claimCode, claimHash };
}

/**
 * Unclaimed devices are written here without any authentication, so rows are
 * dropped once a device stops checking in. A device that comes back gets the
 * same code again on its next callback, since the code is derived from its key.
 */
async function pruneStalePendingClaims(): Promise<void> {
	await db
		.deleteFrom("pending_device_claims")
		.where(
			"last_seen_at",
			"<",
			sql<Date>`NOW() - make_interval(hours => ${CLAIM_TTL_HOURS})`,
		)
		.execute();
}
