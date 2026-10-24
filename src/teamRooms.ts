/**
 * A private voice room per team, once the organizer has saved the lobby code.
 *
 * The tournament gets a category on its server (the one its first card went
 * to) with a voice room per main team, named after the lobby slot ("Team 3")
 * and capped at the team size. Everyone on the server sees the rooms and who is
 * in them; only the team's players may join theirs. The permission does that -
 * Connect denied to @everyone, allowed per player - so a link to someone
 * else's room gets nobody in. The organizer may join and move people in all of
 * them (Move Members also ignores the user limit).
 *
 * Kept in sync every round, before the lobby-code DMs go out (they carry the
 * link to the room): a new team gets a room, a team change rewrites who may
 * join, a team that is gone loses its room. An hour after the tournament
 * finishes - or as soon as it is deleted - the category and rooms go.
 *
 * Only players the bot has seen on that server are let in (registration.on_server);
 * anyone who joins later is added on the next round.
 */
import { ChannelType, OverwriteType, PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import { sql } from './db.ts';
import { createJsonStore } from './jsonStore.ts';

type Room = { channelId: string; name: string; members: string };
type Rooms = {
  guildId: string;
  categoryId: string;
  /** Keyed by team id. */
  rooms: Record<string, Room>;
  /** When the bot first saw the tournament finished; the rooms go an hour later. */
  finishedAt?: number;
};

/** Keyed by tournament id. */
const store = createJsonStore<Rooms>('teamRooms.json');

const keepAfterFinishMs = 60 * 60_000;
const required = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers];
const warned = new Set<string>();
const logged = (what: string) => (error: unknown) => console.error(`${what} failed:`, error);

/** Link to a team's room for the lobby-code DM, if it has one. */
export async function roomLink(tournamentId: string, teamId: string): Promise<string | null> {
  const entry = await store.get(tournamentId);
  const room = entry?.rooms[teamId];
  return entry && room ? `https://discord.com/channels/${entry.guildId}/${room.channelId}` : null;
}

function canManage(guild: Guild, tournamentName: string): boolean {
  const me = guild.members.me;
  if (me && required.every((p) => me.permissions.has(p))) return true;
  if (!warned.has(guild.id)) {
    warned.add(guild.id);
    console.warn(`Team rooms for "${tournamentName}": the bot needs Manage Channels and Move Members (and Manage Roles for the room permissions) on ${guild.name}.`);
  }
  return false;
}

/** Who may join: the team, the organizer, the bot. Everyone else sees the room but can't connect. */
function overwrites(guild: Guild, members: string[], organizer: string | null) {
  const join = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
  const staff = [...join, PermissionFlagsBits.MoveMembers];
  return [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.Connect] },
    { id: guild.client.user.id, type: OverwriteType.Member, allow: [...staff, PermissionFlagsBits.ManageChannels] },
    ...(organizer ? [{ id: organizer, type: OverwriteType.Member, allow: staff }] : []),
    ...members.filter((m) => m !== organizer).map((id) => ({ id, type: OverwriteType.Member, allow: join })),
  ];
}

