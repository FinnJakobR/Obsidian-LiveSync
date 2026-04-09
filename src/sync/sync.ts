import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { typeListForEach } from "yjs/dist/src/internals";
import { E2ECrypto } from "./crypto";
import {
	getSetting,
	MAX_RECONNECT_ATTEMPTS,
	RECONNECT_BASE_MS,
	SERVER_URL,
	SYNC_STEP2,
	toWsUrl,
} from "utils/utils";
import { LiveShareSettings } from "types";
import {
	decodeMuxMessage,
	encodeMuxMessage,
	MUX_DELETE,
	MUX_SUBSCRIBE,
	MUX_SUBSCRIBED,
	MUX_SYNC,
	MUX_SYNC_ENCRYPTED,
	MUX_SYNC_REQUEST,
	MUX_UNSUBSCRIBE,
} from "./mux-protocol";
import { App, normalizePath } from "obsidian";

export interface DocHandle {
	doc: Y.Doc;
	text: Y.Text;
}

type SyncListener = (synced: boolean) => void;

export class SyncManager {
	private docs = new Map<string, Y.Doc>();
	private synced = new Map<string, boolean>();
	private syncListeners = new Map<string, Set<SyncListener>>();
	private updateHandlers = new Map<
		string,
		(update: Uint8Array, origin: unknown) => void
	>();

	private isConnected = false;
	private ws: WebSocket | null = null;
	private shouldConnect = false;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private e2e: E2ECrypto | null = null;
	private sendQueue: Promise<void> = Promise.resolve();
	private isDestroyed = false;
	private settings: LiveShareSettings;
	private app: App;

	constructor(settings: LiveShareSettings, app: App) {
		this.settings = settings;
		this.app = app;
	}

	setE2E(e2e: E2ECrypto | null): void {
		this.e2e = e2e;
	}

	updateSettings(settings: LiveShareSettings) {
		this.settings = settings;
	}

	connect(): void {
		this.isConnected = true;
		this.shouldConnect = true;
		this.reconnectAttempts = 0;
		this.openWebsocket();
	}

	disconnect(): void {
		this.shouldConnect = false;
		this.isConnected = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		for (const path of [...this.docs.keys()]) {
			this.releaseDoc(path);
		}
	}

	destroy() {
		this.isDestroyed = true;
		this.disconnect();
	}

	getDoc(rawPath: string): DocHandle | null {
		if (!this.isConnected) return null;

		const filePath = normalizePath(rawPath);
		const existingDoc = this.docs.get(filePath);

		console.log("get Doc", rawPath);

		if (existingDoc) {
			return {
				doc: existingDoc,
				text: existingDoc.getText("content"),
			};
		}

		const doc = new Y.Doc();
		this.docs.set(filePath, doc);

		this.synced.set(filePath, false);

		const updateHandler = (update: Uint8Array, origin: unknown) => {
			if (origin == this) return;
			const syncEncoder = encoding.createEncoder();
			syncProtocol.writeUpdate(syncEncoder, update);

			this.sendMux(
				filePath,
				MUX_SYNC,
				encoding.toUint8Array(syncEncoder),
			);

			console.log(
				"UPDATE",
				update.length,
				doc.getText("content").toDelta(),
				origin,
			);
		};

		doc.on("update", updateHandler);
		this.updateHandlers.set(filePath, updateHandler);

		this.sendSubscribe(filePath);

		const text = doc.getText("content");
		return { doc, text };
	}

	releaseDoc(rawPath: string): void {
		const filePath = normalizePath(rawPath);
		this.sendUnsubscribe(filePath);

		const doc = this.docs.get(filePath);

		const updateHandler = this.updateHandlers.get(filePath);

		if (doc && updateHandler) {
			doc.off("update", updateHandler);
			doc.destroy();
		}

		this.docs.delete(filePath);
		this.updateHandlers.delete(filePath);
		this.synced.delete(filePath);
		this.syncListeners.delete(filePath);
	}

