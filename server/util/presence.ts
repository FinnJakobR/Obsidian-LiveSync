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
	const db = getDefaultPersistence();
	return (await db.getYDoc(roomId)) as Y.Doc;
}

export async function allreadySavedRooms() {
	const db = getDefaultPersistence();
	const allreadySaved = await db.getAllDocNames();
	console.log("allready", allreadySaved);
	return allreadySaved;
}
