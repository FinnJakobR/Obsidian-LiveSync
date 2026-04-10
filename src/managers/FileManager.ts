import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
	type FileManager,
	normalizePath,
	Notice,
	TAbstractFile,
	TFile,
	Vault,
} from "obsidian";
import { OfflineQueue } from "queues/offlineQueue";
import { FileOp } from "types";
import {
	CHUNK_SIZE,
	ensureFolder,
	isTextFile,
	normalizeLineEndings,
	STALE_TRANSFER_MS,
	toCanonicalPath,
	toLocalPath,
	VAULT_EVENT_SETTLE_MS,
} from "utils/utils";

interface OutgoingTransfer {
	path: string;
	content: string;
	binary: boolean;
	totalChunks: number;
	lastActivity: number;
}

interface ChunkAssembly {
	chunks: string[];
	totalSize: number;
	binary?: boolean;
	transferId?: string;
	lastActivity: number;
}

export default class FileOpsManager {
	private vault: Vault;
	private fileManager: FileManager;
	private offlineQueue = new OfflineQueue();
	private sendOp: ((op: FileOp) => void) | null = null;
	private sendQueue = new Map<string, Promise<void>>();
	private opQueue = new Map<string, Promise<void>>();
	private outgoingTransfers = new Map<string, OutgoingTransfer>();
	private pendingChunks = new Map<string, ChunkAssembly>();

	private staleTimer: ReturnType<typeof setInterval> | null = null;

	private mutedPaths = new Map<string, number>();

	private isOnline = true;

	constructor(vault: Vault, fileManager: FileManager) {
		this.vault = vault;
		this.fileManager = fileManager;
		this.staleTimer = setInterval(() => this.purgeStaleTransfers(), 60_000);
	}

	setOnline(online: boolean): void {
		const wasOffline = !this.isOnline;
		this.isOnline = online;
		if (online && wasOffline && this.sendOp) {
			console.log("drain offline Queue!", this.offlineQueue.size);
			const ops = this.offlineQueue.drain();
			for (const op of ops) {
				this.sendOp(op);
			}
		}
	}

	destroy(): void {
		if (this.staleTimer) {
			clearInterval(this.staleTimer);
			this.staleTimer = null;
		}
		this.outgoingTransfers.clear();
		this.pendingChunks.clear();
		this.offlineQueue.clear();
	}

	private purgeStaleTransfers(): void {
		const now = Date.now();
		for (const [key, assembly] of this.pendingChunks) {
			if (now - assembly.lastActivity > STALE_TRANSFER_MS) {
				this.pendingChunks.delete(key);
			}
		}
		for (const [id, transfer] of this.outgoingTransfers) {
			if (now - transfer.lastActivity > STALE_TRANSFER_MS) {
				this.outgoingTransfers.delete(id);
			}
		}
	}

	isPathMuted(path: string): boolean {
		return (this.mutedPaths.get(normalizePath(path)) ?? 0) > 0;
	}

	setSender(sender: (op: FileOp) => void) {
		this.sendOp = sender;
	}
	async applyRemoteOp(op: FileOp) {
		const paths = this.getOpPaths(op);

		// Chain onto existing queue for all affected paths atomically
		const currentQueues = paths.map(
			(path) => this.opQueue.get(path) ?? Promise.resolve(),
		);
		const gate = Promise.all(currentQueues);

		const promise = gate.then(() => this.applyInnerFileOp(op));

		// Set the new promise for all paths BEFORE awaiting
		for (const path of paths) this.opQueue.set(path, promise);

		try {
			await promise;
		} finally {
			for (const path of paths) {
				if (this.opQueue.get(path) === promise)
					this.opQueue.delete(path);
			}
		}
	}

