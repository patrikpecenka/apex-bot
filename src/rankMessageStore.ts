/**
 * Remembers which message is the live rank picker for each server, so reaction
 * handling survives a restart. Only the newest season stays active — creating a
 * new season overwrites the entry, which retires the previous embed.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RankMessage = {
  season: number;
  channelId: string;
  messageId: string;
  /** Emoji id -> role id. Keyed by id so renaming an emoji doesn't break it. */
  roles: Record<string, string>;
};

type StoreShape = Record<string, RankMessage>;

const storePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'rankMessages.json',
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

export async function getRankMessage(guildId: string): Promise<RankMessage | null> {
  return (await load())[guildId] ?? null;
}

export async function setRankMessage(guildId: string, entry: RankMessage): Promise<void> {
  const store = await load();
  store[guildId] = entry;
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2));
}

export async function clearRankMessage(guildId: string): Promise<void> {
  const store = await load();
  delete store[guildId];
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2));
}
