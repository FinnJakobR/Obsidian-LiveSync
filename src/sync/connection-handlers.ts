import LiveSync from "main";
import { Notice, TFile } from "obsidian";
import { ControlMessage, FileOp } from "types";
import { isTextFile, toLocalPath } from "utils/utils";

const CHUNK_TO_CONTROL = {
	"chunk-start": "file-chunk-start",
	"chunk-data": "file-chunk-data",
	"chunk-end": "file-chunk-end",
	"chunk-resume": "file-chunk-resume",
} as const;

const CONTROL_TO_CHUNK = Object.fromEntries(
	Object.entries(CHUNK_TO_CONTROL).map(([chunkType, controlType]) => [
		controlType,
		chunkType,
	]),
) as Record<
	(typeof CHUNK_TO_CONTROL)[keyof typeof CHUNK_TO_CONTROL],
	keyof typeof CHUNK_TO_CONTROL
>;

export function registerControlHandlers(plugin: LiveSync): void {
	const channel = plugin.controlChannel;
	if (!channel) return;

	plugin.fileOpsManager.setSender((op) => {
		if (
			op.type === "chunk-start" ||
			op.type === "chunk-data" ||
			op.type === "chunk-end"
		) {
			channel.send({
				...op,
				type: CHUNK_TO_CONTROL[op.type],
			} as ControlMessage);
		} else {
			channel.send({ type: "file-op", op });
		}
	});

	channel.on("file-op", (msg) => {
		const op = msg.op;
		const paths = [
			"path" in op ? op.path : null,
			"oldPath" in op ? op.oldPath : null,
			"newPath" in op ? op.newPath : null,
		].filter(Boolean) as string[];
		if (paths.length === 0) return;

		plugin.fileOpsManager
			.applyRemoteOp(op)
			.then(async () => {
				if (op.type === "create" && "path" in op) {
					const file = plugin.app.vault.getAbstractFileByPath(
						toLocalPath(op.path),
					);

					if (file instanceof TFile) {
						const content = isTextFile(file.path)
							? await plugin.app.vault.read(file)
							: await plugin.app.vault.readBinary(file);
						await plugin.manifestManager.updateFile(file, content);
						if (isTextFile(file.path)) {
							await plugin.backgroundSync.onFileAdded(file.path);
						}
					}
				} else if (
					op.type === "modify" &&
					"path" in op &&
					!isTextFile(op.path)
				) {
					const file = plugin.app.vault.getAbstractFileByPath(
						toLocalPath(op.path),
					);
					if (file instanceof TFile) {
						const content = await plugin.app.vault.readBinary(file);
						await plugin.manifestManager.updateFile(file, content);
					}
				} else if (op.type === "delete" && "path" in op) {
					plugin.manifestManager.removeFile(op.path);
					plugin.backgroundSync.onFileRemoved(op.path);
				} else if (
					op.type === "rename" &&
					"oldPath" in op &&
					"newPath" in op
				) {
					const renameOp = op as {
						oldPath: string;
						newPath: string;
					};
					if (isTextFile(renameOp.newPath)) {
						await plugin.backgroundSync.onFileRenamed(
							renameOp.oldPath,
							renameOp.newPath,
						);
					}
					plugin.manifestManager.renameFile(
						renameOp.oldPath,
						renameOp.newPath,
						plugin.syncManager,
					);
				}
			})
			.catch((err) => {
				new Notice("File op error!");
			});
	});

	for (const chunkType of [
		"file-chunk-start",
		"file-chunk-data",
		"file-chunk-end",
		"file-chunk-resume",
	] as const) {
		channel.on(chunkType, (msg) => {
			if (!msg.path) return;
			plugin.fileOpsManager
				.applyRemoteOp({
					...msg,
					type: CONTROL_TO_CHUNK[chunkType],
				} as FileOp)
				.catch((err) => {
					new Notice("File op error!");
				});
		});
	}

	channel.on("sync-request", (msg) => {
		if (msg.path) {
			const file = plugin.app.vault.getAbstractFileByPath(
				toLocalPath(msg.path),
			);
			if (file instanceof TFile) {
				void plugin.fileOpsManager.onFileCreate(file);
			}
		}
	});
}
