import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { exitWithReason, getRoomIds, safeTokenCompare } from "./util/util";
import { createYjsWSS, initRooms } from "./ws/handler";
import { createServer } from "node:http";
import { createControlWSS } from "./ws/control-handler";
import { createRoom, roomExists } from "./util/fs";
import { LearningAI } from "./fsrs/fsrs";
import Logger from "./util/logger";

const SERVER_PASSWORD = process.env.SERVER_PASSWORD || "";
const ROOM_JSON =
	process.env.ROOMS || exitWithReason("Could not found a Room id in .env");

const LEARNING_DB_PATH =
	process.env.LEARNING_DB_PATH ||
	exitWithReason("Could not found a Learning Path in .env");

export async function createApp() {
	const corsOrigin = process.env.CORS_ORIGIN || "*";
	const app = express();
	const server = createServer(app);
	const learningAI = new LearningAI(LEARNING_DB_PATH, new Logger());

	const ids = getRoomIds(ROOM_JSON);

	for (const room_id of ids) {
		if (!roomExists(room_id)) {
			createRoom(room_id);
		}
	}

	await initRooms();

	app.use(cors({ origin: corsOrigin }));

	const limiter = rateLimit({
		windowMs: 60 * 1000,
		max: 200,
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

	//bekommt die Flashcards die Heute dran sind!
	app.get("/learn/daily", async (req, res, next) => {
		const cards = await learningAI.getDailyCards();
		res.status(200).json(cards);
	});

	//scheudled neue Flashcards
	app.get("/learn/:id/scheudle/:g", async (req, res, next) => {
		const id = req.params.id;
		const g = req.params.g;
		const error = await learningAI.scheudleCard(id, Number(g));

		if (error == 0) {
			res.status(202).send("Sucess");
		} else {
			res.status(400).send("Failed");
		}
	});

	app.use("/learn/newCard", express.json());

	app.post("/learn/newCard", async (req, res, next) => {
		const body = req.body as Record<string, string>;

		if (!body["topic"] || !body["question"] || !body["answer"]) {
			res.status(400).send();
			return;
		}

		await learningAI.addNewCard(
			body["topic"],
			body["question"],
			body["answer"],
		);

		res.status(202).send();
	});

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
