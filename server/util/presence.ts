import * as Y from "yjs";
import { LeveldbPersistence } from "y-leveldb";

export let defaultPersistence: any = null;

export function getDefaultPersistence(): any {
	if (!defaultPersistence) {
		const persistence = new LeveldbPersistence("./data/db");
		defaultPersistence = persistence;
	}
	return defaultPersistence;
}

export async function getRoom(roomId: string): Promise<Y.Doc> {
	getDefaultPersistence();
	return (await defaultPersistence.getYDoc(roomId)) as unknown as Y.Doc;
}

export async function allreadySavedRooms() {
	const db = getDefaultPersistence();
	return await db.getAllDocNames();
}
