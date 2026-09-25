/**
 * Which Discord servers the bot is in, and their text channels - written into
 * the website's database so organizers can pick where a tournament is
 * announced. The website only reads these tables; the bot is the one that
 * knows Discord. Every server the bot is on is also a community, named after
 * the server; being kicked hides it, being added back shows it again.
 *
 *   - a server the bot joins while running is "unclaimed" until the organizer
 *     who added it comes back to the website (the install callback sets
 *     claimed_by and "active"); nobody within ten minutes and the bot leaves
 *     again - only organizers add the bot, for now (only with HOME_GUILD_ID set)
 *   - servers the bot was already on when it started are kept as they are:
 *     "active", for admins, and an organizer can claim one through the website
 *   - channels, whether the bot can post in them and its server permissions
 *     follow Discord's events, a "Načíst znovu" request from the website, and
 *     a full pass every ten minutes for anything an event missed
 *
 * Everything here swallows its own errors: a server whose sync fails is one
 * stale list, not a reason for the bot to go down.
 */

import { ChannelType, Events, PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import { homeGuildId, isHomeGuild } from './config.ts';
import { sql } from './db.ts';
import { registerTask } from './liveMessages.ts';

const claimWindowMinutes = 10;
const postingPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/**
 * `joined`: the bot has just been added (GuildCreate) - unclaimed until an
 * organizer comes back. Otherwise it was already there when the bot started.
 */
async function saveGuild(guild: Guild, joined = false): Promise<void> {
  const home = isHomeGuild(guild.id);
  const fresh = home || !joined || !homeGuildId ? 'active' : 'unclaimed';
  // A server someone already claimed stays theirs; one the bot was kicked from starts over.
  await sql!`
    insert into discord_server (guild_id, name, icon, status, is_home)
    values (${guild.id}, ${guild.name}, ${guild.iconURL()}, ${fresh}, ${Boolean(homeGuildId) && home})
    on conflict (guild_id) do update set
      name = excluded.name,
      icon = excluded.icon,
      is_home = excluded.is_home,
      removed_at = null,
      joined_at = case when discord_server.status = 'removed' then now() else discord_server.joined_at end,
      status = case
        when ${home} or discord_server.claimed_by is not null then 'active'
        when discord_server.status = 'removed' then excluded.status
        else discord_server.status end`;
  // The server's community, named after the server - created once it is in use, renamed with it.
  await sql!`
    insert into community (name, discord_guild_id, created_by, game_id)
    select s.name, s.guild_id, s.claimed_by, null from discord_server s
    where s.guild_id = ${guild.id} and s.status = 'active'
    on conflict (discord_guild_id) where discord_guild_id is not null do update set name = excluded.name`;
  await saveChannels(guild);
}

/** The whole channel list of one server, whether the bot may post in each, and its server-wide permissions. */
async function saveChannels(guild: Guild): Promise<void> {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const rows = [...guild.channels.cache.values()]
    .filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
    .map((channel) => ({
      channel_id: channel.id,
      guild_id: guild.id,
      name: channel.name,
      parent_name: channel.parent?.name ?? null,
      position: channel.rawPosition,
      can_post: channel.permissionsFor(me).has(postingPermissions),
    }));

  await sql!.begin(async (tx) => {
    await tx`delete from discord_channel where guild_id = ${guild.id} and not (channel_id = any(${rows.map((row) => row.channel_id)}))`;
    if (rows.length > 0) {
      await tx`
        insert into discord_channel ${tx(rows)}
        on conflict (channel_id) do update set
          guild_id = excluded.guild_id,
          name = excluded.name,
          parent_name = excluded.parent_name,
          position = excluded.position,
          can_post = excluded.can_post,
          updated_at = now()`;
    }
    await tx`update discord_server set permissions = ${me.permissions.bitfield.toString()}, synced_at = now() where guild_id = ${guild.id}`;
  });
}

// Channel and role events come in bursts (a category moved, a role edited);
// one resync a moment later covers the lot.
const pending = new Map<string, ReturnType<typeof setTimeout>>();
function resyncSoon(guild: Guild): void {
  clearTimeout(pending.get(guild.id));
  pending.set(
    guild.id,
    setTimeout(() => {
      pending.delete(guild.id);
      saveChannels(guild).catch((error: unknown) => console.error(`Channel sync for ${guild.name} failed:`, error));
    }, 2_000),
  );
}

const logged = (what: string) => (error: unknown) => console.error(`${what} failed:`, error);

/** Every server the bot is in, and servers it has left while it was offline. */
async function syncAll(client: Client): Promise<void> {
  const ids = [...client.guilds.cache.keys()];
  for (const guild of client.guilds.cache.values()) await saveGuild(guild).catch(logged(`Server sync for ${guild.name}`));
  await sql!`
    update discord_server set status = 'removed', removed_at = now()
    where status <> 'removed' and not (guild_id = any(${ids}))`;
}

/** "Načíst znovu" on the website: read those servers again now rather than at the next full pass. */
async function syncRequested(client: Client): Promise<void> {
  const rows = await sql!<{ guild_id: string }[]>`
    select guild_id from discord_server
    where status = 'active' and sync_requested_at > coalesce(synced_at, 'epoch')`;
  for (const { guild_id } of rows) {
    const guild = client.guilds.cache.get(guild_id);
    if (guild) await saveGuild(guild).catch(logged(`Requested sync for ${guild.name}`));
  }
}

/** Servers no organizer claimed in time: the bot was added by someone who is not one. */
async function leaveUnclaimed(client: Client): Promise<void> {
  const rows = await sql!<{ guild_id: string }[]>`
    select guild_id from discord_server
    where status = 'unclaimed' and joined_at < now() - make_interval(mins => ${claimWindowMinutes})`;
  for (const { guild_id } of rows) {
    const guild = client.guilds.cache.get(guild_id);
    if (!guild || isHomeGuild(guild.id)) continue;
    console.log(`Leaving ${guild.name} (${guild.id}): not connected by an organizer within ${claimWindowMinutes} minutes.`);
    await guild.leave().catch(logged(`Leaving ${guild.id}`));
  }
}

// Already gone, or the bot may not touch it any more - either way nothing left to do.
const goneCodes = new Set([10003, 10008, 10011, 50001, 50013]);
const unlessGone = (error: unknown) => {
  if (!goneCodes.has((error as { code?: number }).code ?? 0)) throw error;
};

/**
 * What deleted tournaments left on Discord - sign-up cards, captain roles,
 * "looking for a team" posts. The website queues them when it deletes the
 * tournament; a row stays until its leftovers are gone, so a hiccup is retried.
 */
async function cleanUpDeleted(client: Client): Promise<void> {
  const rows = await sql!<{ id: number; guild_id: string | null; channel_id: string | null; message_id: string | null; role_id: string | null }[]>`
    select id, guild_id, channel_id, message_id, role_id from discord_cleanup order by id limit 50`;
  for (const row of rows) {
    try {
      if (row.channel_id && row.message_id) {
        const channel = await client.channels.fetch(row.channel_id).catch(unlessGone);
        if (channel?.isTextBased() && !channel.isDMBased()) await channel.messages.delete(row.message_id).catch(unlessGone);
      }
      const guild = row.guild_id ? client.guilds.cache.get(row.guild_id) : undefined;
      if (guild && row.role_id) await guild.roles.delete(row.role_id, 'Tournament deleted').catch(unlessGone);
      await sql!`delete from discord_cleanup where id = ${row.id}`;
    } catch (error) {
      console.error(`Cleaning up after a deleted tournament (row ${row.id}) failed, retrying:`, error);
    }
  }
}

export function registerServerSync(client: Client): void {
  if (!sql) return;

  client.on(Events.GuildCreate, (guild) => void saveGuild(guild, true).catch(logged(`Saving ${guild.name}`)));
  client.on(Events.GuildUpdate, (_old, guild) => void saveGuild(guild).catch(logged(`Saving ${guild.name}`)));
  client.on(Events.GuildDelete, (guild) => {
    // An outage makes a server "unavailable" without the bot having left it.
    if (!guild.available) return;
    void sql!`update discord_server set status = 'removed', removed_at = now() where guild_id = ${guild.id}`.catch(
      logged(`Marking ${guild.id} removed`),
    );
  });

  client.on(Events.ChannelCreate, (channel) => resyncSoon(channel.guild));
  client.on(Events.ChannelUpdate, (_old, channel) => {
    if (!channel.isDMBased()) resyncSoon(channel.guild);
  });
  client.on(Events.ChannelDelete, (channel) => {
    if (!channel.isDMBased()) resyncSoon(channel.guild);
  });
  client.on(Events.GuildRoleCreate, (role) => resyncSoon(role.guild));
  client.on(Events.GuildRoleUpdate, (_old, role) => resyncSoon(role.guild));
  client.on(Events.GuildRoleDelete, (role) => resyncSoon(role.guild));
  // The bot given or stripped of a role changes what it may do, too.
  client.on(Events.GuildMemberUpdate, (_old, member) => {
    if (member.id === client.user?.id) resyncSoon(member.guild);
  });

  registerTask({ name: 'Requested server sync', intervalMs: 15_000, run: syncRequested, database: true });
  registerTask({ name: 'Deleted tournament cleanup', intervalMs: 15_000, run: cleanUpDeleted, database: true });
  // Events miss things (a restart mid-change); a slow full pass catches up.
  registerTask({ name: 'Discord server sync', intervalMs: 10 * 60_000, run: syncAll, database: true });
  if (homeGuildId) registerTask({ name: 'Unclaimed server sweep', intervalMs: 60_000, run: leaveUnclaimed, database: true });
}
