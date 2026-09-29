/**
 * What the bot posts around a tournament besides its sign-up card, each where
 * the community wants it (/admin/servers on the website; unset = the channel
 * the card went to) and only if the organizer left it on in the builder:
 *
 *   - 30 minutes before the start, a reminder with one @everyone (config.reminder),
 *     taken down again when the tournament starts;
 *   - after every ended match, its results as an image, and the final standings
 *     when the tournament finishes (config.results). A score corrected later
 *     edits the post rather than adding one - discord_result_post remembers
 *     each post and what it showed.
 *
 * The images are drawn by the website (/api/results/<id>), so they look like
 * the site; if it can't be reached the post still goes out, as text with a link.
 * Tournaments from before these options have neither set, so nothing old is posted.
 *
 * Also here, for the same tournaments:
 *   - at the start time the tournament goes live by itself (sign-ups lock, the
 *     matches are created) and the reminder channel hears it has begun (@everyone);
 *   - whether each player is on the tournament's server - the website warns the
 *     ones who are not (no server, no DMs);
 *   - the organizer's lobby code, DMed to every player with a team, with the
 *     slot their team takes in the custom lobby.
 */
import { AttachmentBuilder, EmbedBuilder, type Client, type GuildTextBasedChannel } from 'discord.js';
import { siteUrl } from './config.ts';
import { sql } from './db.ts';
import { registerTask } from './liveMessages.ts';

const EMBER = 0xff6a1f;
const site = (t: { site_url: string | null }) => (t.site_url || siteUrl).replace(/\/$/, '');
const unix = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);
const logged = (what: string) => (error: unknown) => console.error(`${what} failed:`, error);

async function textChannel(client: Client, id: string): Promise<GuildTextBasedChannel | null> {
  const channel = await client.channels.fetch(id).catch(() => null);
  if (!channel || channel.isDMBased() || !channel.isSendable()) return null;
  return channel as GuildTextBasedChannel;
}

// --- the reminder ---------------------------------------------------------------

type Posted = { channel_id: string; message_id: string };

/**
 * Posts to each community's reminder channel (or the card's channel) with one
 * @everyone - not a mention per player, which would be a wall of names. The
 * ping only works where the bot may mention everyone (the server card shows
 * it); without that the post still goes out, just quietly. Returns what it posted.
 */
async function announce(client: Client, t: { id: string; name: string }, text: string): Promise<Posted[]> {
  const posts = await sql!<{ channel_id: string }[]>`
    select coalesce(c.reminder_channel_id, p.channel_id) as channel_id
    from tournament_post p left join community c on c.id = p.community_id
    where p.tournament_id = ${t.id} and p.message_id is not null
    order by p.id`;
  const sent: Posted[] = [];
  for (const channelId of new Set(posts.map((p) => p.channel_id))) {
    const channel = await textChannel(client, channelId);
    if (!channel) {
      console.warn(`"${t.name}": channel ${channelId} is gone or not writable.`);
      continue;
    }
    const message = await channel
      .send({ content: `@everyone ${text}`, allowedMentions: { parse: ['everyone'] } })
      .catch(logged(`"${t.name}" in ${channelId}`));
    if (message) sent.push({ channel_id: channelId, message_id: message.id });
  }
  return sent;
}

/** Deletes posts made earlier (the reminder, once the tournament has started). Gone already is fine. */
async function removePosts(client: Client, posts: Posted[]): Promise<void> {
  for (const post of posts) {
    const channel = await textChannel(client, post.channel_id);
    await channel?.messages.delete(post.message_id).catch(() => {});
  }
}

type Upcoming = { id: string; name: string; starts_at: Date; site_url: string | null };

