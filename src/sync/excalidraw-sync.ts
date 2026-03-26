import { normalizePath, Notice, Vault } from "obsidian";
import * as Y from "yjs";
import { SyncManager } from "./sync";
import FileOpsManager from "managers/FileManager";
import {
	DEBOUNCE_MS,
	ensureFolder,
	getFileByPath,
	toCanonicalPath,
	toLocalPath,
	VAULT_EVENT_SETTLE_MS,
} from "utils/utils";

const DRAWING_DOC_PREFIX = "__drawing__:";

interface ExcalidrawData {
	metadata: Record<string, unknown>;
	elements: Record<string, unknown>[];
	appstate: Record<string, unknown>;
	files: Record<string, Record<string, unknown>>;
}

function parseDrawing(content: string): ExcalidrawData {
	try {
		/* eslint-disable @typescript-eslint/no-unsafe-assignment */
		const parsed = JSON.parse(content);

		/* eslint-disable @typescript-eslint/no-unsafe-member-access */
		const elements = parsed.elements;
		const appstate = parsed.appstate;
		const files = parsed.files;
		const type = parsed.type;
		const version = parsed.version;
		const source = parsed.source;

		const metadata = { type, version, source };

		return { elements, appstate, files, metadata };
	} catch {
		return {
			metadata: {},
			elements: [],
			appstate: {},
			files: {},
		};
	}
}

function serializeDrawing(
	metadata: Y.Map<unknown>,
	elements: Y.Array<Y.Map<unknown>>,
	appstate: Y.Map<unknown>,
	files: Y.Map<Y.Map<unknown>>,
): string {
	const json: Record<string, unknown> = {};
	json["elements"] = [] as Array<Record<string, unknown>>;
	json["appState"] = {};
	json["files"] = {};

	for (const [key, data] of metadata) {
		json[key] = data;
	}

	for (const element of elements) {
		const newElement: Record<string, unknown> = {};
		for (const [key, data] of element) {
			newElement[key] = data;
		}
		(json["elements"] as Array<Record<string, unknown>>).push(newElement);
	}

	for (const [key, data] of appstate) {
		(json["appstate"] as Record<string, unknown>)[key] = data;
	}

	for (const [key, data] of files) {
		const x = json["files"] as Record<string, Record<string, unknown>>;
		x[key] = {};

		for (const [key1, data1] of data) {
			x[key][key1] = data1;
		}
	}

	return JSON.stringify(json, null, "\t");
}

function applyToY(ymap: Y.Map<unknown>, obj: ExcalidrawData): void {
	// Metadata
	const metadataMap = (ymap.get("metadata") as Y.Map<unknown>) ?? new Y.Map();
	if (!ymap.has("metadata")) {
		ymap.set("metadata", metadataMap);
	}

	for (const key of Object.keys(obj.metadata)) {
		metadataMap.set(key, obj.metadata[key]);
	}

	// Appstate
	const appstateMap = (ymap.get("appstate") as Y.Map<unknown>) ?? new Y.Map();
	if (!ymap.has("appstate")) {
		ymap.set("appstate", appstateMap);
	}

	for (const key of Object.keys(obj.appstate)) {
		appstateMap.set(key, obj.appstate[key]);
	}

	// Elements (YArray of YMap)
	let elementsArray = ymap.get("elements") as Y.Array<Y.Map<unknown>>;
	if (!elementsArray) {
		elementsArray = new Y.Array();
		ymap.set("elements", elementsArray);
	}

	elementsArray.delete(0, elementsArray.length);

	for (const element of obj.elements) {
		const yElement = new Y.Map();

		for (const key of Object.keys(element)) {
			yElement.set(key, element[key]);
		}

		elementsArray.push([yElement]);
	}

	// Files (YMap of YMap)
	const filesMap =
		(ymap.get("files") as Y.Map<Y.Map<unknown>>) ?? new Y.Map();
	if (!ymap.has("files")) {
		ymap.set("files", filesMap);
	}

	for (const fileKey of Object.keys(obj.files)) {
		let fileEntry = filesMap.get(fileKey) as Y.Map<unknown>;

		if (!fileEntry) {
			fileEntry = new Y.Map();
			filesMap.set(fileKey, fileEntry);
		}

		for (const key of Object.keys(obj.files[fileKey]!)) {
			fileEntry.set(key, obj.files[fileKey]![key]);
		}
	}
}

export class ExcalidrawSync {
	private vault: Vault;
	private syncManager: SyncManager;
	private fileOpsManager: FileOpsManager;
	private subscribedPaths = new Set<string>();
	private observers = new Map<string, () => void>();
	private writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private recentDiskWrites = new Set<string>();
	private recentLocalEdits = new Set<string>();
	private lastWrittenContent = new Map<string, string>();

	constructor(
		vault: Vault,
		syncManager: SyncManager,
		fileOpsManager: FileOpsManager,
	) {
		this.vault = vault;
		this.syncManager = syncManager;
		this.fileOpsManager = fileOpsManager;
	}

