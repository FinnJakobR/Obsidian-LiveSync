import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { string } from "lib0";
import { exitWithReason, getRoomIds, safeTokenCompare } from "./util/util";
import { error } from "node:console";
import { createYjsWSS, initRooms } from "./ws/handler";
import { createServer } from "node:http";
import { createControlWSS } from "./ws/control-handler";
import { createRoom, roomExists } from "./util/fs";
import { exit } from "node:process";

const SERVER_PASSWORD = process.env.SERVER_PASSWORD || "";
const ROOM_JSON =
	process.env.ROOMS || exitWithReason("Could not found a Room id in .env");

export async function createApp() {
	const corsOrigin = process.env.CORS_ORIGIN || "*";
	const app = express();
	const server = createServer(app);

	const ids = getRoomIds(ROOM_JSON);

	console.log(ids);

	for (const room_id of ids) {
		if (!roomExists(room_id)) {
			createRoom(room_id);
		}
	}

	await initRooms();

	app.use(cors({ origin: corsOrigin }));

	const limiter = rateLimit({
		windowMs: 60 * 1000,
		max: 30,
		standardHeaders: true,
	});

	app.use("/", limiter);

	if (SERVER_PASSWORD) {
		app.use("/", (req, res, next) => {
			const provided = req.headers["x-server-password"];

			if (
				typeof provided !== "string" ||
				!safeTokenCompare(provided, SERVER_PASSWORD)
			) {
				res.status(401).json({ error: "invalid server passwprd" });
				return;
			}

			next();
		});
	}

	const yjs = createYjsWSS();
	const control = createControlWSS();

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		if (SERVER_PASSWORD) {
			const provided = url.searchParams.get("password");
			if (!provided || !safeTokenCompare(provided, SERVER_PASSWORD)) {
				socket.write(
					"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nInvalid server password",
				);
				socket.destroy();
				return;
			}
		}

		function authenticateUpgrade(
			url: URL,
			roomId: string,
		): { ok: true } | { ok: false; code: number; reason: string } {
			const foundId = ids.find((id) => safeTokenCompare(roomId, id));

			if (!roomId || !foundId) {
				return {
					ok: false,
					code: 403,
					reason: "Invalid room or token",
				};
			}

			return { ok: true };
		}

		function rejectUpgrade(
			socket: import("stream").Duplex,
			code: number,
			reason: string,
		) {
			socket.write(
				`HTTP/1.1 ${code} ${reason}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}`,
			);
			socket.destroy();
		}

		const muxMatch = url.pathname.match(/^\/ws-mux\/(.+)$/);

		if (muxMatch) {
			const baseRoomId = muxMatch[1];
			const auth = authenticateUpgrade(url, baseRoomId);
			if (!auth.ok) {
				rejectUpgrade(socket, auth.code, auth.reason);
				return;
			}
			yjs.muxWss.handleUpgrade(req, socket, head, (ws) => {
				yjs.muxWss.emit("connection", ws, req, baseRoomId);
			});
			return;
		}

		const ctrlMatch = url.pathname.match(/^\/control\/(.+)$/);

		if (ctrlMatch) {
			const roomId = ctrlMatch[1];
			const auth = authenticateUpgrade(url, roomId);
			if (!auth.ok) {
				rejectUpgrade(socket, auth.code, auth.reason);
				return;
			}
			control.wss.handleUpgrade(req, socket, head, (ws) => {
				control.wss.emit("connection", ws, req, roomId);
			});
			return;
		}

		socket.destroy();
	});

	server.listen(3000, () => {
		console.log("Server Started!");
	});
}

void createApp();