	async onFileCreate(file: TAbstractFile) {
		const localPath = normalizePath(file.path);
		const wirePath = toCanonicalPath(localPath);
		if (!(file instanceof TFile)) {
			this.emitOp({ type: "folder-create", path: wirePath });
			return;
		}

		const prev = this.sendQueue.get(localPath) ?? Promise.resolve();
		const binary = !isTextFile(file.path);
		const tFile = file;

		const task = prev.then(async () => {
			if (!this.sendOp) return;

			try {
				if (binary) {
					const binaryContent = await this.vault.readBinary(tFile);

					if (!this.mutedPaths.get(localPath))
						this.sendFileContent(
							wirePath,
							arrayBufferToBase64(binaryContent),
							true,
						);
				} else {
					const content = normalizeLineEndings(
						await this.vault.read(tFile),
					);

					if (!this.mutedPaths.get(localPath))
						this.sendFileContent(wirePath, content, false);
				}
			} catch (e) {
				console.log(e);
				// File may have been deleted/renamed before we could read it
				new Notice(`Live Share: failed to sync ${localPath}`);
			}
		});

		this.sendQueue.set(localPath, task);
		await task;
		if (this.sendQueue.get(localPath) == task)
			this.sendQueue.delete(localPath);
	}

	async onFileModify(file: TAbstractFile) {
		const localPath = normalizePath(file.path);
		if (!this.sendOp) return;
		if (!(file instanceof TFile)) return;
		const binary = !isTextFile(file.path);

		const wirePath = toCanonicalPath(localPath);
		const tFile = file;

		const prev = this.sendQueue.get(localPath) ?? Promise.resolve();

		const task = prev.then(async () => {
			if (!this.sendOp) return;

			try {
				if (binary) {
					const binaryContent = await this.vault.readBinary(tFile);
					const content = arrayBufferToBase64(binaryContent);
					if (content.length > CHUNK_SIZE) {
						this.sendChunked(wirePath, content, true);
					} else {
						this.emitOp({
							type: "modify",
							path: wirePath,
							content,
							binary: true,
						});
					}
				} else {
					const content = await this.vault.read(tFile);
					if (content.length > CHUNK_SIZE) {
						this.sendChunked(wirePath, content, false);
					} else {
						this.emitOp({
							type: "modify",
							path: wirePath,
							content,
							binary: false,
						});
					}
				}
			} catch {
				new Notice(`Live Share: failed to sync ${localPath}`);
			}
		});

		this.sendQueue.set(localPath, task);
		await task;
		if (this.sendQueue.get(localPath) === task)
			this.sendQueue.delete(localPath);
	}

	async onFileDelete(file: TAbstractFile) {
		const localPath = normalizePath(file.path);
		if (!this.sendOp) return;

		const wirePath = toCanonicalPath(localPath);
		const prev = this.sendQueue.get(localPath) ?? Promise.resolve();

		const task = prev.then(() => {
			this.emitOp({ type: "delete", path: wirePath });
		});
		this.sendQueue.set(localPath, task);
	}

	async onFileRename(file: TAbstractFile, oldPath: string) {
		const localNew = normalizePath(file.path);
		const localOld = normalizePath(oldPath);

		if (!this.sendOp) return;

		const prev = this.sendQueue.get(localOld) ?? Promise.resolve();
		const task = prev.then(() => {
			this.emitOp({
				type: "rename",
				oldPath: toCanonicalPath(localOld),
				newPath: toCanonicalPath(localNew),
			});
		});

		this.sendQueue.set(localOld, task);
		this.sendQueue.set(localNew, task);
	}

	private emitOp(op: FileOp): void {
		if (!this.sendOp) return;
		if (!this.isOnline) {
			this.offlineQueue.enqueue(op);
			return;
		}

		this.sendOp(op);
	}

	private sendFileContent(path: string, content: string, binary: boolean) {
		if (content.length > CHUNK_SIZE) {
			this.sendChunked(path, content, binary);
		} else {
			this.emitOp(
				binary
					? { type: "create", path, content, binary: true }
					: { type: "create", path, content },
			);
		}
	}

	private sendChunked(path: string, content: string, binary: boolean) {
		if (!this.sendOp) return;
		const transferId = crypto.randomUUID();
		const totalChunks = Math.ceil(content.length / CHUNK_SIZE);

		this.outgoingTransfers.set(transferId, {
			path,
			content,
			binary,
			totalChunks,
			lastActivity: Date.now(),
		});

		this.emitOp(
			binary
				? {
						type: "chunk-start",
						path,
						totalSize: content.length,
						binary: true,
						transferId,
					}
				: {
						type: "chunk-start",
						path,
						totalSize: content.length,
						transferId,
					},
		);

		for (let i = 0; i < totalChunks; i++) {
			const chunk = content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
			this.emitOp({
				type: "chunk-data",
				path,
				index: i,
				data: chunk,
				transferId,
			});
		}
		this.emitOp({ type: "chunk-end", path, transferId });
	}

