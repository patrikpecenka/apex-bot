/**
 * Remembers which message `/create <key>` last posted, per guild, so running it
 * again edits that message in place with the current JSON instead of posting a
 * duplicate.
 *
 * Runtime state, not content - lives in the gitignored `data/` dir next to the
 * other stores.
 */

import { createJsonStore } from './jsonStore.ts';

export type PostedMessage = {
  channelId: string;
  messageId: string;
  /** ISO timestamp of the last post/edit, for eyeballing the file. */
  updatedAt: string;
};

/** One entry per guild, holding that guild's messages keyed by message key. */
const store = createJsonStore<Record<string, PostedMessage>>('postedMessages.json');

export async function getPostedMessage(
  guildId: string,
  key: string,
): Promise<PostedMessage | null> {
  return (await store.get(guildId))?.[key] ?? null;
}

export async function setPostedMessage(
  guildId: string,
  key: string,
  entry: Omit<PostedMessage, 'updatedAt'>,
): Promise<void> {
  const guild = (await store.get(guildId)) ?? {};
  guild[key] = { ...entry, updatedAt: new Date().toISOString() };
  await store.set(guildId, guild);
}

export async function clearPostedMessage(guildId: string, key: string): Promise<void> {
  const guild = await store.get(guildId);
  if (!guild?.[key]) return;
  delete guild[key];
  await store.set(guildId, guild);
}
