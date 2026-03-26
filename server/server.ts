import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { string } from "lib0";
import { safeTokenCompare } from "./util/util";
import { error } from "node:console";
import { createYjsWSS, initRooms } from "./ws/handler";
import { createServer } from "node:http";
import { createControlWSS } from "./ws/control-handler";

const SERVER_PASSWORD = process.env.SERVER_PASSWORD || "";

export async function createApp() {
	const corsOrigin = process.env.CORS_ORIGIN || "*";
	const app = express();
	const server = createServer(app);

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
			const room =
				process.env.ROOM_ID || "d9e835e8-4c15-4375-9605-cac6481818f6";
			if (!room || !safeTokenCompare(roomId, room))
				return {
					ok: false,
					code: 403,
					reason: "Invalid room or token",
				};

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
			console.log("MUX!");

			const baseRoomId = muxMatch[1];
			const auth = authenticateUpgrade(url, baseRoomId);
			if (!auth.ok) {
				console.log(auth);
				rejectUpgrade(socket, auth.code, auth.reason);
				return;
			}
			yjs.muxWss.handleUpgrade(req, socket, head, (ws) => {
				yjs.muxWss.emit("connection", ws, req, baseRoomId);
			});
			return;
		}

		const ctrlMatch = url.pathname.match(/^\/control\/(.+)$/);
		console.log(ctrlMatch);

		if (ctrlMatch) {
			console.log("controll!");
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

createApp();