	waitForSync(rawPath: string, timeoutMs = 10_000): Promise<void> {
		const filePath = normalizePath(rawPath);
		if (this.synced.get(filePath)) return Promise.resolve();

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				listeners?.delete(listener);
				reject(new Error(`Sync timeout after ${timeoutMs}ms`));
			}, timeoutMs);

			let listeners = this.syncListeners.get(filePath);
			if (!listeners) {
				listeners = new Set();

				this.syncListeners.set(filePath, listeners);
			}

			const listener: SyncListener = (isSynced) => {
				if (!isSynced) return;
				listeners?.delete(listener);
				clearTimeout(timer);
				resolve();
			};
			listeners.add(listener);

			if (this.synced.get(filePath)) {
				listeners.delete(listener);
				clearTimeout(timer);
				resolve();
			}
		});
	}

	private openWebsocket() {
		if (this.isDestroyed) return;

		const serverUrl = getSetting(
			"serverUrl",
			this.settings,
			this.app,
		) as string;

		const token = getSetting("token", this.settings, this.app) as string;
		const jwt = getSetting("jwt", this.settings, this.app) as string;
		const clientId = getSetting(
			"clientId",
			this.settings,
			this.app,
		) as string;
		const serverPassword = getSetting(
			"serverPassword",
			this.settings,
			this.app,
		) as string;

		const roomId = getSetting("roomId", this.settings, this.app) as string;

		const wsUrl = toWsUrl(serverUrl);

		const params = new URLSearchParams({ token: token });
		if (jwt) params.set("jwt", jwt);
		if (serverPassword) params.set("password", serverPassword);
		if (clientId) params.set("userId", clientId);

		const url = `${wsUrl}/ws-mux/${roomId}?${params.toString()}`;
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		this.ws = ws;

		ws.onopen = () => {
			this.reconnectAttempts = 0;
			for (const filePath of this.docs.keys()) {
				this.synced.set(filePath, false);
				this.sendSubscribe(filePath);
			}
		};

		ws.onmessage = (event) => {
			const data = new Uint8Array(event.data as ArrayBuffer);
			this.handleMessage(data);
		};

		ws.onclose = () => {
			this.ws = null;
			for (const filePath of this.docs.keys()) {
				this.setSynced(filePath, false);
			}

			if (this.shouldConnect) {
				this.scheudleReconnect();
			}
		};

		ws.onerror = () => {
			ws.close();
		};
	}

	private scheudleReconnect() {
		if (this.isDestroyed) return;
		if (this.reconnectTimer) return;

		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			console.log("HÄ");
			this.shouldConnect = false;
			return;
		}

		const delay = Math.min(
			RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
			RECONNECT_BASE_MS,
		);
		this.reconnectAttempts++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.shouldConnect) {
				console.log("try to Open MUX Websocket!");
				this.openWebsocket();
			}
		}, delay);
	}

	private handleMessage(data: Uint8Array): void {
		const { docId, msgType, payload } = decodeMuxMessage(data);

		console.log("GOT MESSAGE!");

		switch (msgType) {
			case MUX_SUBSCRIBED:
				this.handleSubscribed(docId, payload);
				break;

			case MUX_SYNC:
				this.handleSync(docId, payload);
				break;

			case MUX_SYNC_REQUEST:
				this.handleSyncRequest(docId);
				break;

			case MUX_SYNC_ENCRYPTED:
				void this.handleSyncEncrypted(docId, payload);
				break;
		}
	}

	private handleSubscribed(docId: string, payload: Uint8Array): void {
		const doc = this.docs.get(docId);
		if (!doc) return;

		const syncEncoder = encoding.createEncoder();
		syncProtocol.writeSyncStep1(syncEncoder, doc);

		console.log("SUBSCRIBE", docId);

		this.sendMux(docId, MUX_SYNC, encoding.toUint8Array(syncEncoder));

		let peerCount = 0;
		if (payload.length > 0) {
			const decoder = decoding.createDecoder(payload);
			peerCount = decoding.readVarUint(decoder);
		}
	}

	private handleSyncRequest(docId: string): void {
		const doc = this.docs.get(docId);
		if (!doc) return;

		const syncEncoder = encoding.createEncoder();
		syncProtocol.writeSyncStep1(syncEncoder, doc);

		this.sendMux(docId, MUX_SYNC, encoding.toUint8Array(syncEncoder));
	}

	private handleSync(docId: string, payload: Uint8Array): void {
		const doc = this.docs.get(docId);
		console.log("DOC before", doc?.toJSON(), docId);
		if (!doc) return;

		const decoder = decoding.createDecoder(payload);
		const syncEncoder = encoding.createEncoder();
		const msgType = decoding.peekVarUint(decoder);

		syncProtocol.readSyncMessage(decoder, syncEncoder, doc, this);

		if (encoding.length(syncEncoder) > 0) {
			this.sendMux(docId, MUX_SYNC, encoding.toUint8Array(syncEncoder));
		}

		if (msgType === SYNC_STEP2) {
			this.setSynced(docId, true);
		}
	}

	private async handleSyncEncrypted(
		docId: string,
		payload: Uint8Array,
	): Promise<void> {
		if (!this.e2e?.enabled || payload.length <= 1) {
			this.handleSync(docId, payload);
			return;
		}
		try {
			const syncType = payload[0]!;
			const decrypted = await this.e2e.decrypt(payload.slice(1));
			const result = new Uint8Array(1 + decrypted.length);
			result[0] = syncType;
			result.set(decrypted, 1);
			this.handleSync(docId, result);
		} catch {
			// Decryption failure — drop silently to preserve E2E guarantee
		}
	}

	private setSynced(docId: string, value: boolean): void {
		const prev = this.synced.get(docId);
		this.synced.set(docId, value);

		if (value && !prev) {
			const listeners = this.syncListeners.get(docId);
			if (listeners) {
				for (const listener of Array.from(listeners)) {
					listener(true);
				}
			}
		}
	}

	private sendMux(
		docId: string,
		msgType: number,
		payload?: Uint8Array,
	): void {
		if (!this.e2e?.enabled || !payload || payload.length === 0) {
			if (this.ws?.readyState === WebSocket.OPEN) {
				console.log("SEND_MUX");
				this.ws.send(encodeMuxMessage(docId, msgType, payload));
			}
			return;
		}

		if (msgType === MUX_SYNC) {
			this.sendQueue = this.sendQueue.then(() =>
				this.sendEncryptedSync(docId, payload),
			);
		} else {
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.ws.send(encodeMuxMessage(docId, msgType, payload));
			}
		}
	}

	private async sendEncryptedSync(
		docId: string,
		payload: Uint8Array,
	): Promise<void> {
		if (!this.e2e || this.ws?.readyState !== WebSocket.OPEN) return;
		try {
			const syncType = payload[0]!;
			const rest =
				payload.length > 1 ? payload.slice(1) : new Uint8Array(0);
			const encrypted =
				rest.length > 0 ? await this.e2e.encrypt(rest) : rest;
			const result = new Uint8Array(1 + encrypted.length);
			result[0] = syncType;
			result.set(encrypted, 1);
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.ws.send(
					encodeMuxMessage(docId, MUX_SYNC_ENCRYPTED, result),
				);
			}
		} catch {
			// Do not fall back to unencrypted — drop the message to preserve E2E guarantee
		}
	}

	private sendSubscribe(filePath: string): void {
		this.sendMux(filePath, MUX_SUBSCRIBE);
	}

	private sendUnsubscribe(filePath: string): void {
		this.sendMux(filePath, MUX_UNSUBSCRIBE);
	}

	sendDelete(filePath: string): void {
		this.sendMux(filePath, MUX_DELETE);
	}
}
