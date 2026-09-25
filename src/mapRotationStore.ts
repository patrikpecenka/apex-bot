/**
 * Remembers the live map rotation message per guild, so the refresh loop and
 * /maprotation survive a restart. One live message per guild at a time.
 */

import { createJsonStore } from './jsonStore.ts';

export type MapRotationMessage = { channelId: string; messageId: string };

const store = createJsonStore<MapRotationMessage>('mapRotationMessages.json');

export async function getMapRotationMessage(guildId: string): Promise<MapRotationMessage | null> {
  return store.get(guildId);
}

export async function setMapRotationMessage(guildId: string, entry: MapRotationMessage): Promise<void> {
  await store.set(guildId, entry);
}

export async function clearMapRotationMessage(guildId: string): Promise<void> {
  await store.remove(guildId);
}

/** Every guild's live map rotation message, for the refresh loop to iterate. */
export async function allMapRotationMessages(): Promise<Record<string, MapRotationMessage>> {
  return store.all();
}
