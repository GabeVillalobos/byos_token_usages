/// <reference types="jest" />

jest.mock("next/server", () => {
	const actual = jest.requireActual("next/server");
	return {
		...actual,
		connection: jest.fn(async () => undefined),
	};
});

jest.mock("@/lib/database/db", () => ({
	db: {},
}));

const withDeviceApiKey = jest.fn();
jest.mock("@/lib/database/scoped-db", () => ({
	withDeviceApiKey: (...args: unknown[]) => withDeviceApiKey(...args),
	withExplicitUserScope: jest.fn(),
}));

const checkDbConnection = jest.fn();
jest.mock("@/lib/database/utils", () => ({
	checkDbConnection: (...args: unknown[]) => checkDbConnection(...args),
}));

const getCurrentUserId = jest.fn();
jest.mock("@/lib/auth/get-user", () => ({
	getCurrentUserId: () => getCurrentUserId(),
}));

const createOrRefreshPendingDeviceClaim = jest.fn();
jest.mock("@/lib/device/pending-device-claims", () => ({
	createOrRefreshPendingDeviceClaim: (...args: unknown[]) =>
		createOrRefreshPendingDeviceClaim(...args),
}));

jest.mock("@/lib/logger", () => ({
	logError: jest.fn(),
	logInfo: jest.fn(),
	logWarn: jest.fn(),
}));

import { GET } from "./route";

const unownedDeviceRequest = (headers: Record<string, string> = {}) =>
	new Request("http://localhost/api/setup", {
		headers: {
			ID: "AA:BB:CC:DD:EE:FF",
			Model: "og_png",
			...headers,
		},
	});

describe("GET /api/setup", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		checkDbConnection.mockResolvedValue({ ready: true });
		withDeviceApiKey.mockResolvedValue(undefined);
		getCurrentUserId.mockResolvedValue(null);
		createOrRefreshPendingDeviceClaim.mockResolvedValue({
			claimCode: "ABCD-2345",
			claimHash: "hash",
		});
	});

	it("issues an access token and claim code for an unowned device", async () => {
		const response = await GET(unownedDeviceRequest());

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.api_key).toEqual(expect.any(String));
		expect(body.friendly_id).toMatch(/^[A-Z0-9]{6}$/);
		expect(body.message).toContain("ABCD-2345");
		expect(createOrRefreshPendingDeviceClaim).toHaveBeenCalledWith({
			apiKey: body.api_key,
			macAddress: "AA:BB:CC:DD:EE:FF",
			model: "og_png",
			width: null,
			height: null,
		});
	});

	it("keeps the access token a device already holds when it is unowned", async () => {
		const response = await GET(
			unownedDeviceRequest({ "Access-Token": "existing-token" }),
		);

		expect(await response.json()).toEqual(
			expect.objectContaining({ api_key: "existing-token" }),
		);
	});

	it("returns HTTP 500 when an unexpected setup error is caught", async () => {
		checkDbConnection.mockRejectedValue(new Error("database exploded"));

		const response = await GET(
			new Request("http://localhost/api/setup", {
				headers: {
					ID: "AA:BB:CC:DD:EE:FF",
					Model: "og_png",
				},
			}),
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			status: 500,
			error: "Internal server error",
		});
	});
});
