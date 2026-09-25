/**
 * "Join to create" squad rooms, public and private.
 *
 * Joining a hub voice channel gets you your own room in the same category,
 * capped at a full squad, which disappears the moment the last person leaves.
 * A private hub (VOICE_HUB_PRIVATE_IDS) makes that room locked from the start;
 * `/room lock` locks one after the fact.
 *
 * Discord has no password on a voice channel, so "locked" here means Connect
 * is denied to @everyone and the bot hands out per-user access: `/room invite`
 * grants it directly, `/join code:...` grants it to whoever has the code. The
 * code is only a way of asking the bot for that overwrite - it is never what
 * actually keeps people out. The permission is.
 *
 * Rooms are tracked in `data/tempVoiceRooms.json` so a restart - or a crash
 * mid-session - can't leave orphans behind: `sweepTempRooms` cleans up on boot.
 */

import {
  ChannelType,
  Events,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import { createJsonStore } from './jsonStore.ts';
import { privateVoiceHubIds, voiceHubIds } from './config.ts';

export type TempRoom = {
  guildId: string;
  ownerId: string;
  createdAt: number;
  /** Locked rooms deny Connect to @everyone; access is handed out per person. */
  locked: boolean;
  /** Only set while locked. Uppercase, no ambiguous characters. */
  code?: string;
  /**
   * Messages the bot sent that only make sense while the room exists - the DM
   * with the code, the invite DMs. They go when the room does, so nobody is
   * left holding a link to a channel that isn't there any more.
   */
  messages?: { channelId: string; messageId: string }[];
};

/** Keyed by channel id. */
const store = createJsonStore<TempRoom>('tempVoiceRooms.json');

/** A full Apex squad. */
const roomUserLimit = 3;

/** Stops one person cycling the hub from burning through the create rate limit. */
const createCooldownMs = 30_000;
const lastCreate = new Map<string, number>();

/** Sanity cap, so a bad afternoon can't fill the category with dead rooms. */
const maxRoomsPerGuild = 15;

const requiredPermissions = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers];

/** Guilds already told off about missing permissions - warn once, not per join. */
const warned = new Set<string>();

const lockPrefix = '🔒 ';

/** No I/O/0/1 - these get read out loud and typed by hand. */
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const codeLength = 5;

/** Uppercases and drops spaces/dashes, so "7k2 mb" still matches "7K2MB". */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function generateCode(guildId: string): Promise<string> {
  const taken = new Set(
    Object.values(await store.all())
      .filter((room) => room.guildId === guildId && room.code)
      .map((room) => room.code),
  );

  // Collisions are vanishingly unlikely at 32^5, but a duplicate code would
  // silently put someone in the wrong room, so check anyway.
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let index = 0; index < codeLength; index++) {
      code += codeAlphabet[Math.floor(Math.random() * codeAlphabet.length)];
    }
    if (!taken.has(code)) return code;
  }
  throw new Error('Nepodařilo se vygenerovat volný kód roomky.');
}

function roomName(displayName: string, locked: boolean): string {
  return `${locked ? lockPrefix : ''}Squad — ${displayName}`.slice(0, 100);
}

