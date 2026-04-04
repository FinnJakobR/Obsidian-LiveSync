import { ContentJSON, YMap, YMapEvent } from "yjs/dist/src/internals";
import { DocHandle, SyncManager } from "./sync";
import { normalizePath, Notice, TFile, TFolder, Vault } from "obsidian";
import { LiveShareSettings } from "types";
import {
	ensureFolder,
	getFileByPath,
	isTextFile,
	normalizeLineEndings,
	toCanonicalPath,
	toLocalPath,
	VAULT_EVENT_SETTLE_MS,
} from "utils/utils";

export interface FileEntry {
	hash: string;
	size: number;
	mtime: number;
	binary?: boolean;
	directory?: boolean;
}

async function hashBuffer(buf: ArrayBuffer): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", buf);
	return Array.from(new Uint8Array(hash))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function hashContent(content: string): Promise<string> {
	return hashBuffer(new TextEncoder().encode(content).buffer);
}

export class ManifestManager {
	private syncManager: SyncManager | null = null;
	private docHandle: DocHandle | null = null;
	private manifest: YMap<FileEntry> | null = null;
	private observer: ((events: YMapEvent<FileEntry>) => void) | null = null;

	constructor(
		private vault: Vault,
		private settings: LiveShareSettings,
	) {}

	updateSettings(settings: LiveShareSettings) {
		this.settings = settings;
	}

	async connect(syncManager: SyncManager): Promise<number> {
		this.syncManager = syncManager;
		this.docHandle = syncManager.getDoc("__manifest__");
		if (!this.docHandle) return 0;

		this.manifest = this.docHandle.doc.getMap("files");

		console.log("Manifest", this.manifest.toJSON());

		try {
			await syncManager.waitForSync("__manifest__");
		} catch (e) {
			console.error(e);
			return 0;
		}

		return 1;
	}

	async publishManifest(options?: { purge?: boolean }): Promise<void> {
		if (!this.manifest || !this.docHandle) return;
		const files = this.getSharedFiles();

		const entries = new Map<string, FileEntry>();
		for (const file of files) {
			try {
				const binary = !isTextFile(file.path);
				const canonicalPath = toCanonicalPath(normalizePath(file.path));

				if (binary) {
					const binaryContent = await this.vault.readBinary(file);
					entries.set(canonicalPath, {
						hash: await hashBuffer(binaryContent),
						size: file.stat.size,
						mtime: file.stat.mtime,
						binary: true,
					});
				} else {
					const content = normalizeLineEndings(
						await this.vault.read(file),
					);
					entries.set(canonicalPath, {
						hash: await hashContent(content),
						size: content.length,
						mtime: file.stat.mtime,
					});
				}
			} catch {
				new Notice(`Live Share: failed to read ${file.path}, skipping`);
			}
		}

		for (const item of this.vault.getAllLoadedFiles()) {
			if (!(item instanceof TFolder)) continue;
			if (!item.path || item.path === "/") continue;

			if (item.children.length > 0) continue;
			entries.set(toCanonicalPath(normalizePath(item.path)), {
				hash: "",
				size: 0,
				mtime: 0,
				directory: true,
			});
		}

		this.docHandle.doc.transact(() => {
			if (options?.purge) {
				for (const filePath of this.manifest?.keys() ?? []) {
					if (!entries.has(filePath)) {
						this.manifest?.delete(filePath);
					}
				}
			}
			for (const [filePath, fileEntry] of entries) {
				const existing = this.manifest?.get(filePath);
				if (existing && existing.hash === fileEntry.hash) continue;
				this.manifest?.set(filePath, fileEntry);
			}
		});
	}

