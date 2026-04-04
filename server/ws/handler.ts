import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket, WebSocketServer } from "ws";
import {
	decodeMuxMessage,
	encodeMuxMessage,
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

export async function initRooms() {
	const db = getDefaultPersistence();
	const roomsNames: string[] = await db.getAllDocNames();
	console.log("roomNames", roomsNames);

	for (const key of roomsNames) {
		let doc = await (db.getYDoc(key) as Promise<Y.Doc>);
		console.log("DOC!", doc);

		doc.on("update", async (Update, Origin, Doc, Transaction) => {
			//console.log("INIT UPDATE!", Update.length, Update);

			console.log(Y.logUpdate(Update));

			await db.storeUpdate(key, Update);

			//
			Transaction.changed.forEach((ChangeSet, Container) => {
				console.log(ChangeSet);
				if (
					Container instanceof Y.Map ||
					(Container._map instanceof Map && Container._map.size > 0)
				) {
					console.log("- Y.Map:");
					ChangeSet.forEach((Value, Key) => {
						console.log("  -", Key, "=", Value);
					});
					return;
				}

				if (
					Container instanceof Y.Array ||
					(Container._start != null &&
						"arr" in Container._start.content)
				) {
					console.log("- Y.Array:", Transaction);
					return;
				}

				if (
					Container instanceof Y.Text ||
					(Container._start != null &&
						"str" in Container._start.content)
				) {
					console.log("- Y.Text:", Transaction);
					return;
				}

				if (
					Container instanceof Y.XmlFragment ||
					(Container._start != null &&
						"type" in Container._start.content)
				) {
					console.log("- Y.XmlFragment:", Transaction);
					return;
				}

				console.log("Transaction", Transaction);
			});
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
		return existing;
	}

	const d = new Y.Doc();
	const db = getDefaultPersistence();
	db.storeUpdate(roomId, Y.encodeStateAsUpdate(d));

	d.on("update", async (Update, Origin, Doc, Transaction) => {
		await db.storeUpdate(roomId, Update);

		console.log("new transaction for", roomId);
		Transaction.changed.forEach((ChangeSet, Container) => {
			if (
				Container instanceof Y.Map ||
				(Container._map instanceof Map && Container._map.size > 0)
			) {
				console.log("- Y.Map:");
				ChangeSet.forEach((Value, Key) => {
					console.log("  -", Key, "=", Value);
				});
				return;
			}

			if (
				Container instanceof Y.Array ||
				(Container._start != null && "arr" in Container._start.content)
			) {
				console.log("- Y.Array:", Transaction);
				return;
			}

			if (
				Container instanceof Y.Text ||
				(Container._start != null && "str" in Container._start.content)
			) {
				console.log("- Y.Text:", Transaction);
				return;
			}

			if (
				Container instanceof Y.XmlFragment ||
				(Container._start != null && "type" in Container._start.content)
			) {
				console.log("- Y.XmlFragment:", Transaction);
				return;
			}

			console.log("Transaction", Transaction);
		});
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

		if (!state || !state.clients.has(client)) return;

		if (payload.length > 0) {
			const decoder = decoding.createDecoder(payload);
			const encoder = encoding.createEncoder();

			// console.log(
			// 	"before!",
			// 	roomId,
			// 	state.doc.getMap("files").toJSON(),
			// 	state.doc.getText("content").toDelta(),
			// 	state.doc.getText("content").toString(),
			// );

			const msgType = syncProtocol.readSyncMessage(
				decoder,
				encoder,
				state.doc,
				null,
			);

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
		return;
	}

	function sendFullState(client: MuxClient, docId: string) {
		const roomId = `${client.baseRoomId}:${docId}`;
		const state = rooms.get(roomId);
		if (!state) return;

		const update = Y.encodeStateAsUpdate(state.doc);

		const encoder = encoding.createEncoder();
		syncProtocol.writeUpdate(encoder, update);

		const msg = encodeMuxMessage(
			docId,
			MUX_SYNC,
			encoding.toUint8Array(encoder),
		);

		safeSend(client.ws, msg);
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

			console.log("client! CONNECTED");

			ws.on("error", (err) => {
				console.error(
					`[yjs-mux] ws error for room ${baseRoomId}:`,
					err.message,
				);
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
					}
				} catch (err) {
					console.error("[yjs-mux] failed to handle message:", err);
				}
			});
		},
	);

	return { muxWss };
}