async function sync(client: Client): Promise<void> {
  const due = await sql!<{ id: string; name: string; team_size: number; guild_id: string | null; organizer: string | null }[]>`
    select t.id, t.name, t.team_size,
      (select p.guild_id from tournament_post p where p.tournament_id = t.id and p.message_id is not null and p.guild_id is not null
        order by p.id limit 1) as guild_id,
      (select pl.discord_id from player pl where pl.user_id = t.created_by and pl.discord_id ~ '^[0-9]+$') as organizer
    from tournament t
    where t.lobby_code is not null and t.status in ('closed', 'live')`;

  for (const t of due) {
    const guild = t.guild_id ? client.guilds.cache.get(t.guild_id) : undefined;
    if (!guild || !canManage(guild, t.name)) continue;
    const teams = await sql!<{ id: string; name: string; slot: number; members: string[] }[]>`
      select tm.id, tm.name, row_number() over (order by tm.display_order, tm.created_at)::int as slot,
        coalesce(array_agg(r.discord_id order by r.discord_id) filter (where r.id is not null), '{}') as members
      from team tm
      left join registration r on r.team_id = tm.id and r.removed_at is null and r.role <> 'substitute'
        and r.discord_id ~ '^[0-9]+$' and r.on_server
      where tm.tournament_id = ${t.id} and not tm.is_substitute
      group by tm.id
      order by tm.display_order, tm.created_at`;
    if (!teams.length) continue;

    const entry: Rooms = (await store.get(t.id)) ?? { guildId: guild.id, categoryId: '', rooms: {} };
    // A category deleted by hand (or never made) is made again, with fresh rooms in it.
    let category = entry.categoryId ? await guild.channels.fetch(entry.categoryId).catch(() => null) : null;
    if (!category) {
      category = await guild.channels.create({ name: `🏆 ${t.name}`.slice(0, 100), type: ChannelType.GuildCategory });
      entry.categoryId = category.id;
      entry.rooms = {};
      await store.set(t.id, entry);
    }

    for (const team of teams) {
      const name = (team.name === `Team ${team.slot}` ? `Team ${team.slot}` : `Team ${team.slot} · ${team.name}`).slice(0, 100);
      const members = team.members.join(',');
      const known = entry.rooms[team.id];
      const channel = known ? await guild.channels.fetch(known.channelId).catch(() => null) : null;
      try {
        if (!channel || channel.type !== ChannelType.GuildVoice) {
          const created = await guild.channels.create({
            name,
            type: ChannelType.GuildVoice,
            parent: category.id,
            userLimit: Math.min(Math.max(t.team_size, 1), 99),
            permissionOverwrites: overwrites(guild, team.members, t.organizer),
          });
          entry.rooms[team.id] = { channelId: created.id, name, members };
        } else if (known!.name !== name || known!.members !== members) {
          // Only on a change: renames and overwrite edits are rate-limited.
          if (known!.name !== name) await channel.setName(name);
          if (known!.members !== members) await channel.permissionOverwrites.set(overwrites(guild, team.members, t.organizer));
          entry.rooms[team.id] = { channelId: channel.id, name, members };
        }
      } catch (error) {
        logged(`Team room "${name}" of "${t.name}"`)(error);
      }
    }

    // Teams that are gone (a redraw, a cleared draw) take their rooms with them.
    const live = new Set(teams.map((team) => team.id));
    for (const [teamId, room] of Object.entries(entry.rooms)) {
      if (live.has(teamId)) continue;
      await guild.channels.delete(room.channelId).catch(() => {});
      delete entry.rooms[teamId];
    }
    await store.set(t.id, entry);
  }
}

/** Finished an hour ago, or deleted: the category and its rooms go. */
async function cleanUp(client: Client): Promise<void> {
  const tracked = await store.all();
  const ids = Object.keys(tracked);
  if (!ids.length) return;
  const rows = await sql!<{ id: string; status: string }[]>`select id, status from tournament where id in ${sql!(ids)}`;
  const status = new Map(rows.map((r) => [r.id, r.status]));
  for (const [id, entry] of Object.entries(tracked)) {
    const s = status.get(id);
    if (s && s !== 'finished') continue;
    if (s === 'finished') {
      if (!entry.finishedAt) {
        await store.set(id, { ...entry, finishedAt: Date.now() });
        continue;
      }
      if (Date.now() - entry.finishedAt < keepAfterFinishMs) continue;
    }
    const guild = client.guilds.cache.get(entry.guildId);
    if (guild) {
      for (const room of Object.values(entry.rooms)) await guild.channels.delete(room.channelId).catch(() => {});
      await guild.channels.delete(entry.categoryId).catch(() => {});
    }
    await store.remove(id);
  }
}

/** One round: rooms first (the lobby-code DMs link to them), then the cleanup. */
export async function syncTeamRooms(client: Client): Promise<void> {
  await sync(client).catch(logged('Team rooms'));
  await cleanUp(client).catch(logged('Team room cleanup'));
}
