/// <reference types="jest" />

// kysely ships ESM that ts-jest does not transform, and these helpers are pure.
jest.mock("kysely", () => ({
	sql: jest.fn(),
}));

jest.mock("@/lib/database/db", () => ({
	db: {},
}));

import { generateClaimCode, hashClaimCode } from "./pending-device-claims";

describe("generateClaimCode", () => {
	it("returns the same code for an API key regardless of when it is called", () => {
		expect(generateClaimCode("device-token")).toBe(
			generateClaimCode("device-token"),
		);
	});

	it("returns a formatted code from the unambiguous alphabet", () => {
		expect(generateClaimCode("device-token")).toMatch(
			/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
		);
	});

	it("separates devices that present different API keys", () => {
		expect(generateClaimCode("device-token")).not.toBe(
			generateClaimCode("other-token"),
		);
	});
});

describe("hashClaimCode", () => {
	it("looks up the same row whatever separators or case the user types", () => {
		const canonical = hashClaimCode("ABCD-2345");

		expect(hashClaimCode("abcd2345")).toBe(canonical);
		expect(hashClaimCode(" abcd 2345 ")).toBe(canonical);
	});
});