async function sendReminders(client: Client): Promise<void> {
  // Starting within 30 minutes (or just started - a bot restart must not lose it); never twice.
  const due = await sql!<Upcoming[]>`
    select id, name, starts_at, site_url from tournament
    where visibility = 'public' and status in ('open', 'closed', 'live') and reminder_sent_at is null
      and (config->>'reminder')::boolean is true
      and starts_at is not null
      and starts_at <= (now() at time zone 'UTC') + interval '30 minutes'
      and starts_at > (now() at time zone 'UTC') - interval '10 minutes'`;

  for (const t of due) {
    // Claimed first, so a crash mid-way can't ping everyone twice.
    const [claimed] = await sql!`update tournament set reminder_sent_at = now() where id = ${t.id} and reminder_sent_at is null returning id`;
    if (!claimed) continue;

    const sent = await announce(
      client,
      t,
      [
        `⏰ **${t.name}** začíná <t:${unix(t.starts_at)}:R> (v <t:${unix(t.starts_at)}:t>). Připravte se – za chvíli se jde na to!`,
        `Podrobnosti a soupiska: ${site(t)}/t/${t.id}`,
      ].join('\n'),
    );
    // Kept so the reminder can be taken down when the tournament starts.
    await sql!`update tournament set reminder_messages = ${sql!.json(sent)} where id = ${t.id}`;
  }
}

// --- the start ------------------------------------------------------------------

/**
 * Start time reached: the tournament goes live by itself - sign-ups lock, its
 * matches are created - and the reminder channel hears it. Only tournaments made
 * with these options (older ones are started by hand, as before). Unpaid players
 * stay signed up; the draw leaves them out, as it always has.
 */
async function startTournaments(client: Client): Promise<void> {
  const started = await sql!<{ id: string; name: string; was: string }[]>`
    with due as (
      select id, status as was from tournament
      where status in ('open', 'closed') and starts_at is not null
        and starts_at <= (now() at time zone 'UTC')
        and (config ? 'reminder' or config ? 'results')
      for update
    )
    update tournament t set status = 'live' from due where t.id = due.id
    returning t.id, t.name, due.was`;
  for (const t of started) {
    await sql!`
      insert into match (id, tournament_id, match_number)
      select gen_random_uuid()::text, t.id, n
      from tournament t, generate_series(1, coalesce((t.config->'rules'->>'matchCount')::int, 6)) n
      where t.id = ${t.id} and not exists (select 1 from match m where m.tournament_id = t.id)`;
    await sql!`
      insert into audit_log (id, actor_id, actor_label, action, subject_type, subject_id, subject_label, before, after)
      values (gen_random_uuid()::text, null, 'Tournevo bot', 'tournament.status', 'tournament', ${t.id}, ${t.name},
        ${sql!.json({ status: t.was })}, ${sql!.json({ status: 'live' })})`;
    console.log(`Tournament "${t.name}" started at its start time.`);
  }

  // The start notice: once, to the reminder channel - whether the bot started it or the organizer did.
  const live = await sql!<{ id: string; name: string; site_url: string | null; reminder_messages: Posted[] | null }[]>`
    select id, name, site_url, reminder_messages from tournament
    where status = 'live' and visibility = 'public' and started_notified_at is null
      and (config->>'reminder')::boolean is true
      and (starts_at is null or starts_at > (now() at time zone 'UTC') - interval '2 hours')`;
  for (const t of live) {
    const [claimed] = await sql!`update tournament set started_notified_at = now() where id = ${t.id} and started_notified_at is null returning id`;
    if (!claimed) continue;
    // "Starts in 30 minutes" is out of date now - it makes way for "it's starting".
    await removePosts(client, t.reminder_messages ?? []);
    await announce(
      client,
      t,
      [
        `🔴 **${t.name}** právě začíná! Tvůj tým a kód do lobby ti pošlu do DM, jakmile je organizátor zadá.`,
        `Průběžné výsledky: ${site(t)}/t/${t.id}`,
      ].join('\n'),
    );
  }
}

// --- who is on the server ------------------------------------------------------------

/**
 * Whether each signed-up player is on (one of) the servers the tournament was
 * announced in. The bot can only DM people it shares a server with, so the
 * website warns anyone who is not. Unknown players are checked soon; those on
 * the server now and then, those not every couple of minutes (they may join).
 */
async function checkMembership(client: Client): Promise<void> {
  const due = await sql!<{ id: string; discord_id: string; guilds: string[] }[]>`
    select r.id, r.discord_id, array_agg(distinct p.guild_id) as guilds
    from registration r
    join tournament t on t.id = r.tournament_id and t.status <> 'finished'
    join tournament_post p on p.tournament_id = t.id and p.message_id is not null and p.guild_id is not null
    where r.removed_at is null and r.discord_id ~ '^[0-9]+$'
      and (r.server_checked_at is null
        or r.server_checked_at < (now() at time zone 'UTC') - case when r.on_server then interval '30 minutes' else interval '2 minutes' end)
    group by r.id
    limit 50`;
  for (const row of due) {
    let on = false;
    for (const id of row.guilds) {
      const guild = client.guilds.cache.get(id);
      if (guild && (await guild.members.fetch({ user: row.discord_id }).catch(() => null))) {
        on = true;
        break;
      }
    }
    await sql!`update registration set on_server = ${on}, server_checked_at = now() where id = ${row.id}`;
  }
}