	async syncFromManifest(
		mute?: (path: string) => void,
		unmute?: (path: string) => void,
		requestBinary?: (path: string) => void,
		options?: { skipText?: boolean },
	): Promise<number> {
		if (!this.manifest || !this.syncManager) return 0;

		let synced = 0;
		const entries = Array.from(this.manifest.entries());

		for (const [path, entry] of entries) {
			if (!path || path.startsWith("/") || path.startsWith("\\"))
				continue;
			const segments = path.split(/[\\/]/);
			if (segments.some((segment) => segment === ".." || segment === "."))
				continue;

			const diskPath = toLocalPath(path);
			if (entry.directory) {
				const existing = this.vault.getAbstractFileByPath(diskPath);
				if (!existing) {
					await ensureFolder(this.vault, diskPath);
					synced++;
				}
				continue;
			}

			if (options?.skipText && !entry.binary && isTextFile(path))
				continue;

			const localFile = getFileByPath(this.vault, diskPath);

			let needsSync = false;
			if (!localFile) {
				needsSync = true;
			} else if (entry.binary) {
				const binaryContent = await this.vault.readBinary(localFile);
				if ((await hashBuffer(binaryContent)) !== entry.hash) {
					needsSync = true;
				}
			} else {
				const content = normalizeLineEndings(
					await this.vault.read(localFile),
				);
				if ((await hashContent(content)) !== entry.hash) {
					needsSync = true;
				}
			}

			if (!needsSync) continue;

			if (entry.binary) {
				requestBinary?.(path);
				synced++;
				continue;
			}

			const tempHandle = this.syncManager.getDoc(path);
			console.log("get Doc from Manifest!");
			if (!tempHandle) continue;

			try {
				await this.syncManager.waitForSync(path);

				const content = tempHandle.text.toString();

				const parentDir = diskPath.substring(
					0,
					diskPath.lastIndexOf("/"),
				);
				if (parentDir) await ensureFolder(this.vault, parentDir);

				mute?.(diskPath);
				try {
					if (localFile) {
						await this.vault.modify(localFile, content);
					} else {
						await this.vault.create(diskPath, content);
					}
				} finally {
					if (unmute) {
						setTimeout(
							() => unmute(diskPath),
							VAULT_EVENT_SETTLE_MS,
						);
					}
				}
				synced++;
			} catch {
				// Failed to sync individual file, continue with rest
			}
		}

		return synced;
	}

	setManifestChangeHandler(
		callback: (added: string[], removed: string[]) => void,
	): void {
		if (!this.manifest) return;

		if (this.observer && this.manifest) {
			this.manifest.unobserve(this.observer);
		}

		this.observer = (event: YMapEvent<FileEntry>) => {
			const added: string[] = [];
			const removed: string[] = [];

			event.changes.keys.forEach((change, key) => {
				if (change.action === "add") added.push(key);
				else if (change.action === "delete") removed.push(key);
			});
			if (added.length > 0 || removed.length > 0) {
				callback(added, removed);
			}
		};
		this.manifest.observe(this.observer);
	}

	async updateFile(
		file: TFile,
		content: string | ArrayBuffer,
	): Promise<void> {
		if (!this.manifest) return;
		const canonical = toCanonicalPath(normalizePath(file.path));
		if (content instanceof ArrayBuffer) {
			this.manifest.set(canonical, {
				hash: await hashBuffer(content),
				size: content.byteLength,
				mtime: file.stat.mtime,
				binary: true,
			});
		} else {
			const normalized = normalizeLineEndings(content);
			this.manifest.set(canonical, {
				hash: await hashContent(normalized),
				size: normalized.length,
				mtime: file.stat.mtime,
			});
		}
	}

	removeFile(path: string): void {
		if (!this.manifest) return;
		this.manifest.delete(toCanonicalPath(normalizePath(path)));
	}

	addFolder(rawPath: string): void {
		if (!this.manifest) return;
		const path = toCanonicalPath(normalizePath(rawPath));
		if (this.manifest.has(path)) return;
		this.manifest.set(path, {
			hash: "",
			size: 0,
			mtime: 0,
			directory: true,
		});
	}

	renameFile(
		oldPath: string,
		newPath: string,
		syncManager?: SyncManager,
	): void {
		if (!this.manifest || !this.docHandle) return;
		const normOld = toCanonicalPath(normalizePath(oldPath));
		const normNew = toCanonicalPath(normalizePath(newPath));
		const fileEntry = this.manifest.get(normOld);
		if (fileEntry) {
			this.docHandle.doc.transact(() => {
				this.manifest?.delete(normOld);
				this.manifest?.set(normNew, fileEntry);
			});
		}
		if (syncManager) {
			syncManager.releaseDoc(normOld);
		}
	}

	getEntries(): Map<string, FileEntry> {
		if (!this.manifest) return new Map();
		return new Map(this.manifest.entries());
	}

	destroy(): void {
		if (this.observer && this.manifest) {
			this.manifest.unobserve(this.observer);
			this.observer = null;
		}
		if (this.syncManager) {
			this.syncManager.releaseDoc("__manifest__");
		}
		this.docHandle = null;
		this.manifest = null;
		this.syncManager = null;
	}

	private getSharedFiles(): TFile[] {
		return this.vault.getFiles();
	}
}
