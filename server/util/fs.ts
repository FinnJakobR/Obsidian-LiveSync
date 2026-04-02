import {
	createWriteStream,
	Dir,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	writeFileSync,
	WriteStream,
} from "fs";
import path, { basename, join, sep } from "path";
import { exitWithReason } from "./util";

const BASE_PATH =
	process.env.BACKUP_BASE_PATH ||
	exitWithReason("Could not found Backup Base Path in env");

const TRASH_PATH = ".trash";

export function createRoom(id: string): void {
	if (roomExists(id)) return;
	const p = join(BASE_PATH, id);
	mkdirSync(p);
	mkdirSync(join(p, TRASH_PATH));
	return;
}

export function roomExists(id: string): boolean {
	return existsSync(join(BASE_PATH, id));
}

export function getPathsByRoom(id: string): string[] {
	if (!roomExists(id)) return [];

	const p = join(BASE_PATH, id);

	const urls = readdirSync(p);

	return urls;
}

export interface FileCreateOperation {
	type: "create";
	path: string;
	content: string;
	binary?: boolean;
}

export interface FileDeleteOperation {
	type: "delete";
	path: string;
}

export interface FileRenameOperation {
	type: "rename";
	oldPath: string;
	newPath: string;
}

export interface FolderCreateOperation {
	type: "folder-create";
	path: string;
}

export interface FileModifyOperation {
	type: "modify";
	path: string;
	content: string;
	binary?: boolean;
}

export interface FileChunkStartOperation {
	type: "file-chunk-start";
	path: string;
	totalSize: number;
	binary?: boolean;
	transferId?: string;
}

export interface FileChunkDataOperation {
	type: "file-chunk-data";
	path: string;
	index: number;
	data: string;
	transferId?: string;
}

export interface FileChunkEndOperation {
	type: "file-chunk-end";
	path: string;
	transferId?: string;
}

export interface Chunk {
	path: string;
	stream: WriteStream;
	lastWrittenIndex: number;
	indexQueue: FileChunkDataOperation[];
}

const ChunkMap: Map<string, Chunk> = new Map();

export function chunkEndWritingFromEvent(
	op: FileChunkEndOperation,
	id: string,
) {
	const chunk = ChunkMap.get(op.path);
	if (!chunk) return;
	chunk.stream.close();
	ChunkMap.delete(op.path);
}

export function chunkDataWritingFromEvent(
	op: FileChunkDataOperation,
	id: string,
) {
	const chunk = ChunkMap.get(op.path ?? "");
	if (!chunk) return;

	const index = op.index;
	const nextIndex = chunk.lastWrittenIndex + 1;

	if (index > nextIndex) {
		// zu früh → puffern
		chunk.indexQueue.push(op);
		chunk.indexQueue.sort((a, b) => a.index - b.index);
		return;
	}

	if (index === nextIndex) {
		const b1 = Buffer.from(op.data, "base64");
		chunk.stream.write(b1);
		chunk.lastWrittenIndex = index;

		while (chunk.indexQueue.length > 0) {
			const next = chunk.indexQueue[0];

			if (next.index === chunk.lastWrittenIndex + 1) {
				chunk.indexQueue.shift();
				const b2 = Buffer.from(next.data, "base64");
				chunk.stream.write(b2);
				chunk.lastWrittenIndex = next.index;
			} else {
				break;
			}
		}
	}
}

export function startChunkWritingFromEvent(
	op: FileChunkStartOperation,
	id: string,
) {
	if (!op.transferId) return;

	createFileFromEvent(
		{
			type: "create",
			path: op.path,
			content: "",
			binary: true,
		},
		id,
		false,
	);

	const stream = createWriteStream(path.join(BASE_PATH, id, op.path));
	ChunkMap.set(op.path, {
		path: op.path,
		stream: stream,
		lastWrittenIndex: -1,
		indexQueue: [],
	});
}

export function createFileFromEvent(
	op: FileCreateOperation | FolderCreateOperation,
	id: string,
	isDir: boolean,
): void {
	const filePath = op.path;
	const filePathSplit = filePath.split(sep);

	let currentPath = path.join(BASE_PATH, id);

	for (let i = 0; i < filePathSplit.length - 1; i++) {
		currentPath = path.join(currentPath, filePathSplit[i]);

		if (!existsSync(currentPath)) {
			mkdirSync(currentPath);
		}
	}

	const fileName = filePathSplit[filePathSplit.length - 1];

	if (!isDir && "content" in op) {
		const content = op.content;

		if (!op.binary) {
			writeFileSync(path.join(currentPath, fileName), content, {
				encoding: "utf-8",
			});
		} else {
			writeFileSync(path.join(currentPath, fileName), content, {});
		}
	} else {
		if (!existsSync(path.join(currentPath, fileName)))
			mkdirSync(path.join(currentPath, fileName));
	}
}

export function renameFileFromEvent(op: FileRenameOperation, id: string): void {
	const oldPath = path.join(BASE_PATH, id, op.oldPath);
	const newPath = path.join(BASE_PATH, id, op.newPath);

	if (!existsSync(oldPath) || !roomExists(id)) return;

	const targetDir = path.dirname(newPath);

	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true });
	}

	renameSync(oldPath, newPath);
}

export function deleteFileFromEvent(op: FileDeleteOperation, id: string): void {
	const newOp: FileRenameOperation = {
		type: "rename",
		oldPath: op.path,
		newPath: path.join(TRASH_PATH, Date.now().toString(10), op.path),
	};

	renameFileFromEvent(newOp, id);

	return;
}

export function modifyFileFromEvent(op: FileModifyOperation, id: string): void {
	const newOp: FileCreateOperation = {
		type: "create",
		path: op.path,
		content: op.content,
		binary: op.binary,
	};

	createFileFromEvent(newOp, id, false);
}
