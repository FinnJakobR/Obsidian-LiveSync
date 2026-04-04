import { createHmac, timingSafeEqual } from "node:crypto";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { existsSync, readFileSync, readSync } from "node:fs";
import { exit } from "node:process";

const COMPARE_KEY = "live-share-token-compare";

export function safeTokenCompare(actual: string, expected: string): boolean {
	const hmacActual = createHmac("sha256", COMPARE_KEY)
		.update(actual)
		.digest();
	const hmacExpected = createHmac("sha256", COMPARE_KEY)
		.update(expected)
		.digest();
	return timingSafeEqual(hmacActual, hmacExpected);
}

export const MUX_SYNC = 0;
export const MUX_AWARENESS = 1;
export const MUX_SUBSCRIBE = 2;
export const MUX_UNSUBSCRIBE = 3;
export const MUX_SUBSCRIBED = 4;
export const MUX_SYNC_REQUEST = 6;
export const MUX_SYNC_ENCRYPTED = 7;
export const MUX_DELETE = 8;

export function encodeMuxMessage(
	docId: string,
	msgType: number,
	payload?: Uint8Array,
): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarString(encoder, docId);
	encoding.writeVarUint(encoder, msgType);
	if (payload) encoding.writeVarUint8Array(encoder, payload);
	return encoding.toUint8Array(encoder);
}

export function decodeMuxMessage(data: Uint8Array): {
	docId: string;
	msgType: number;
	payload: Uint8Array;
} {
	const decoder = decoding.createDecoder(data);
	const docId = decoding.readVarString(decoder);
	const msgType = decoding.readVarUint(decoder);
	const payload = decoding.hasContent(decoder)
		? decoding.readVarUint8Array(decoder)
		: new Uint8Array(0);
	return { docId, msgType, payload };
}

interface JSON {
	[index: string]: unknown;
}

export function getRoomIds(path: string): string[] {
	if (!existsSync(path)) throw Error("Could not found Room ID file: " + path);
	const rooms = JSON.parse(readFileSync(path, { encoding: "utf-8" })) as JSON;
	return Object.keys(rooms);
}

export function exitWithReason(reason: string): string {
	console.error(reason);
	exit(1);

	return "";
}