// --- the lobby code ----------------------------------------------------------------

/**
 * The organizer's lobby code, DMed to every player with a main team, with the
 * slot their team takes in the custom lobby (main teams in the organizer's
 * order: Team 1..N). A new code goes out again; a DM that can't be delivered is
 * marked so the website can show it, and not retried.
 */
async function sendLobbyCodes(client: Client): Promise<void> {
  const due = await sql!<{ id: string; discord_id: string; name: string; code: string; team: string; slot: number; site_url: string | null; tournament_id: string }[]>`
    select r.id, r.discord_id, t.name, t.lobby_code as code, tm.name as team, t.site_url, t.id as tournament_id,
      (select x.slot from (
        select m.id, row_number() over (order by m.display_order, m.created_at)::int as slot
        from team m where m.tournament_id = t.id and not m.is_substitute) x where x.id = tm.id) as slot
    from registration r
    join tournament t on t.id = r.tournament_id
    join team tm on tm.id = r.team_id and not tm.is_substitute
    where t.lobby_code is not null and t.status in ('closed', 'live') and r.removed_at is null and r.role <> 'substitute'
      and r.discord_id ~ '^[0-9]+$'
      and r.lobby_code_sent is distinct from t.lobby_code and r.lobby_code_sent is distinct from 'failed:' || t.lobby_code
    limit 40`;
  for (const row of due) {
    const text = [
      `🎮 **${row.name}** – hraješ za tým **${row.team}**.`,
      `V custom lobby se přidej do **Team ${row.slot}**.`,
      `Kód do lobby: **\`${row.code}\`**`,
      'Kód nikomu dalšímu neposílej – každý hráč ho má od bota sám.',
      `Turnaj: ${site(row)}/t/${row.tournament_id}`,
    ].join('\n');
    const user = await client.users.fetch(row.discord_id).catch(() => null);
    const sent = user ? await user.send(text).then(() => true).catch(() => false) : false;
    await sql!`update registration set lobby_code_sent = ${sent ? row.code : `failed:${row.code}`} where id = ${row.id}`;
  }
}


// --- the results ----------------------------------------------------------------

type Due = {
  tournament_id: string;
  name: string;
  site_url: string | null;
  /** The match's id, or 'final'. */
  result_key: string;
  match_number: number | null;
  total: number;
  winner: string | null;
  content_key: string;
  community_id: string;
  channel_id: string;
  posted_channel_id: string | null;
  posted_message_id: string | null;
};

/** Results that were never posted in a community, or changed since. Recent tournaments only. */
function dueResults() {
  return sql!<Due[]>`
    with results as (
      -- Each ended match that has scores...
      select m.tournament_id, m.id as result_key, m.match_number,
        (select t2.name from score s2 join team t2 on t2.id = s2.team_id where s2.match_id = m.id and s2.placement = 1 limit 1) as winner,
        md5(string_agg(s.team_id || ':' || s.placement || ':' || s.kills, ',' order by s.team_id)) as content_key
      from match m join score s on s.match_id = m.id
      where m.is_complete
      group by m.id
      union all
      -- ...and the final standings of a finished tournament.
      select m.tournament_id, 'final', null,
        (select t2.name from team t2 join score s2 on s2.team_id = t2.id join match m2 on m2.id = s2.match_id
          where m2.tournament_id = m.tournament_id and not t2.is_substitute
          group by t2.id, t2.name order by sum(s2.total_points) desc, sum(s2.kill_points) desc limit 1),
        md5(string_agg(s.team_id || ':' || m.match_number || ':' || s.placement || ':' || s.kills, ',' order by m.match_number, s.team_id))
      from match m join score s on s.match_id = m.id
      join tournament tf on tf.id = m.tournament_id and tf.status = 'finished'
      group by m.tournament_id
    )
    select t.id as tournament_id, t.name, t.site_url, r.result_key, r.match_number, r.winner, r.content_key,
      (select count(*)::int from match where tournament_id = t.id) as total,
      p.community_id, coalesce(c.results_channel_id, p.channel_id) as channel_id,
      d.channel_id as posted_channel_id, d.message_id as posted_message_id
    from results r
    join tournament t on t.id = r.tournament_id
    join tournament_post p on p.tournament_id = t.id and p.message_id is not null and p.community_id is not null
    left join community c on c.id = p.community_id
    left join discord_result_post d on d.tournament_id = t.id and d.result_key = r.result_key and d.community_id = p.community_id
    where t.visibility = 'public' and t.status in ('live', 'finished')
      and (t.config->>'results')::boolean is true
      and (t.ended_at is null or t.ended_at > (now() at time zone 'UTC') - interval '2 days')
      and (d.id is null or d.content_key <> r.content_key)
    order by t.id, r.match_number nulls last`;
}

