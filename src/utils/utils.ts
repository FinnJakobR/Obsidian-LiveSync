import { App, Platform, TFile, TFolder, Vault } from "obsidian";
import { DEFAULT_SETTINGS, LiveShareSettings } from "types";

export const CHUNK_SIZE = 512 * 1024; //512 kb
export const VAULT_EVENT_SETTLE_MS = 250;
export const MAX_RECONNECT_ATTEMPTS = 1000000;
export const RECONNECT_BASE_MS = 100;
export const DEBOUNCE_MS = 250;
export const STALE_TRANSFER_MS = 5 * 60 * 1000;
export const CHECK_FOR_PING_DELAY = 500;

export const SYNC_STEP2 = 1;

export const SERVER_URL = "http://localhost:3000";

const WIN_CHAR_MAP: [string, string][] = [
	["?", "\uFF1F"],
	["*", "\u204E"],
	["<", "\uFF1C"],
	[">", "\uFF1E"],
	['"', "\uFF02"],
	["|", "\uFF5C"],
	[":", "\uFF1A"],
];

const ENCRYPTED_SETTINGS = ["encryptionPassphrase", "serverPassword"];

const ASCII_TO_FULLWIDTH = new Map(WIN_CHAR_MAP.map(([a, f]) => [a, f]));
const FULLWIDTH_TO_ASCII = new Map(WIN_CHAR_MAP.map(([a, f]) => [f, a]));

const FULLWIDTH_RE = new RegExp(
	`[${WIN_CHAR_MAP.map(([, f]) => f).join("")}]`,
	"g",
);
const ASCII_RE = new RegExp(
	`[${WIN_CHAR_MAP.map(([a]) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")}]`,
	"g",
);

export function toLocalPath(canonicalPath: string): string {
	if (!Platform.isWin) return canonicalPath;
	return canonicalPath.replace(
		ASCII_RE,
		(ch) => ASCII_TO_FULLWIDTH.get(ch) ?? ch,
	);
}

export function toCanonicalPath(localPath: string): string {
	if (!Platform.isWin) return localPath;
	return localPath.replace(
		FULLWIDTH_RE,
		(ch) => FULLWIDTH_TO_ASCII.get(ch) ?? ch,
	);
}

const TEXT_EXTENSIONS = new Set([
	"md",
	"txt",
	"json",
	"css",
	"js",
	"ts",
	"jsx",
	"tsx",
	"html",
	"xml",
	"yaml",
	"yml",
	"csv",
	"svg",
	"tex",
	"latex",
	"bib",
	"org",
	"rst",
	"adoc",
	"canvas",
	"mermaid",
	"graphql",
	"toml",
	"ini",
	"cfg",
	"conf",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"bat",
	"cmd",
	"py",
	"rb",
	"rs",
	"go",
	"java",
	"kt",
	"scala",
	"c",
	"cpp",
	"h",
	"hpp",
	"cs",
	"swift",
	"r",
	"lua",
	"sql",
	"scss",
	"sass",
	"less",
	"styl",
	"vue",
	"svelte",
]);

export function isTextFile(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return false;
	return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export function normalizeLineEndings(content: string): string {
	return content.replace(/\r\n|\r/g, "\n");
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

export async function ensureFolder(vault: Vault, path: string): Promise<void> {
	const existing = vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	const parts = path.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const folder = vault.getAbstractFileByPath(current);
		if (!folder) {
			try {
				await vault.createFolder(current);
			} catch {
				// Folder may already exist from a concurrent create
			}
		}
	}
}

export function toWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^http/, "ws");
}

export function getFileByPath(vault: Vault, path: string): TFile | null {
	const file = vault.getAbstractFileByPath(path);
	return file instanceof TFile ? file : null;
}

export function applyMinimalYTextUpdate(
	doc: { transact: (fn: () => void) => void },
	text: {
		toString: () => string;
		delete: (pos: number, len: number) => void;
		insert: (pos: number, s: string) => void;
		length: number;
	},
	newContent: string,
): void {
	const oldContent = text.toString();
	if (oldContent === newContent) return;

	let prefix = 0;
	const minLen = Math.min(oldContent.length, newContent.length);
	while (prefix < minLen && oldContent[prefix] === newContent[prefix])
		prefix++;

	let oldSuffix = oldContent.length;
	let newSuffix = newContent.length;
	while (
		oldSuffix > prefix &&
		newSuffix > prefix &&
		oldContent[oldSuffix - 1] === newContent[newSuffix - 1]
	) {
		oldSuffix--;
		newSuffix--;
	}

	doc.transact(() => {
		if (oldSuffix > prefix) text.delete(prefix, oldSuffix - prefix);
		if (newSuffix > prefix)
			text.insert(prefix, newContent.slice(prefix, newSuffix));
	});
}

export function getSetting(
	key: keyof LiveShareSettings,
	data: LiveShareSettings,
	app: App,
): string | boolean {
	if (!Object.keys(data).includes(key)) {
		console.error("Unknown Settings Key! ", key);
		return "";
	}

	if (!ENCRYPTED_SETTINGS.includes(key)) return data[key];

	const id = data[key];

	if (typeof id !== "string") {
		console.error("Unknown Settings Key! ", key);
		return "";
	}

	const secret = app.secretStorage.getSecret(id);

	if (secret) return secret;

	return DEFAULT_SETTINGS[key];
}
