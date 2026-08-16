/**
 * Remembers which message `/create <key>` last posted, per guild, so running it
 * again edits that message in place with the current JSON instead of posting a
 * duplicate.
 *
 * Runtime state, not content - lives in the gitignored `data/` dir next to the
 * other stores.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PostedMessage = {
  channelId: string;
  messageId: string;
  /** ISO timestamp of the last post/edit, for eyeballing the file. */
  updatedAt: string;
};

/** guild id -> message key -> where it went. */
type StoreShape = Record<string, Record<string, PostedMessage>>;

const storePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'postedMessages.json',
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

async function save(store: StoreShape): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2));
}

export async function getPostedMessage(
  guildId: string,
  key: string,
): Promise<PostedMessage | null> {
  return (await load())[guildId]?.[key] ?? null;
}

export async function setPostedMessage(
  guildId: string,
  key: string,
  entry: Omit<PostedMessage, 'updatedAt'>,
): Promise<void> {
  const store = await load();
  store[guildId] ??= {};
  store[guildId][key] = { ...entry, updatedAt: new Date().toISOString() };
  await save(store);
}

export async function clearPostedMessage(guildId: string, key: string): Promise<void> {
  const store = await load();
  delete store[guildId]?.[key];
  await save(store);
}
