import { Level } from "level";
import { createWriteStream, existsSync, lstatSync, WriteStream } from "node:fs";
import { exitWithReason } from "./util";
import { join } from "node:path";

export enum LogLevel {
	NOT_SET = 0,
	DEBUG,
	INFO,
	WARNING,
	ERROR,
	CRITICAL,
}

export interface Log {
	date: Date;
	message: string;
	level: LogLevel;
	causing:
		| "scheudle"
		| "create"
		| "rename"
		| "delete"
		| "chunk-start"
		| "chunk-data"
		| "chunk-end"
		| "update"
		| "websocket"
		| "sync"
		| "unsubscribe";
}

export default class Logger {
	private loggerDir: string;
	private logs: Log[];
	private file?: WriteStream;
	private logPath?: string;

	constructor() {
		this.loggerDir =
			process.env.LOG_PATH ||
			exitWithReason("Please Provide a Directory to save LogFiles");
		this.logs = [];
		this.init();
	}

	init() {
		if (existsSync(this.loggerDir)) {
			if (lstatSync(this.loggerDir).isDirectory()) {
				this.logPath = join(this.loggerDir, `LOG_${Date.now()}.log`);
				this.file = createWriteStream(this.logPath, {
					encoding: "utf-8",
				});
			} else {
				exitWithReason(
					`${this.loggerDir} not exists or is not a Directory`,
				);
			}
		} else {
			exitWithReason(
				`${this.loggerDir} not exists or is not a Directory`,
			);
		}
	}

	handleInfo(m: Log) {
		//TODO
	}

	handleDebug(m: Log) {
		//TODO
		const Log = this.stringify(m);
		console.debug(Log);
	}

	handleWarning(m: Log) {
		//TODO
		const Log = this.stringify(m);
		console.warn(Log);
	}

	handleCritical(m: Log) {
		//TODO
		const Log = this.stringify(m);
		console.error(Log);
	}

	handleError(m: Log) {
		//TODO
		const Log = this.stringify(m);
		console.error(Log);
	}

	stringify(m: Log): string {
		return `[${this.stringifyDate(m.date)}]${this.stringifyLogLevel(m.level)}:${m.message} CAUSING ${m.causing}\n`;
	}

	stringifyDate(d: Date): string {
		return d.toISOString();
	}

	stringifyLogLevel(level: LogLevel): string {
		switch (level) {
			case LogLevel.INFO:
				return "INFO";
			case LogLevel.WARNING:
				return "WARNING";
			case LogLevel.CRITICAL:
				return "CRITICAL";
			case LogLevel.DEBUG:
				return "DEBUG";
			case LogLevel.ERROR:
				return "ERROR";

			default:
				return "NOT_SET";
		}
	}

	log(m: Log) {
		this.logs.push(m);

		const level = m.level;

		switch (level) {
			case LogLevel.INFO:
				this.handleInfo(m);
				break;

			case LogLevel.DEBUG:
				this.handleDebug(m);
				break;

			case LogLevel.WARNING:
				this.handleWarning(m);
				break;

			case LogLevel.CRITICAL:
				this.handleCritical(m);
				break;

			case LogLevel.ERROR:
				this.handleError(m);
				break;

			default:
				break;
		}

		if (this.file) {
			const Log = this.stringify(m);
			this.file.write(Log);
		}
	}
}
