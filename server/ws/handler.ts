import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket, WebSocketServer } from "ws";
import {
	decodeMuxMessage,
	encodeMuxMessage,
	MUX_DELETE,
	MUX_SUBSCRIBED,
	MUX_SYNC,
	MUX_SYNC_ENCRYPTED,
	MUX_SYNC_REQUEST,
	MUX_UNSUBSCRIBE,
} from "../util/util";
import { IncomingMessage } from "node:http";

import * as Y from "yjs";
import {
	allreadySavedRooms,
	getDefaultPersistence,
	getRoom,
} from "../util/presence";

import * as syncProtocol from "y-protocols/sync";
import { func } from "lib0";
import Logger, { LogLevel } from "../util/logger";
import { error } from "node:console";

const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

function toUint8Array(raw: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
	if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
	if (Buffer.isBuffer(raw))
		return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
	const buf = Buffer.concat(raw as Buffer[]);
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

interface MuxClient {
	ws: WebSocket;
	userId: string | null;
	baseRoomId: string;
}

interface RoomState {
	clients: Set<MuxClient>;
	doc: Y.Doc;
}

const rooms = new Map<string, RoomState>();
const logger = new Logger();

export async function initRooms() {
	const db = getDefaultPersistence();
	const roomsNames: string[] = await db.getAllDocNames();

	//console.log("roomNames", roomsNames);

	for (const key of roomsNames) {
		let doc = await (db.getYDoc(key) as Promise<Y.Doc>);

		logger.log({
			level: LogLevel.INFO,
			causing: "update",
			date: new Date(),
			message: `Found Room Name: ${key}`,
		});

		doc.on("update", async (Update) => {
			logger.log({
				level: LogLevel.DEBUG,
				causing: "update",
				date: new Date(),
				message: `Update ${key} - New Content: ${doc.get("content").toString()}`,
			});

			await db.storeUpdate(key, Update);
		});

		const newState: RoomState = {
			clients: new Set(),
			doc: doc,
		};

		rooms.set(key, newState);
	}
}

export function getOrCreateRoom(roomId: string): RoomState {
	const existing = rooms.get(roomId);
	if (existing) {
		logger.log({
			level: LogLevel.INFO,
			causing: "update",
			date: new Date(),
			message: `Found Room ${roomId}`,
		});

		return existing;
	}

	logger.log({
		level: LogLevel.INFO,
		causing: "update",
		date: new Date(),
		message: `Create Room ${roomId}`,
	});

	const d = new Y.Doc();
	const db = getDefaultPersistence();
	db.storeUpdate(roomId, Y.encodeStateAsUpdate(d));

	d.on("update", async (Update) => {
		logger.log({
			level: LogLevel.DEBUG,
			causing: "update",
			date: new Date(),
			message: `Update ${roomId} - New Content: ${d.get("content").toString()}`,
		});

		await db.storeUpdate(roomId, Update);
	});

	const state: RoomState = {
		clients: new Set(),
		doc: d,
	};

	rooms.set(roomId, state);

	return state;
}

export function createYjsWSS() {
	const muxWss = new WebSocketServer({
		noServer: true,
		maxPayload: Infinity,
	});

	function safeSend(ws: WebSocket, data: Uint8Array | string) {
		try {
			if (ws.readyState === WebSocket.OPEN) ws.send(data);
		} catch {
			// Send may fail if socket is closing
		}
	}

	function handleSubscribe(client: MuxClient, docId: string) {
		const roomId = `${client.baseRoomId}:${docId}`;

		logger.log({
			level: LogLevel.DEBUG,
			message: `got SUBSCRIBE Message from Client ${client.userId} to room ${roomId} `,
			date: new Date(),
			causing: "websocket",
		});
		const state = getOrCreateRoom(roomId);
		const peerCount = state.clients.size;

		state.clients.add(client);
		const peerCountEncoder = encoding.createEncoder();
		encoding.writeVarUint(peerCountEncoder, peerCount);

		const msg = encodeMuxMessage(
			docId,
			MUX_SUBSCRIBED,
			encoding.toUint8Array(peerCountEncoder),
		);

		logger.log({
			level: LogLevel.DEBUG,
			message: `send SUBSCRIBE Message from Client ${client.userId} to room ${roomId} `,
			date: new Date(),
			causing: "websocket",
		});

		safeSend(client.ws, msg);
	}

	function handleSync(
		client: MuxClient,
		docId: string,
		payload: Uint8Array,
		encrypted = false,
	) {
		const roomId = `${client.baseRoomId}:${docId}`;
		const state = getOrCreateRoom(roomId);

		logger.log({
			level: LogLevel.DEBUG,
			message: `got SYNC Message from Client ${client.userId} to room ${roomId} with Payload length: ${payload.length}`,
			date: new Date(),
			causing: "websocket",
		});

		if (!state || !state.clients.has(client)) return;

		if (payload.length > 0) {
			const decoder = decoding.createDecoder(payload);
			const encoder = encoding.createEncoder();

			logger.log({
				level: LogLevel.INFO,
				message: `Room before SYNC [files: ${JSON.stringify(state.doc.getMap("files").toJSON())} | Delta Content: ${state.doc.getText("content").toDelta()}] from Client ${client.userId} to room ${roomId} `,
				date: new Date(),
				causing: "sync",
			});

			const msgType = syncProtocol.readSyncMessage(
				decoder,
				encoder,
				state.doc,
				null,
			);

			logger.log({
				level: LogLevel.INFO,
				message: `Room after SYNC [files: ${JSON.stringify(state.doc.getMap("files").toJSON())} | Delta Content: ${state.doc.getText("content").toDelta()}] from Client ${client.userId} to room ${roomId} `,
				date: new Date(),
				causing: "sync",
			});

			//db.storeUpdate(roomId, Y.encodeStateAsUpdate(state.doc));

			const msgPeerType = encrypted ? MUX_SYNC_ENCRYPTED : MUX_SYNC;
			const msg = encodeMuxMessage(docId, msgPeerType, payload);
			for (const peer of state.clients) {
				if (peer !== client) safeSend(peer.ws, msg);
			}

			if (encoding.length(encoder) > 0) {
				const reply = encodeMuxMessage(
					docId,
					MUX_SYNC,
					encoding.toUint8Array(encoder),
				);
				safeSend(client.ws, reply);
			}
		}
	}

	function handleUnsubscribe(client: MuxClient, docId: string) {
		const roomId = `${client.baseRoomId}:${docId}`;
		const room = getOrCreateRoom(roomId);
		room.clients.delete(client);

		logger.log({
			level: LogLevel.WARNING,
			message: `Unsubsribe for Room: ${roomId} from ${client.userId}`,
			date: new Date(),
			causing: "unsubscribe",
		});

		return;
	}

	function handleDeletion(client: MuxClient, docId: string) {
		const roomId = `${client.baseRoomId}:${docId}`;
		logger.log({
			level: LogLevel.WARNING,
			message: `Delete-request from ${client.userId} for Room: ${roomId}`,
			date: new Date(),
			causing: "delete",
		});
		rooms.delete(roomId);
		const db = getDefaultPersistence();
		void db.clearDocument(roomId);
	}

	muxWss.on(
		"connection",
		(ws: WebSocket, req: IncomingMessage, baseRoomId: string) => {
			const reqUrl = new URL(req.url || "", `http://${req.headers.host}`);
			let userId = reqUrl.searchParams.get("userId");

			const client: MuxClient = {
				ws,
				userId,
				baseRoomId,
			};

			logger.log({
				level: LogLevel.DEBUG,
				message: `Client ${userId} connected from MUX to ${baseRoomId}`,
				date: new Date(),
				causing: "websocket",
			});

			ws.on("error", (err) => {
				logger.log({
					level: LogLevel.ERROR,
					message: `Client ${userId} got an error for room ${baseRoomId}: ${err.message}`,
					date: new Date(),
					causing: "websocket",
				});

				ws.close();
			});

			ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
				const data = toUint8Array(raw);
				try {
					const { docId, msgType, payload } = decodeMuxMessage(data);

					switch (msgType) {
						case MUX_SUBSCRIBED:
							handleSubscribe(client, docId);
							break;

						case MUX_UNSUBSCRIBE:
							handleUnsubscribe(client, docId);
							break;

						case MUX_SYNC:
							handleSync(client, docId, payload);
							break;
						case MUX_SYNC_ENCRYPTED:
							handleSync(client, docId, payload, true);
							break;

						case MUX_DELETE:
							handleDeletion(client, docId);
							break;
					}
				} catch (err) {
					logger.log({
						level: LogLevel.ERROR,
						message: `Client ${userId} failed to handle message: ${err as string}`,
						date: new Date(),
						causing: "websocket",
					});
					//console.error("[yjs-mux] failed to handle message:", err);
				}
			});
		},
	);

	return { muxWss };
}