	async subscribe(rawPath: string): Promise<void> {
		const path = toCanonicalPath(normalizePath(rawPath));
		if (this.subscribedPaths.has(path)) return;

		this.subscribedPaths.add(path);

		const docId = `${DRAWING_DOC_PREFIX}${path}`;

		const docHandle = this.syncManager.getDoc(docId);

		if (!docHandle) {
			this.subscribedPaths.delete(path);
			return;
		}

		try {
			await this.syncManager.waitForSync(docId);
		} catch {
			this.subscribedPaths.delete(path);
			return;
		}

		if (!this.subscribedPaths.has(path)) return;
		if (this.observers.has(path)) return;

		const root = docHandle.doc.getMap("drawing");

		const diskPath = toLocalPath(path);

		if (root.size == 0) {
			const file = getFileByPath(this.vault, diskPath);

			if (file) {
				const content = await this.vault.read(file);
				const data = parseDrawing(content);
				this.recentLocalEdits.add(path);
				docHandle.doc.transact(() => {
					applyToY(root, data);
				});

				this.recentLocalEdits.delete(path);
			}
		} else {
			const content = serializeDrawing(
				root.get("metadata") as Y.Map<unknown>,
				root.get("elements") as Y.Array<Y.Map<unknown>>,
				root.get("appstate") as Y.Map<unknown>,
				root.get("files") as Y.Map<Y.Map<unknown>>,
			);
			await this.writeToDisk(path, content);
		}

		const observer = () => {
			if (this.recentLocalEdits.has(path)) return;
			this.scheduleDiskWrite(path, root);
		};
		root.observeDeep(observer);
		this.observers.set(path, () => {
			root.unobserveDeep(observer);
		});
	}

	unsubscribe(rawPath: string): void {
		const path = toCanonicalPath(normalizePath(rawPath));
		this.subscribedPaths.delete(path);
		const timer = this.writeTimers.get(path);
		if (timer) {
			clearTimeout(timer);
			this.writeTimers.delete(path);
		}
		const unobserve = this.observers.get(path);
		if (unobserve) {
			unobserve();
			this.observers.delete(path);
		}
		this.syncManager.releaseDoc(`${DRAWING_DOC_PREFIX}${path}`);
	}

	async handleLocalModify(rawPath: string): Promise<void> {
		const path = toCanonicalPath(normalizePath(rawPath));
		if (this.recentDiskWrites.has(path)) return;
		if (!this.subscribedPaths.has(path)) return;

		const docId = `${DRAWING_DOC_PREFIX}${path}`;
		const docHandle = this.syncManager.getDoc(docId);
		if (!docHandle) return;

		const file = getFileByPath(this.vault, toLocalPath(path));
		if (!file) return;

		const content = await this.vault.read(file);
		const data = parseDrawing(content);

		const root = docHandle.doc.getMap<unknown>("drawing");

		this.recentLocalEdits.add(path);
		docHandle.doc.transact(() => {
			applyToY(root, data);
		});
		this.recentLocalEdits.delete(path);
	}

	isRecentDiskWrite(rawPath: string): boolean {
		return this.recentDiskWrites.has(
			toCanonicalPath(normalizePath(rawPath)),
		);
	}

	isSubscribed(rawPath: string): boolean {
		return this.subscribedPaths.has(
			toCanonicalPath(normalizePath(rawPath)),
		);
	}

	destroy(): void {
		for (const timer of this.writeTimers.values()) {
			clearTimeout(timer);
		}
		this.writeTimers.clear();
		for (const [, unobserve] of this.observers) {
			unobserve();
		}
		this.observers.clear();
		for (const path of [...this.subscribedPaths]) {
			this.syncManager.releaseDoc(`${DRAWING_DOC_PREFIX}${path}`);
		}
		this.subscribedPaths.clear();
		this.recentDiskWrites.clear();
		this.recentLocalEdits.clear();
		this.lastWrittenContent.clear();
	}

	private scheduleDiskWrite(path: string, root: Y.Map<unknown>): void {
		const existing = this.writeTimers.get(path);
		if (existing) clearTimeout(existing);
		this.writeTimers.set(
			path,
			setTimeout(() => {
				this.writeTimers.delete(path);
				const content = serializeDrawing(
					root.get("metadata") as Y.Map<unknown>,
					root.get("elements") as Y.Array<Y.Map<unknown>>,
					root.get("appstate") as Y.Map<unknown>,
					root.get("files") as Y.Map<Y.Map<unknown>>,
				);

				void this.writeToDisk(path, content);
			}, DEBOUNCE_MS),
		);
	}

	private async writeToDisk(path: string, content: string): Promise<void> {
		if (this.lastWrittenContent.get(path) === content) return;
		const diskPath = toLocalPath(path);
		this.recentDiskWrites.add(path);
		this.fileOpsManager.mutePathEvents(diskPath);
		try {
			const parentDir = diskPath.substring(0, diskPath.lastIndexOf("/"));
			if (parentDir) await ensureFolder(this.vault, parentDir);
			await this.vault.adapter.write(diskPath, content);
			this.lastWrittenContent.set(path, content);
		} catch {
			new Notice(`Live Share: failed to write canvas ${diskPath}`);
		} finally {
			setTimeout(() => {
				this.recentDiskWrites.delete(path);
				this.fileOpsManager.unmutePathEvents(diskPath);
			}, VAULT_EVENT_SETTLE_MS);
		}
	}
}
