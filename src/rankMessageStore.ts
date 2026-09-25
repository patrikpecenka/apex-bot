/**
 * Remembers which message is the live rank picker for each server, so reaction
 * handling survives a restart. Only the newest season stays active — creating a
 * new season overwrites the entry, which retires the previous embed.
 */

import { createJsonStore } from './jsonStore.ts';

export type RankMessage = {
  season: number;
  channelId: string;
  messageId: string;
  /** Emoji id -> role id. Keyed by id so renaming an emoji doesn't break it. */
  roles: Record<string, string>;
};

const store = createJsonStore<RankMessage>('rankMessages.json');

export async function getRankMessage(guildId: string): Promise<RankMessage | null> {
  return store.get(guildId);
}

export async function setRankMessage(guildId: string, entry: RankMessage): Promise<void> {
  await store.set(guildId, entry);
}

export async function clearRankMessage(guildId: string): Promise<void> {
  await store.remove(guildId);
}