async function createRoom(state: VoiceState, locked: boolean): Promise<void> {
  const { guild, member, channel: hub } = state;
  if (!member || !hub) return;

  const me = guild.members.me;
  if (!me?.permissions.has(requiredPermissions)) {
    if (!warned.has(guild.id)) {
      warned.add(guild.id);
      console.warn(
        `Temp voice rooms are off in ${guild.name} (${guild.id}): I need Manage Channels and Move Members.`,
      );
    }
    return;
  }

  const now = Date.now();
  const previous = lastCreate.get(member.id) ?? 0;
  if (now - previous < createCooldownMs) return;

  const rooms = Object.values(await store.all()).filter((room) => room.guildId === guild.id);
  if (rooms.length >= maxRoomsPerGuild) {
    console.warn(`Not creating a squad room in ${guild.id}: ${rooms.length} are already open.`);
    return;
  }

  lastCreate.set(member.id, now);

  const code = locked ? await generateCode(guild.id) : undefined;

  const room = await guild.channels.create({
    name: roomName(member.displayName, locked),
    type: ChannelType.GuildVoice,
    // Same category as the hub, so it inherits the category's permissions and
    // lands where people are already looking.
    parent: hub.parent,
    userLimit: roomUserLimit,
    reason: `Squad room for ${member.user.tag}`,
    permissionOverwrites: [
      // Only over their own room: rename it, set a limit, drag people in.
      { id: member.id, allow: [...requiredPermissions, PermissionFlagsBits.Connect] },
      // Moving someone into a channel needs Connect *there* as well as Move
      // Members, and a locked room denies Connect by default - including to me.
      { id: me.id, allow: [...requiredPermissions, PermissionFlagsBits.Connect] },
      ...(locked
        ? [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] }]
        : []),
    ],
  });

  try {
    await member.voice.setChannel(room);
  } catch (error) {
    // They hung up between joining the hub and the room existing. Nobody is
    // coming, so take it straight back down.
    await room.delete('Squad room owner left before being moved').catch(() => {});
    console.warn(`Couldn't move ${member.user.tag} into their squad room:`, error);
    return;
  }

  await store.set(room.id, { guildId: guild.id, ownerId: member.id, createdAt: now, locked, code });

  if (locked && code) {
    // The code is only useful to the owner, and only in private.
    const dm = await member
      .send(
        `Tvoje privátní squad roomka je připravená: ${room.url}\n` +
          `Kód roomky: **${code}** — kdo napíše \`/join code:${code}\`, dostane se dovnitř.\n` +
          'Lidi můžeš přidávat i přímo přes `/room invite`.',
      )
      .catch(() => null);
    if (dm) await trackRoomMessage(room.id, dm);
  }
}

/**
 * Remembers a message so it can be cleaned up with the room. Used for the DMs
 * that carry the room link - once the room is gone they are dead links, and a
 * private code sitting in someone's DMs outlives the thing it opened.
 */
export async function trackRoomMessage(roomChannelId: string, message: Message): Promise<void> {
  const room = await store.get(roomChannelId);
  // The room emptied out before the DM landed - the link is already dead, so
  // clean it up instead of leaving it in someone's inbox.
  if (!room) {
    await message.delete().catch(() => {});
    return;
  }

  await store.set(roomChannelId, {
    ...room,
    messages: [...(room.messages ?? []), { channelId: message.channelId, messageId: message.id }],
  });
}

/** Deletes everything the room left behind in DMs and channels. */
async function deleteRoomMessages(client: Client, room: TempRoom): Promise<void> {
  for (const reference of room.messages ?? []) {
    const channel = await client.channels.fetch(reference.channelId).catch(() => null);
    const message = channel?.isTextBased()
      ? await channel.messages.fetch(reference.messageId).catch(() => null)
      : null;
    // Already deleted by hand, or the DM channel is gone - either way it is no
    // longer our problem.
    await message?.delete().catch(() => {});
  }
}

async function removeIfEmpty(state: VoiceState): Promise<void> {
  const channelId = state.channelId;
  if (!channelId) return;

  const tracked = await store.get(channelId);
  if (!tracked) return;

  const channel = state.channel ?? (await state.guild.channels.fetch(channelId).catch(() => null));
  if (!channel) {
    await deleteRoomMessages(state.client, tracked);
    await store.remove(channelId);
    return;
  }

  if (channel.type === ChannelType.GuildVoice && channel.members.size === 0) {
    await channel.delete('Squad room empty').catch(() => {});
    await deleteRoomMessages(state.client, tracked);
    await store.remove(channelId);
  }
}

/* ------------------------------------------------------------------ *
 * Room management, used by /room and /join
 * ------------------------------------------------------------------ */

export async function getRoom(channelId: string): Promise<TempRoom | null> {
  return store.get(channelId);
}

/** The tracked room the member is sitting in right now, if any. */
export async function currentRoom(
  member: GuildMember,
): Promise<{ channel: VoiceBasedChannel; room: TempRoom } | null> {
  const channel = member.voice.channel;
  if (!channel) return null;
  const room = await store.get(channel.id);
  return room ? { channel, room } : null;
}

