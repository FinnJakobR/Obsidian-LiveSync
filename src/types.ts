export interface FileCreateOp {
	type: "create";
	path: string;
	content: string;
	binary?: boolean;
}

export interface FileModifyOp {
	type: "modify";
	path: string;
	content: string;
	binary?: boolean;
}

export interface FileRenameOp {
	type: "rename";
	oldPath: string;
	newPath: string;
}

export interface FileDeleteOp {
	type: "delete";
	path: string;
}

export interface FileChunkStartOp {
	type: "chunk-start";
	path: string;
	totalSize: number;
	binary?: boolean;
	transferId?: string;
}

export interface FileChunkDataOp {
	type: "chunk-data";
	path: string;
	index: number;
	data: string;
	transferId?: string;
}

export interface FileChunkEndOp {
	type: "chunk-end";
	path: string;
	transferId?: string;
}

export interface FileChunkResumeOp {
	type: "chunk-resume";
	path: string;
	transferId: string;
	receivedSeqs: number[];
}

export interface FolderCreateOp {
	type: "folder-create";
	path: string;
}

export interface FileOpMessage {
	type: "file-op";
	op: FileOp;
}

export type FileOp =
	| FileCreateOp
	| FileChunkDataOp
	| FileChunkResumeOp
	| FileChunkStartOp
	| FileDeleteOp
	| FileModifyOp
	| FileRenameOp
	| FolderCreateOp
	| FileChunkEndOp;

export interface LiveShareSettings {
	serverUrl: string;
	token: string;
	roomId: string;
	jwt: string;
	encryptionPassphrase: string;
	serverPassword: string;
	clientId: string;
	notificationsEnabled: boolean;
	debugLogging: boolean;
	debugLogPath: string;
	autoReconnect: boolean;
	approvalTimeoutSeconds: number;
}

export const DEFAULT_SETTINGS: LiveShareSettings = {
	serverUrl: "http://localhost:3000",
	token: "",
	jwt: "",
	encryptionPassphrase: "",
	serverPassword: "",
	clientId: "",
	roomId: "d9e835e8-4c15-4375-9605-cac6481818f6",
	notificationsEnabled: true,
	debugLogging: false,
	debugLogPath: "live-share-debug.md",
	autoReconnect: true,
	approvalTimeoutSeconds: 60,
};

export interface ChunkStartMessage {
	type: "file-chunk-start";
	path: string;
	totalSize: number;
	binary?: boolean;
	transferId?: string;
}

export interface ChunkDataMessage {
	type: "file-chunk-data";
	path: string;
	index: number;
	data: string;
	transferId?: string;
}

export interface ChunkEndMessage {
	type: "file-chunk-end";
	path: string;
	transferId?: string;
}

export interface ChunkResumeMessage {
	type: "file-chunk-resume";
	path: string;
	transferId: string;
	receivedSeqs: number[];
}

export interface SyncRequestMessage {
	type: "sync-request";
	path?: string;
}

export interface PingMessage {
	type: "ping";
	timestamp: number;
}

export interface PongMessage {
	type: "pong";
	timestamp?: number;
}

export type ControlMessage =
	| FileOpMessage
	| ChunkStartMessage
	| ChunkDataMessage
	| ChunkEndMessage
	| ChunkResumeMessage
	| SyncRequestMessage
	| PingMessage
	| PongMessage;

export type ControlMessageType = ControlMessage["type"];

export interface ControlMessageMap {
	"file-op": FileOpMessage;
	"file-chunk-start": ChunkStartMessage;
	"file-chunk-data": ChunkDataMessage;
	"file-chunk-end": ChunkEndMessage;
	"file-chunk-resume": ChunkResumeMessage;
	"sync-request": SyncRequestMessage;
	ping: PingMessage;
	pong: PongMessage;
}
