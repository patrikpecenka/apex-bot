/**
 * Remembers the live map rotation message per guild, so the refresh loop and
 * /maprotation survive a restart. One live message per guild at a time.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type MapRotationMessage = { channelId: string; messageId: string };

type StoreShape = Record<string, MapRotationMessage>;

const storePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'mapRotationMessages.json',
);

let cache: StoreShape | null = null;

async function load(): Promise<StoreShape> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(storePath, 'utf8')) as StoreShape;
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(store: StoreShape): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2));
}

export async function getMapRotationMessage(guildId: string): Promise<MapRotationMessage | null> {
  return (await load())[guildId] ?? null;
}

export async function setMapRotationMessage(guildId: string, entry: MapRotationMessage): Promise<void> {
  const store = await load();
  store[guildId] = entry;
  await persist(store);
}

export async function clearMapRotationMessage(guildId: string): Promise<void> {
  const store = await load();
  delete store[guildId];
  await persist(store);
}

/** Every guild's live map rotation message, for the refresh loop to iterate. */
export async function allMapRotationMessages(): Promise<StoreShape> {
  return { ...(await load()) };
}
