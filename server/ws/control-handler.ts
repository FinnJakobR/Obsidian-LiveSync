import { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import * as fs from "fs";

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

	const uploads = new Map();

	function createQueue() {
		let last = Promise.resolve();

		return (task: () => Promise<void>): Promise<void> => {
			last = last.then(task).catch(console.error);
			return last;
		};
	}

	/**
	 * START
	 */
	function handleChunkStart({
		transferId,
		path,
		size,
	}: {
		transferId: string;
		path: string;
		size: number;
	}) {
		return new Promise<void>((resolve, reject) => {
			fs.open(path, "w+", (err, fd) => {
				if (err) return reject(err);

				const queue = createQueue();

				// Datei optional auf Zielgröße setzen
				if (size) {
					fs.write(fd, Buffer.alloc(1), 0, 1, size - 1, (err) => {
						if (err) return reject(err);
						uploads.set(transferId, { fd, path, queue });
						resolve();
					});
				} else {
					uploads.set(transferId, { fd, path, queue });
					resolve();
				}
			});
		});
	}

	function handleChunkData({
		transferId,
		data,
		start,
	}: {
		transferId: string;
		data: string;
		start: number;
	}) {
		const upload = uploads.get(transferId);
		if (!upload) return Promise.reject(new Error("Upload nicht gefunden"));

		const buffer = Buffer.from(data, "base64");

		return upload.queue(() => {
			return new Promise<void>((resolve, reject) => {
				fs.write(upload.fd, buffer, 0, buffer.length, start, (err) => {
					if (err) return reject(err);
					resolve();
				});
			});
		});
	}

	/**
	 * END
	 */
	function handleChunkEnd({ transferId }: { transferId: string }) {
		const upload = uploads.get(transferId);
		if (!upload) return Promise.resolve();

		return upload.queue(() => {
			return new Promise<void>((resolve, reject) => {
				fs.close(upload.fd, (err) => {
					if (err) return reject(err);
					uploads.delete(transferId);
					console.log("Upload fertig:", upload.path);
					resolve();
				});
			});
		});
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
					}
				}

				console.log(msg);
				broadcast(room, data, ws);
			});
		},
	);

	return { wss };
}
