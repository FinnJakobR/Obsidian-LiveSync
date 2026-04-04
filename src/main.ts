import FileOpsManager from "managers/FileManager";
import type { EditorView } from "@codemirror/view";
import { MarkdownView, normalizePath, Notice, Plugin } from "obsidian";
import { BackgroundSync } from "sync/background-sync";
import { CanvasSync } from "sync/canvas-sync";
import { registerControlHandlers } from "sync/connection-handlers";
import { ConnectionStateManager } from "sync/connection-state";
import { ControlChannel } from "sync/control-ws";
import { E2ECrypto } from "sync/crypto";
import { ExcalidrawSync } from "sync/excalidraw-sync";
import { ManifestManager } from "sync/manifest";
import { SyncManager } from "sync/sync";
import { CONNECTION_STATES, DEFAULT_SETTINGS, LiveShareSettings } from "types";
import {
	CHECK_FOR_PING_DELAY,
	ensureFolder,
	getSetting,
	isTextFile,
	toCanonicalPath,
	toLocalPath,
	VAULT_EVENT_SETTLE_MS,
} from "utils/utils";
import { registerVaultEvents } from "utils/vault-events";
import { LiveSyncSettingTab } from "settings/settings";

function getCmView(view: MarkdownView): EditorView | undefined {
	return (view.editor as unknown as { cm?: EditorView }).cm;
}

export default class LiveSync extends Plugin {
	settings!: LiveShareSettings;
	syncManager!: SyncManager;
	fileOpsManager!: FileOpsManager;
	manifestManager!: ManifestManager;
	backgroundSync!: BackgroundSync;
	controlChannel: ControlChannel | null = null;
	canvasSync: CanvasSync | null = null;
	connectionState!: ConnectionStateManager;
	drawingSync: ExcalidrawSync | null = null;
	latencyBar: HTMLElement | null = null;
	currentConnectionState: CONNECTION_STATES = "disconnected";

	private requestBinaryFile = (path: string) => {
		this.controlChannel?.send({ type: "sync-request", path });
	};

	private mutePathEvents = (path: string) =>
		this.fileOpsManager.mutePathEvents(path);
	private unmutePathEvents = (path: string) =>
		this.fileOpsManager.unmutePathEvents(path);

	private registerManifestChangeHandler() {
		this.manifestManager.setManifestChangeHandler((added, removed) => {
			void (async () => {
				const renamedOldPaths = new Set<string>();
				const renamedNewPaths = new Set<string>();
				if (added.length > 0 && removed.length > 0) {
					for (const oldPath of removed) {
						for (const newPath of added) {
							if (renamedNewPaths.has(newPath)) continue;
							const localOld = toLocalPath(oldPath);
							const localNew = toLocalPath(newPath);
							const oldFile =
								this.app.vault.getAbstractFileByPath(localOld);
							const newFile =
								this.app.vault.getAbstractFileByPath(localNew);
							if (oldFile && !newFile) {
								renamedOldPaths.add(oldPath);
								renamedNewPaths.add(newPath);
								this.fileOpsManager.mutePathEvents(localOld);
								this.fileOpsManager.mutePathEvents(localNew);
								try {
									const parentDir = localNew.substring(
										0,
										localNew.lastIndexOf("/"),
									);
									if (parentDir)
										await ensureFolder(
											this.app.vault,
											parentDir,
										);
									await this.app.vault.rename(
										oldFile,
										localNew,
									);
								} finally {
									setTimeout(() => {
										this.fileOpsManager.unmutePathEvents(
											localOld,
										);
										this.fileOpsManager.unmutePathEvents(
											localNew,
										);
									}, VAULT_EVENT_SETTLE_MS);
								}
								if (isTextFile(oldPath)) {
									this.backgroundSync.onFileRemoved(oldPath);
								}
								if (isTextFile(newPath)) {
									await this.backgroundSync.onFileAdded(
										newPath,
									);
								}
								break;
							}
							if (!oldFile && newFile) {
								renamedOldPaths.add(oldPath);
								renamedNewPaths.add(newPath);
								if (isTextFile(oldPath)) {
									this.backgroundSync.onFileRemoved(oldPath);
								}
								if (isTextFile(newPath)) {
									await this.backgroundSync.onFileAdded(
										newPath,
									);
								}
								break;
							}
						}
					}
				}

				const actuallyAdded = added.filter(
					(path) => !renamedNewPaths.has(path),
				);
				const actuallyRemoved = removed.filter(
					(path) => !renamedOldPaths.has(path),
				);

				if (actuallyAdded.length > 0) {
					const syncedCount =
						await this.manifestManager.syncFromManifest(
							this.mutePathEvents,
							this.unmutePathEvents,
							this.requestBinaryFile,
							{ skipText: true },
						);
					if (syncedCount > 0)
						new Notice(`Live Share: synced ${syncedCount} file(s)`);
					for (const path of actuallyAdded) {
						if (isTextFile(path)) {
							await this.backgroundSync.onFileAdded(path);
						}
					}
				}
				for (const path of actuallyRemoved) {
					this.backgroundSync.onFileRemoved(path);
					const file = this.app.vault.getAbstractFileByPath(
						toLocalPath(path),
					);
					if (file) await this.app.fileManager.trashFile(file);
				}
				if (actuallyRemoved.length > 0)
					new Notice(
						`Live Share: removed ${actuallyRemoved.length} file(s)`,
					);
			})();
		});
	}