async function postResult(client: Client, row: Due): Promise<void> {
  const final = row.result_key === 'final';
  const page = `${site(row)}/t/${row.tournament_id}`;
  const image = new URL(`${site(row)}/api/results/${row.tournament_id}`);
  if (!final) image.searchParams.set('match', String(row.match_number));
  image.searchParams.set('v', row.content_key.slice(0, 12));
  const file = final ? 'konecne-poradi.png' : `zapas-${row.match_number}.png`;

  const png = await fetch(image, { signal: AbortSignal.timeout(20_000) })
    .then(async (res) => (res.ok ? Buffer.from(await res.arrayBuffer()) : null))
    .catch(() => null);

  const embed = new EmbedBuilder()
    .setColor(EMBER)
    .setTitle(final ? `🏆 ${row.name} · konečné pořadí` : `${row.name} · zápas ${row.match_number}/${row.total}`)
    .setURL(page)
    .setDescription(
      [
        row.winner ? (final ? `Vítěz turnaje: **${row.winner}**` : `Zápas vyhrál **${row.winner}**`) : null,
        png ? null : `Celé výsledky: ${page}`,
      ]
        .filter(Boolean)
        .join('\n') || null,
    );
  if (png) embed.setImage(`attachment://${file}`);
  const payload = { embeds: [embed], files: png ? [new AttachmentBuilder(png, { name: file })] : [], allowedMentions: { parse: [] } };

  // A post already made in the same channel is edited; anything else is a new post.
  let messageId: string | null = null;
  if (row.posted_message_id && row.posted_channel_id === row.channel_id) {
    const channel = await textChannel(client, row.channel_id);
    const message = await channel?.messages.fetch(row.posted_message_id).catch(() => null);
    if (message) {
      await message.edit({ ...payload, attachments: [] });
      messageId = message.id;
    }
  }
  if (!messageId) {
    const channel = await textChannel(client, row.channel_id);
    if (!channel) throw new Error(`channel ${row.channel_id} is gone or not writable`);
    messageId = (await channel.send(payload)).id;
  }

  await sql!`
    insert into discord_result_post (tournament_id, result_key, community_id, channel_id, message_id, content_key)
    values (${row.tournament_id}, ${row.result_key}, ${row.community_id}, ${row.channel_id}, ${messageId}, ${row.content_key})
    on conflict (tournament_id, result_key, community_id) do update set
      channel_id = excluded.channel_id, message_id = excluded.message_id, content_key = excluded.content_key, posted_at = now()`;
}

async function sendResults(client: Client): Promise<void> {
  for (const row of await dueResults()) {
    await postResult(client, row).catch(logged(`Results of "${row.name}" (${row.result_key}) in ${row.channel_id}`));
  }
}

if (sql) {
  registerTask({
    name: 'Tournament start, reminders, results and lobby codes',
    intervalMs: 30_000,
    run: async (client) => {
      await startTournaments(client).catch(logged('Tournament start'));
      await sendReminders(client).catch(logged('Tournament reminders'));
      await sendResults(client).catch(logged('Tournament results'));
      await checkMembership(client).catch(logged('Server membership check'));
      await sendLobbyCodes(client).catch(logged('Lobby codes'));
    },
    database: true,
  });
}
