import LiveSync from "main";
import { Notice, TAbstractFile, TFile } from "obsidian";
import { isTextFile } from "./utils";

export function registerVaultEvents(plugin: LiveSync): void {
	let pendingRename: Promise<void> | null = null;
	const renamePaths = new Set<string>();

	plugin.registerEvent(
		plugin.app.workspace.on("active-leaf-change", () => {
			const run = () => {
				//plugin.onActiveFileChange();
			};

			if (pendingRename) {
				void pendingRename.then(run);
			} else {
				run();
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("create", (file: TAbstractFile) => {
			const originalPath = file.path;

			console.log("CREATE!", file);

			//trigger das nur wenn es nicht von dir kam!
			if (plugin.fileOpsManager.isPathMuted(originalPath)) return;

			void plugin.fileOpsManager.onFileCreate(file);

			if (file instanceof TFile) {
				void (async () => {
					try {
						const content = isTextFile(originalPath)
							? await plugin.app.vault.read(file)
							: await plugin.app.vault.readBinary(file);
						if (renamePaths.has(originalPath)) return;
						if (isTextFile(originalPath)) {
							await plugin.backgroundSync.onFileAdded(
								originalPath,
							);
						}
						if (renamePaths.has(originalPath)) return;
						await plugin.manifestManager.updateFile(file, content);
					} catch {
						if (!renamePaths.has(originalPath)) {
							new Notice(
								`Live Share: failed to update manifest for ${originalPath}`,
							);
						}
					}
				})();
			} else {
				plugin.manifestManager.addFolder(originalPath);
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("delete", (file: TAbstractFile) => {
			console.error("DELETE!");
			const run = () => {
				if (plugin.fileOpsManager.isPathMuted(file.path)) return;
				plugin.fileOpsManager.onFileDelete(file);
				plugin.backgroundSync.onFileRemoved(file.path);
				plugin.manifestManager.removeFile(file.path);
			};
			if (pendingRename) {
				void pendingRename.then(run);
			} else {
				run();
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on(
			"rename",
			(file: TAbstractFile, oldPath: string) => {
				console.log("RENAME");

				if (
					plugin.fileOpsManager.isPathMuted(file.path) ||
					plugin.fileOpsManager.isPathMuted(oldPath)
				)
					return;
				renamePaths.add(oldPath);

				const prev = pendingRename ?? Promise.resolve();
				const task = prev.then(async () => {
					await plugin.fileOpsManager.onFileRename(file, oldPath);
					plugin.backgroundSync.cancelSubscribe(oldPath);
					await plugin.backgroundSync.onFileRenamed(
						oldPath,
						file.path,
					);
					plugin.manifestManager.renameFile(
						oldPath,
						file.path,
						plugin.syncManager,
					);
					//const activeFile = plugin.app.workspace.getActiveFile()!;
					// if (
					// 	activeFile &&
					// 	(activeFile.path === file.path ||
					// 		activeFile.path === oldPath)
					// ) {
					// 	console.error("Active File", activeFile);
					// 	plugin.onActiveFileChange();
					// }
				});

				pendingRename = task.finally(() => {
					if (pendingRename === task) pendingRename = null;
					renamePaths.delete(oldPath);
				});
			},
		),
	);

	plugin.registerEvent(
		plugin.app.vault.on("modify", (file: TAbstractFile) => {
			console.log("MODIFY");
			if (!(file instanceof TFile)) return;

			if (plugin.fileOpsManager.isPathMuted(file.path)) return;

			if (isTextFile(file.path)) {
				if (plugin.backgroundSync.isRecentDiskWrite(file.path)) return;
				if (
					file.path.endsWith(".canvas") &&
					plugin.canvasSync?.isSubscribed(file.path) &&
					!plugin.canvasSync.isRecentDiskWrite(file.path)
				) {
					void plugin.canvasSync.handleLocalModify(file.path);
					return;
				}

				if (
					file.path.endsWith(".excalidraw") &&
					plugin.drawingSync?.isSubscribed(file.path) &&
					!plugin.drawingSync.isRecentDiskWrite(file.path)
				) {
					void plugin.drawingSync.handleLocalModify(file.path);
					return;
				}
				void plugin.backgroundSync.handleLocalTextModify(file.path);
			}

			void plugin.fileOpsManager.onFileModify(file);
			void (async () => {
				try {
					const buf = await plugin.app.vault.readBinary(file);
					await plugin.manifestManager.updateFile(file, buf);
				} catch {
					new Notice(
						`Live Share: failed to update manifest for ${file.path}`,
					);
				}
			})();
		}),
	);
}
