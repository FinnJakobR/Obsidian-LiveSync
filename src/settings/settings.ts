import LiveSync from "main";

import { App, PluginSettingTab, Setting, SecretComponent } from "obsidian";

export class LiveSyncSettingTab extends PluginSettingTab {
	plugin: LiveSync;

	constructor(app: App, plugin: LiveSync) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		let { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl).setName("Room").addText((text) =>
			text
				.setPlaceholder("cfaed3d3-09b1-4b97-b0dc-2f704101bc96")
				.setValue(this.plugin.settings.roomId)
				.onChange(async (value) => {
					this.plugin.settings.roomId = value;
					await this.plugin.saveSettings();
				}),
		);

		new Setting(containerEl).setName("Server").addText((t) =>
			t
				.setPlaceholder("http://localhost:3000")
				.setValue(this.plugin.settings.serverUrl)
				.onChange(async (value) => {
					this.plugin.settings.serverUrl = value;
					await this.plugin.saveSettings();
				}),
		);

		new Setting(containerEl)
			.setName("Password")
			.setDesc("Server Password")
			.addComponent((el) =>
				new SecretComponent(this.app, el)
					.setValue(this.plugin.settings.serverPassword)
					.onChange(async (value) => {
						this.plugin.settings.serverPassword = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Encryption-token")
			.setDesc("Encryption key used for end-to-end encryption")
			.addComponent((el) =>
				new SecretComponent(this.app, el)
					.setValue(this.plugin.settings.encryptionPassphrase)
					.onChange(async (value) => {
						this.plugin.settings.encryptionPassphrase = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Please reload this plugin to apply all changes!")
			.setHeading();
	}
}