	private getOpPaths(op: FileOp): string[] {
		const paths: string[] = [];
		if ("path" in op) paths.push(normalizePath(op.path));
		if ("oldPath" in op) paths.push(normalizePath(op.oldPath));
		if ("newPath" in op) paths.push(normalizePath(op.newPath));
		return paths;
	}

	async applyFileOp(op: FileOp) {
		const paths = this.getOpPaths(op);
		const waitFor = paths
			.map((path) => this.opQueue.get(path))
			.filter(Boolean) as Promise<void>[];

		if (waitFor.length > 0) await Promise.all(waitFor);

		const promise = this.applyInnerFileOp(op);

		for (const path of paths) this.opQueue.set(path, promise);

		await promise;

		for (const path of paths) {
			if (this.opQueue.get(path) === promise) this.opQueue.delete(path);
		}
	}

	private async applyInnerFileOp(rawOp: FileOp) {
		const op = { ...rawOp } as FileOp;

		if ("path" in op) op.path = toLocalPath(normalizePath(op.path));
		if ("oldPath" in op)
			op.oldPath = toLocalPath(normalizePath(op.oldPath));
		if ("newPath" in op)
			op.newPath = toLocalPath(normalizePath(op.newPath));

		if ("path" in op && !this.isPathSafe(op.path)) return;
		if ("oldPath" in op && !this.isPathSafe(op.oldPath)) return;
		if ("newPath" in op && !this.isPathSafe(op.newPath)) return;

		const paths = this.getOpPaths(op);

		for (const path of paths) this.mutePathEvents(path);

		try {
			switch (op.type) {
				case "create": {
					const exists = this.vault.getAbstractFileByPath(op.path);
					if (exists && exists instanceof TFile) {
						if (op.binary) {
							const binaryContent = base64ToArrayBuffer(
								op.content,
							);
							await this.vault.modifyBinary(
								exists,
								binaryContent,
							);
						} else {
							await this.vault.modify(exists, op.content);
						}
					} else if (!exists) {
						const parentDir = op.path.substring(
							0,
							op.path.lastIndexOf("/"),
						);
						if (parentDir)
							await ensureFolder(this.vault, parentDir);

						if (op.binary) {
							const binaryContent = base64ToArrayBuffer(
								op.content,
							);

							await this.vault.createBinary(
								op.path,
								binaryContent,
							);
						} else {
							await this.vault.create(op.path, op.content);
						}
					}

					break;
				}

				case "modify": {
					const file = this.vault.getAbstractFileByPath(op.path);
					if (file instanceof TFile) {
						if (op.binary) {
							const binaryContent = base64ToArrayBuffer(
								op.content,
							);
							await this.vault.modifyBinary(file, binaryContent);
						} else {
							await this.vault.modify(file, op.content);
						}
					}
					break;
				}

				case "delete": {
					const file = this.vault.getAbstractFileByPath(op.path);
					if (file) {
						try {
							await this.fileManager.trashFile(file);
						} catch {
							// File may have already been deleted
						}
					}

					this.pendingChunks.delete(op.path);
					break;
				}

				case "rename": {
					let file = this.vault.getAbstractFileByPath(op.oldPath);
					if (!file) {
						await new Promise((resolve) =>
							setTimeout(resolve, 300),
						);
						file = this.vault.getAbstractFileByPath(op.oldPath);
					}
					const allreadyExists = this.vault.getAbstractFileByPath(
						op.newPath,
					);
					if (allreadyExists && !file) {
						break;
					}

					if (file && !allreadyExists) {
						const parentDir = op.newPath.substring(
							0,
							op.newPath.lastIndexOf("/"),
						);
						if (parentDir)
							await ensureFolder(this.vault, parentDir);
						try {
							await this.vault.rename(file, op.newPath);
						} catch (renameErr) {
							if (!this.vault.getAbstractFileByPath(op.newPath))
								throw renameErr;
						}
					} else if (file && allreadyExists) {
						await this.fileManager.trashFile(file);
					}

					break;
				}

				case "chunk-start": {
					if (op.totalSize <= 0) break;

					const chunkKey = op.transferId ?? op.path;
					this.pendingChunks.delete(chunkKey);

					this.pendingChunks.set(chunkKey, {
						chunks: [],
						totalSize: op.totalSize,
						binary: op.binary,
						transferId: op.transferId,
						lastActivity: Date.now(),
					});

					break;
				}

				case "chunk-data": {
					const dataKey = op.transferId ?? op.path;
					const assembly = this.pendingChunks.get(dataKey);
					if (assembly) {
						const expectedChunks = Math.ceil(
							assembly.totalSize / CHUNK_SIZE,
						);
						if (op.index < 0 || op.index >= expectedChunks) break;
						assembly.chunks[op.index] = op.data;
						assembly.lastActivity = Date.now();
					}

					break;
				}

				case "chunk-end": {
					const endKey = op.transferId ?? op.path;
					const assembly = this.pendingChunks.get(endKey);
					if (!assembly) break;

					const expectedChunks = Math.ceil(
						assembly.totalSize / CHUNK_SIZE,
					);
					const missingSeqs: number[] = [];

					for (let i = 0; i < expectedChunks; i++) {
						if (assembly.chunks[i] === undefined)
							missingSeqs.push(i);
					}

					if (missingSeqs.length > 0) {
						if (assembly.transferId) {
							const receivedSeqs: number[] = [];
							for (let i = 0; i < expectedChunks; i++) {
								if (assembly.chunks[i] === undefined)
									receivedSeqs.push(i);
							}
							this.sendOp?.({
								type: "chunk-resume",
								path: op.path,
								transferId: assembly.transferId,
								receivedSeqs,
							});
							break;
						}
						this.pendingChunks.delete(endKey);
						new Notice(
							`Live Share: incomplete transfer for ${op.path}, some chunks were lost`,
						);
						break;
					}

					this.pendingChunks.delete(endKey);
					const joined = assembly.chunks.join("");
					const exists = this.vault.getAbstractFileByPath(op.path);
					if (!exists) {
						const parentDir = op.path.substring(
							0,
							op.path.lastIndexOf("/"),
						);
						if (parentDir)
							await ensureFolder(this.vault, parentDir);
					}
					if (assembly.binary) {
						const binaryData = base64ToArrayBuffer(joined);
						await this.vault.adapter.writeBinary(
							op.path,
							binaryData,
						);
					} else {
						await this.vault.adapter.write(op.path, joined);
					}
					break;
				}

				case "chunk-resume": {
					const transfer = this.outgoingTransfers.get(op.transferId);
					if (!transfer) break;
					transfer.lastActivity = Date.now();
					const receivedSet = new Set(op.receivedSeqs);
					for (let i = 0; i < transfer.totalChunks; i++) {
						if (!receivedSet.has(i)) {
							const chunk = transfer.content.slice(
								i * CHUNK_SIZE,
								(i + 1) * CHUNK_SIZE,
							);
							this.sendOp?.({
								type: "chunk-data",
								path: transfer.path,
								index: i,
								data: chunk,
								transferId: op.transferId,
							});
						}
					}
					this.sendOp?.({
						type: "chunk-end",
						path: transfer.path,
						transferId: op.transferId,
					});
					break;
				}
				case "folder-create": {
					await ensureFolder(this.vault, op.path);
					break;
				}
			}
		} catch (e) {
			const opPath = "path" in op ? op.path : "unknown";
			console.log(e);
			new Notice(`Live Share: failed to apply ${op.type} for ${opPath}`);
		} finally {
			setTimeout(() => {
				for (const path of paths) this.unmutePathEvents(path);
			}, VAULT_EVENT_SETTLE_MS);
		}
	}

	unmutePathEvents(path: string): void {
		const norm = normalizePath(path);
		const count = this.mutedPaths.get(norm) ?? 0;
		if (count <= 1) {
			this.mutedPaths.delete(norm);
		} else {
			this.mutedPaths.set(norm, count - 1);
		}
	}

	mutePathEvents(path: string): void {
		const norm = normalizePath(path);
		this.mutedPaths.set(norm, (this.mutedPaths.get(norm) ?? 0) + 1);
	}

	private isPathSafe(path: string): boolean {
		if (!path || path.startsWith("/") || path.startsWith("\\"))
			return false;
		const segments = path.split(/[\\/]/);
		return !segments.some((segment) => segment === ".." || segment === ".");
	}
}
