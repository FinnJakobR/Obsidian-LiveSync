import { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import * as fs from "fs";
import {
	chunkDataWritingFromEvent,
	chunkEndWritingFromEvent,
	createFileFromEvent,
	deleteFileFromEvent,
	FileChunkDataOperation,
	FileChunkEndOperation,
	FileChunkStartOperation,
	FileCreateOperation,
	FileDeleteOperation,
	FileModifyOperation,
	FileRenameOperation,
	FolderCreateOperation,
	getFileFromEvent,
	modifyFileFromEvent,
	renameFileFromEvent,
	startChunkWritingFromEvent,
} from "../util/fs";
import { binary } from "lib0";

const ALLOWED_TYPES = new Set([
	"file-op",
	"file-chunk-start",
	"file-chunk-data",
	"file-chunk-end",
	"file-chunk-resume",
	"sync-request",
	"ping",
	"pong",
]);

const MSG_RATE_WINDOW = 10_000;
const MSG_RATE_LIMIT = 100;
const UNKNOWN_TYPE_WARN_LIMIT = 10;
let unknownTypeWarnCount = 0;

interface ControlClient {
	ws: WebSocket;
	userId: string;
	msgTimestamps: number[];
}

interface ControlRoom {
	clients: Map<WebSocket, ControlClient>;
	pendingTransferTarget: string | null;
}

export function createControlWSS() {
	const rooms = new Map<string, ControlRoom>();
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: 2 * 1024 * 1024,
	});

	function getOrCreateRoom(roomId: string): ControlRoom {
		let room = rooms.get(roomId);
		if (!room) {
			room = {
				clients: new Map(),
				pendingTransferTarget: null,
			};
			rooms.set(roomId, room);
		}

		return room;
	}

	function safeSend(ws: WebSocket, data: string) {
		try {
			if (ws.readyState === WebSocket.OPEN) ws.send(data);
		} catch {
			// Send may fail if socket is closing
		}
	}

	function sendTo(ws: WebSocket, message: Record<string, unknown>) {
		safeSend(ws, JSON.stringify(message));
	}

	function broadcast(
		room: ControlRoom,
		data: Buffer | string,
		exclude?: WebSocket,
	) {
		const messageString =
			typeof data === "string" ? data : data.toString("utf-8");
		for (const [ws] of room.clients) {
			if (ws !== exclude) safeSend(ws, messageString);
		}
	}

	wss.on(
		"connection",
		(ws: WebSocket, req: IncomingMessage, roomId: string) => {
			const room = getOrCreateRoom(roomId);

			const client: ControlClient = {
				ws,
				userId: "",
				msgTimestamps: [],
			};
			room.clients.set(ws, client);

			ws.on("error", (err) => {
				console.error(
					`[control] ws error for room ${roomId}:`,
					err.message,
				);
				ws.close();
			});

			ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
				const now = Date.now();
				client.msgTimestamps.push(now);

				while (
					client.msgTimestamps.length > 0 &&
					client.msgTimestamps[0] < now - MSG_RATE_WINDOW
				) {
					client.msgTimestamps.shift();
				}
				if (client.msgTimestamps.length > MSG_RATE_LIMIT) {
					ws.close(1008, "rate limit exceeded");
					return;
				}

				const data =
					raw instanceof ArrayBuffer
						? Buffer.from(raw)
						: raw instanceof Buffer
							? raw
							: Buffer.concat(raw as Buffer[]);

				let msg: Record<string, any>;
				try {
					msg = JSON.parse(data.toString());
				} catch {
					return;
				}

				if (
					typeof msg.type !== "string" ||
					!ALLOWED_TYPES.has(msg.type)
				) {
					if (unknownTypeWarnCount < UNKNOWN_TYPE_WARN_LIMIT) {
						unknownTypeWarnCount++;
						console.warn(
							`[control] dropped unknown type from ${client.userId}:`,
							msg.type,
						);
					}
					return;
				}

				if (msg.type === "ping") {
					sendTo(ws, { type: "pong", timestamp: msg.timestamp });
					return;
				}

				const isFileWrite =
					msg.type === "file-op" ||
					msg.type === "file-chunk-start" ||
					msg.type === "file-chunk-data" ||
					msg.type === "file-chunk-end";
				if (isFileWrite) {
					const filePath =
						msg.type === "file-op" &&
						typeof msg.op === "object" &&
						msg.op !== null
							? ((msg.op as Record<string, any>).path ??
								(msg.op as Record<string, any>).newPath)
							: msg.path;

					if (typeof filePath === "string") {
						const op = msg.op;

						const type = op ? op.type : msg.type;
						switch (type) {
							case "create": {
								const create_operation =
									op as FileCreateOperation;
								createFileFromEvent(
									create_operation,
									roomId,
									false,
								);
								break;
							}

							case "delete": {
								const delete_operation =
									op as FileDeleteOperation;
								deleteFileFromEvent(delete_operation, roomId);
								break;
							}

							case "rename": {
								const rename_operation =
									op as FileRenameOperation;
								renameFileFromEvent(rename_operation, roomId);
								break;
							}

							case "folder-create": {
								const createFolder_operation =
									op as FolderCreateOperation;
								createFileFromEvent(
									createFolder_operation,
									roomId,
									true,
								);

								break;
							}

							case "modify": {
								const modify_operation =
									op as FileModifyOperation;
								modifyFileFromEvent(modify_operation, roomId);
								break;
							}

							case "file-chunk-start": {
								const chunkStart_operation =
									msg as FileChunkStartOperation;
								startChunkWritingFromEvent(
									chunkStart_operation,
									roomId,
								);
								break;
							}

							case "file-chunk-data": {
								const chunkData_operation =
									msg as FileChunkDataOperation;
								chunkDataWritingFromEvent(
									chunkData_operation,
									roomId,
								);
								break;
							}

							case "file-chunk-end": {
								const chunkEnd_operation =
									msg as FileChunkEndOperation;
								chunkEndWritingFromEvent(
									chunkEnd_operation,
									roomId,
								);
								break;
							}

							case "file-chunk-resume":
								break;
						}
					}
				}

				//sync-request wird nur verwendet wenn man ein binary will! wir senden einfach ein Create Event an den user mit den Daten

				if (msg.type == "sync-request") {
					const path = msg.path as string;
					const content = getFileFromEvent(path, roomId);

					if (content.length > 0) {
						sendTo(ws, {
							type: "file-op",
							op: {
								type: "create",
								path: path,
								content: content,
								binary: true,
							},
						});
					}
				} else {
					broadcast(room, data, ws);
				}
			});
		},
	);

	return { wss };
}