export async function findRoomByCode(
  guild: Guild,
  code: string,
): Promise<{ channelId: string; room: TempRoom } | null> {
  const wanted = normalizeCode(code);
  for (const [channelId, room] of Object.entries(await store.all())) {
    if (room.guildId === guild.id && room.code === wanted) return { channelId, room };
  }
  return null;
}

/**
 * Renames the room to match its state. Channel renames are limited to two per
 * ten minutes, so a failure here is ignored - the lock itself is the part that
 * matters, the emoji is a hint.
 */
async function markName(channel: VoiceBasedChannel, locked: boolean): Promise<void> {
  const bare = channel.name.startsWith(lockPrefix)
    ? channel.name.slice(lockPrefix.length)
    : channel.name;
  const wanted = `${locked ? lockPrefix : ''}${bare}`;
  if (wanted === channel.name) return;
  await channel.setName(wanted).catch(() => {});
}

export async function lockRoom(channel: VoiceBasedChannel, room: TempRoom): Promise<string> {
  const code = room.code ?? (await generateCode(room.guildId));
  // Re-read: a DM tracked since the caller fetched its copy would otherwise be
  // spread away by this write.
  const current = (await store.get(channel.id)) ?? room;

  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { Connect: false });

  // Whoever is already in keeps their seat: without an explicit allow they'd
  // be locked out the moment they reconnected.
  for (const member of channel.members.values()) {
    await channel.permissionOverwrites.edit(member.id, { Connect: true }).catch(() => {});
  }

  await store.set(channel.id, { ...current, locked: true, code });
  await markName(channel, true);
  return code;
}

export async function unlockRoom(channel: VoiceBasedChannel, room: TempRoom): Promise<void> {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { Connect: null });
  const current = (await store.get(channel.id)) ?? room;
  await store.set(channel.id, { ...current, locked: false, code: undefined });
  await markName(channel, false);
}

/** New code for the same room. The people already let in keep their access. */
export async function regenerateCode(channel: VoiceBasedChannel, room: TempRoom): Promise<string> {
  const code = await generateCode(room.guildId);
  const current = (await store.get(channel.id)) ?? room;
  await store.set(channel.id, { ...current, code });
  return code;
}

export async function grantAccess(channel: VoiceBasedChannel, userId: string): Promise<void> {
  await channel.permissionOverwrites.edit(userId, { Connect: true });
}

export async function revokeAccess(channel: VoiceBasedChannel, member: GuildMember): Promise<void> {
  await channel.permissionOverwrites.delete(member.id).catch(() => {});
  // Taking the permission away doesn't remove someone who is already inside.
  if (member.voice.channelId === channel.id) {
    await member.voice.disconnect('Removed from a private squad room').catch(() => {});
  }
}

/* ------------------------------------------------------------------ */

/**
 * Deletes rooms left behind by a restart or a crash. Rooms that still have
 * someone in them are left alone - they get cleaned up when that person
 * leaves, like any other room.
 */
export async function sweepTempRooms(client: Client): Promise<void> {
  for (const [channelId, room] of Object.entries(await store.all())) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        await deleteRoomMessages(client, room);
        await store.remove(channelId);
        continue;
      }

      if (channel.type === ChannelType.GuildVoice && channel.members.size === 0) {
        await channel.delete('Squad room empty (startup sweep)').catch(() => {});
        await deleteRoomMessages(client, room);
        await store.remove(channelId);
      }
    } catch (error) {
      console.error(`Sweeping squad room ${channelId} in ${room.guildId} failed:`, error);
    }
  }
}

export function registerTempVoice(client: Client): void {
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    void (async () => {
      try {
        if (newState.channelId) {
          if (privateVoiceHubIds.includes(newState.channelId)) {
            await createRoom(newState, true);
          } else if (voiceHubIds.includes(newState.channelId)) {
            await createRoom(newState, false);
          }
        }
        // Also covers moving straight from one room to another.
        if (oldState.channelId && oldState.channelId !== newState.channelId) {
          await removeIfEmpty(oldState);
        }
      } catch (error) {
        console.error('Temp voice handling failed:', error);
      }
    })();
  });
}