	async onload() {
		await this.loadSettings();
		this.latencyBar = this.addStatusBarItem();
		this.latencyBar.setText("DISCONNECT");

		this.updateLatency();

		this.registerInterval(
			window.setInterval(
				() => this.updateLatency(),
				CHECK_FOR_PING_DELAY,
			),
		);

		this.addSettingTab(new LiveSyncSettingTab(this.app, this));

		if (!this.settings.clientId) {
			this.settings.clientId = crypto.randomUUID();
			await this.saveData(this.settings);
		}

		this.syncManager = new SyncManager(this.settings, this.app);
		this.fileOpsManager = new FileOpsManager(
			this.app.vault,
			this.app.fileManager,
		);
		this.manifestManager = new ManifestManager(
			this.app.vault,
			this.settings,
		);

		this.backgroundSync = new BackgroundSync(
			this.app.vault,
			this.syncManager,
			this.manifestManager,
			this.fileOpsManager,
		);

		this.connectionState = new ConnectionStateManager();

		registerVaultEvents(this);

		this.app.workspace.onLayoutReady(async () => {
			await this.join();
			this.controlChannel?.sendPing();
		});
	}

	private async resume() {
		try {
			await this.connectSync();
		} catch {
			new Notice("Could not connect to server!");
		}
	}

	private async connectSync() {
		this.syncManager.connect();
		let e2e: E2ECrypto | undefined;
		const encryptionPassphrase = getSetting(
			"encryptionPassphrase",
			this.settings,
			this.app,
		);
		if (encryptionPassphrase) {
			e2e = new E2ECrypto(this.settings.encryptionPassphrase);
			await e2e.init();
		}

		this.syncManager.setE2E(e2e ?? null);
		this.controlChannel = new ControlChannel(this.settings, this.app, e2e);

		this.controlChannel.onError((context, err) => {
			new Notice(`Control-ws ${context} error`);
		});

		this.controlChannel.onStateChange((controlState) => {
			if (controlState == "connected") {
				this.connectionState.transition({ type: "connected" });
				this.fileOpsManager.setOnline(true);

				if (this.backgroundSync.isRunning()) {
					this.onActiveFileChange();
				}
			} else if (controlState === "reconnecting") {
				this.connectionState.transition({ type: "reconnecting" });
				this.fileOpsManager.setOnline(false);

				this.latencyBar!.setText("RECONNECTING");
			} else {
				this.fileOpsManager.setOnline(false);
				this.connectionState.transition({ type: "disconnect" });
				this.latencyBar!.setText("DISCONNECT");
			}
			this.currentConnectionState = controlState;

			this.updateLatency();
		});
		registerControlHandlers(this);
		this.controlChannel.connect();

		this.canvasSync = new CanvasSync(
			this.app.vault,
			this.syncManager,
			this.fileOpsManager,
		);

		this.drawingSync = new ExcalidrawSync(
			this.app.vault,
			this.syncManager,
			this.fileOpsManager,
		);

		const entries = this.manifestManager.getEntries();

		for (const [path] of entries) {
			if (isTextFile(path) && path.endsWith(".canvas")) {
				void this.canvasSync.subscribe(path);
			} else if (path.endsWith(".excalidraw")) {
				void this.drawingSync.subscribe(path);
			}
		}
	}

	private async cleanupStaleFiles() {
		const manifest = this.manifestManager.getEntries();

		//if (manifest.size === 0) return;

		const manifestPaths = new Set(manifest.keys());
		const localFiles = this.app.vault.getFiles();
		console.log(manifestPaths, localFiles);
		for (const file of localFiles) {
			if (!manifestPaths.has(toCanonicalPath(normalizePath(file.path)))) {
				this.fileOpsManager.mutePathEvents(file.path);
				try {
					await this.app.fileManager.trashFile(file);
				} finally {
					setTimeout(
						() => this.fileOpsManager.unmutePathEvents(file.path),
						VAULT_EVENT_SETTLE_MS,
					);
				}
			}
		}
	}

	onActiveFileChange() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const file = view.file;

		const cmView = getCmView(view);
		if (!cmView) return;

		const filePath = file?.path ?? null;

		const sharedPath =
			filePath && isTextFile(filePath)
				? toCanonicalPath(normalizePath(filePath))
				: null;

		this.backgroundSync.setActiveFile(sharedPath);
	}

	public async join() {
		await this.connectSync();
		const successfulConnected = await this.manifestManager.connect(
			this.syncManager,
		);

		console.log(this.manifestManager.getEntries());

		if (successfulConnected) await this.cleanupStaleFiles();

		const syncedCount = await this.manifestManager.syncFromManifest(
			this.mutePathEvents,
			this.unmutePathEvents,
			this.requestBinaryFile,
		);

		await this.backgroundSync.startAll();
		this.registerManifestChangeHandler();
		this.onActiveFileChange();
	}

	onunload() {
		//nichts zu tun hier!

		this.controlChannel?.destroy();
		this.controlChannel = null;

		this.canvasSync?.destroy();
		this.canvasSync = null;

		this.fileOpsManager.destroy();
		this.backgroundSync.destroy();
		this.manifestManager.destroy();
		this.syncManager.destroy();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		) as LiveShareSettings;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.syncManager.updateSettings(this.settings);
		this.manifestManager.updateSettings(this.settings);
	}

	private updateLatency() {
		let currentLatency = this.controlChannel?.getLatency() ?? 0;

		switch (this.currentConnectionState) {
			case "connected":
				this.latencyBar!.setText("Ping: " + currentLatency + " ms");
				break;

			default:
				this.latencyBar!.setText(
					this.currentConnectionState.toUpperCase(),
				);
				break;
		}
	}
}
