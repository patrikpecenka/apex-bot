/**
 * Tournament sign-ups, the Discord half. Players belong to the website
 * (quick-tournament-view): they sign in there with Discord and enter their
 * in-game nickname and rank, and only then can they sign up anywhere. The bot:
 *
 *   - posts a sign-up card for every public tournament into the channel of each
 *     community its organizer announced it in (tournament_post), looking the way
 *     they set it up in the builder, and writes down why when it cannot
 *   - Register -> register_player() in the database, which uses that website
 *     profile; no profile means the bot hands out the sign-up link instead.
 *     Tournaments played in pre-made teams sign up on the website (teams and
 *     invites live there), so their card links there instead.
 *   - captain-format tournaments only: gives captains the "Captain" role, and
 *     deletes the role when the tournament ends
 *   - DMs a payment QR to every paying player, and a note once the organizer
 *     confirms the payment
 *   - mirrors "looking for a team" posts from the website into the channel
 *
 * Which slot a sign-up gets, and who may sign up at all, is decided by
 * register_player() / join_block(), so the website and the bot cannot drift
 * apart. Those functions and the table layout live in the website repo:
 * packages/db/src/scripts/install-functions.ts and packages/db/src/schema/
 */

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type BaseMessageOptions,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
} from 'discord.js';
import { paymentIban, siteUrl } from './config.ts';
import { sql } from './db.ts';
import type postgres from 'postgres';
import { componentId, type ComponentHandler } from './components/ids.ts';
import { registerTask } from './liveMessages.ts';
import { paymentQrPng, qrMessage } from './paymentQr.ts';

export type Role = 'captain' | 'player' | 'substitute';
type PaymentStatus = 'unpaid' | 'sent' | 'paid' | 'not_required';
type Formation = 'premade' | 'random' | 'captains';

type Tournament = {
  id: string;
  name: string;
  // A string when the row comes back through to_jsonb().
  starts_at: Date | string | null;
  entry_fee_czk: number | null;
  /** The organizer's account for entry fees; null = PAYMENT_IBAN (tournaments from before). */
  payment_iban: string | null;
  prize_pool_czk: number | null;
  team_size: number;
  team_formation: Formation;
  game_id: string;
  /** Joined in by the sync query; cards built elsewhere fall back to game_id. */
  game_name?: string;
  visibility: 'public' | 'private';
  max_teams: number;
  max_captains: number;
  max_players: number;
  max_substitutes: number;
  status: 'open' | 'closed' | 'live' | 'finished';
  registration_closes_at: Date | string | null;
  /** The first card posted: "looking for a team" posts go to its channel, the captain role to its server. */
  discord_channel_id: string | null;
  discord_message_id: string | null;
  discord_guild_id: string | null;
  captain_role_id: string | null;
  /** How the card looks, from the website's builder; null = the defaults. */
  announcement: Partial<Announcement> | null;
};

/** One card: a tournament announced in a community (tournament_post). */
type Post = {
  id: number;
  tournament_id: string;
  channel_id: string | null;
  message_id: string | null;
  error: string | null;
  posted_at: Date | null;
  /** Joined in: where a card not posted yet goes. */
  community_channel_id: string | null;
};

/**
 * The organizer's settings for the card - the website's
 * packages/api/src/announcement.ts, whose builder preview mirrors renderCard().
 * Empty strings mean the defaults below.
 */
type Announcement = {
  mention: 'none' | 'here' | 'everyone';
  content: string;
  authorName: string;
  authorUrl: string;
  authorIconUrl: string;
  color: string;
  title: string;
  description: string;
  hidden: string[];
  /** The automatic fields three to a row, or each on a row of its own. */
  autoInline: boolean;
  fields: { name: string; value: string; inline: boolean }[];
  thumbnailUrl: string;
  imageUrl: string;
  footerText: string;
  footerIconUrl: string;
  timestamp: 'none' | 'start' | 'posted';
  buttonLabel: string;
};

const defaultAnnouncement: Announcement = {
  mention: 'none',
  content: '',
  authorName: '',
  authorUrl: '',
  authorIconUrl: '',
  color: '',
  title: '',
  description: '',
  hidden: [],
  autoInline: true,
  fields: [],
  thumbnailUrl: '',
  imageUrl: '',
  footerText: '',
  footerIconUrl: '',
  timestamp: 'none',
  buttonLabel: '',
};

type Registration = {
  id: string;
  tournament_id: string;
  discord_id: string;
  nickname: string;
  max_rank: string;
  role: Role;
  payment_status: PaymentStatus;
  variable_symbol: number;
  qr_sent_at: Date | null;
  has_captain_role: boolean;
};

/** Sign-ups per slot; for premade tournaments also teams (main and substitute). */
export type RoleCounts = Record<Role, number> & {
  teams: number;
  subTeams: number;
  /** Live tournaments: match progress and who leads. */
  matchesDone: number;
  matchesTotal: number;
  leader: { name: string; points: number } | null;
};

const captainRoleName = 'Captain';

/** Where a player creates their profile, and can sign up without Discord. */
const joinUrl = (tournamentId: string) => `${siteUrl}/join/${tournamentId}`;
const tournamentUrl = (tournamentId: string) => `${siteUrl}/t/${tournamentId}`;

/** open, and not past the sign-up deadline the organizer set. */
const takingSignUps = (t: Tournament) =>
  t.status === 'open' && (!t.registration_closes_at || new Date(t.registration_closes_at).getTime() > Date.now());

const enabled = Boolean(sql);

const texts = {
  register: 'Registrovat',
  free: 'Zdarma',
  game: 'Hra',
  format: 'Formát',
  start: 'Start',
  deadline: 'Registrace do',
  entryFee: 'Startovné',
  prizePool: 'Ceny',
  website: 'Registrace na webu',
  createTeam: 'Založit tým na webu',
  teamSize: (n: number) => (n === 1 ? 'Solo' : n === 2 ? 'Duo' : n === 3 ? 'Trio' : `${n} hráčů`),
  formation: { premade: 'vlastní tým', random: 'náhodné týmy', captains: 'kapitáni + hráči' } satisfies Record<Formation, string>,
  liveLine: (done: number, total: number, leader: { name: string; points: number } | null) =>
    [`Turnaj právě běží · match ${Math.min(done + 1, total)}/${total}`, leader ? `vede ${leader.name} ${leader.points}` : null]
      .filter(Boolean)
      .join(' · '),
  teamsHeading: 'Týmy',
  subTeamsHeading: 'Náhradní týmy',
  live: 'Turnaj právě běží.',
  mainFull: 'Hlavní sloty jsou plné – registrace už jen jako náhradník.',
  closed: 'Registrace jsou uzavřené.',
  over: 'Turnaj je ukončený.',
  full: 'Turnaj je plný, i všechna místa pro náhradníky jsou obsazená.',
  teamRequired: (tournamentId: string) =>
    `Tenhle turnaj se hraje v týmech. Založ tým nebo se přidej přes pozvánku od spoluhráče:\n${tournamentUrl(tournamentId)}`,
  ineligible: 'Tvůj rank nesplňuje podmínky tohohle turnaje.',
  conflict: (other: string | null) =>
    `Ten den už hraješ${other ? ` **${other}**` : ' jiný turnaj'} – dva turnaje v jeden den nejdou.`,
  unavailable: 'Registrace teď nejsou dostupné, zkus to prosím za chvíli.',
  gone: 'Tenhle turnaj už neexistuje.',
  noProfile: (tournamentId: string) =>
    'Nejdřív potřebuješ profil na webu – přihlas se Discordem a zadej nick ve hře a rank:\n' +
    `${joinUrl(tournamentId)}\n` +
    'Registraci můžeš dokončit hned tam, nebo se sem vrátit a kliknout na **Registrovat**.',
  roleName: { captain: 'kapitán', player: 'hráč', substitute: 'náhradník' } satisfies Record<Role, string>,
  roleHeading: { captain: 'Kapitáni', player: 'Hráči', substitute: 'Náhradníci' } satisfies Record<Role, string>,
  registered: (name: string, role: Role) => `Jsi zaregistrovaný do **${name}** jako **${texts.roleName[role]}**.`,
  already: (name: string, role: Role) => `Do **${name}** už jsi zaregistrovaný jako **${texts.roleName[role]}**.`,
  paid: 'Startovné máš zaplacené. ✅',
  sent: 'Platbu jsi označil jako odeslanou – organizátor ji potvrdí, jakmile dorazí.',
  paidConfirmed: (name: string, amount: number | null) =>
    `✅ Platba potvrzena – **${name}**${amount ? `, ${amount} Kč` : ''}. Uvidíme se v lobby.`,
  lookingForTeam: (discordId: string, name: string, note: string | null) =>
    `🔎 <@${discordId}> hledá tým do **${name}**${note ? `: ${note}` : '.'}`,
  payBelow: 'Zaplať startovné přes QR kód níže (poslali jsme ti ho i do DM).',
  announceFull: (name: string) =>
    `📢 **${name}**: hlavní sloty jsou plné! Dál se dá registrovat jen jako náhradník (bez startovného).`,
  payment: (t: Tournament, reg: Registration) =>
    [
      `**${t.name}** – platba startovného`,
      `Částka: **${t.entry_fee_czk} CZK**`,
      `Účet: \`${t.payment_iban || paymentIban}\``,
      `Variabilní symbol: \`${reg.variable_symbol}\``,
      `Zpráva: \`${qrMessage(reg.nickname, reg.max_rank)}\``,
      'Naskenuj QR kód v bankovní aplikaci. Platbu potvrzuje organizátor ručně, může to trvat pár dní.',
    ].join('\n'),
};

async function countRoles(db: postgres.Sql | postgres.TransactionSql, tournamentId: string): Promise<RoleCounts> {
  const counts: RoleCounts = {
    captain: 0,
    player: 0,
    substitute: 0,
    teams: 0,
    subTeams: 0,
    matchesDone: 0,
    matchesTotal: 0,
    leader: null,
  };
  const rows = await db<{ role: Role; n: number }[]>`
    select role, count(*)::int as n from registration
    where tournament_id = ${tournamentId} and removed_at is null
    group by role`;
  for (const row of rows) counts[row.role] = row.n;
  const [teams] = await db<{ main: number; sub: number }[]>`
    select count(*) filter (where not is_substitute)::int as main, count(*) filter (where is_substitute)::int as sub
    from team where tournament_id = ${tournamentId}`;
  counts.teams = teams?.main ?? 0;
  counts.subTeams = teams?.sub ?? 0;
  const [progress] = await db<{ done: number; total: number; leader: { name: string; points: number } | null }[]>`
    select
      (select count(*) from match where tournament_id = ${tournamentId} and is_complete)::int as done,
      (select count(*) from match where tournament_id = ${tournamentId})::int as total,
      (select json_build_object('name', tm.name, 'points', sum(sc.total_points)::int)
         from team tm join score sc on sc.team_id = tm.id
         where tm.tournament_id = ${tournamentId} and not tm.is_substitute
         group by tm.id, tm.name
         order by sum(sc.total_points) desc, sum(sc.kill_points) desc
         limit 1) as leader`;
  counts.matchesDone = progress?.done ?? 0;
  counts.matchesTotal = progress?.total ?? 0;
  counts.leader = progress?.leader ?? null;
  return counts;
}

function mainFull(t: Tournament, counts: RoleCounts): boolean {
  if (t.team_formation === 'premade') return counts.teams >= t.max_teams;
  if (t.team_formation === 'random') return counts.player >= t.max_players;
  return counts.captain >= t.max_captains && counts.player >= t.max_players;
}

function everythingFull(t: Tournament, counts: RoleCounts): boolean {
  const subs = t.team_formation === 'premade' ? counts.subTeams : counts.substitute;
  return mainFull(t, counts) && subs >= t.max_substitutes;
}

/** The capacity fields, in whatever unit this format counts. */
function slotFields(t: Tournament, counts: RoleCounts, inline: boolean) {
  const field = (name: string, value: string) => ({ name, value, inline });
  if (t.team_formation === 'premade') {
    return [
      field(texts.teamsHeading, `${counts.teams}/${t.max_teams}`),
      field(texts.subTeamsHeading, `${counts.subTeams}/${t.max_substitutes}`),
    ];
  }
  return [
    ...(t.team_formation === 'captains'
      ? [field(texts.roleHeading.captain, `${counts.captain}/${t.max_captains}`)]
      : []),
    field(texts.roleHeading.player, `${counts.player}/${t.max_players}`),
    field(texts.roleHeading.substitute, `${counts.substitute}/${t.max_substitutes}`),
  ];
}

const unix = (date: Date | string) => Math.floor(new Date(date).getTime() / 1000);

/**
 * The sign-up card, as the organizer set it up in the builder. What changes
 * with the tournament (phase, free slots, live score) is filled in here; the
 * rest is theirs. postedAt: when this card went up, for the "posted" timestamp.
 */
function renderCard(t: Tournament, counts: RoleCounts, postedAt: Date): BaseMessageOptions {
  const a: Announcement = { ...defaultAnnouncement, ...t.announcement };
  const open = takingSignUps(t);
  const status = open
    ? mainFull(t, counts)
      ? `**${texts.mainFull}**`
      : null
    : t.status === 'live'
      ? `**${counts.matchesTotal ? texts.liveLine(counts.matchesDone, counts.matchesTotal, counts.leader) : texts.live}**`
      : `**${t.status === 'finished' ? texts.over : texts.closed}**`;
  const body = a.description.trim();
  // Website colours unless the organizer picked one: green while taking sign-ups, signal blue while live.
  const color = a.color ? parseInt(a.color.slice(1), 16) : open ? 0x2ee06a : t.status === 'live' ? 0x4cc2ff : 0x4f545c;
  const shown = (key: string) => !a.hidden.includes(key);
  const field = (name: string, value: string) => ({ name, value, inline: a.autoInline });
  const fields = [
    shown('game') ? field(texts.game, t.game_name ?? t.game_id) : null,
    shown('format')
      ? field(texts.format, [texts.teamSize(t.team_size), t.team_size > 1 ? texts.formation[t.team_formation] : null].filter(Boolean).join(' · '))
      : null,
    shown('start') && t.starts_at ? field(texts.start, `<t:${unix(t.starts_at)}:f>`) : null,
    shown('deadline') && open && t.registration_closes_at ? field(texts.deadline, `<t:${unix(t.registration_closes_at)}:R>`) : null,
    shown('fee') ? field(texts.entryFee, t.entry_fee_czk ? `${t.entry_fee_czk} Kč` : texts.free) : null,
    shown('prize') && t.prize_pool_czk ? field(texts.prizePool, `${t.prize_pool_czk.toLocaleString('cs-CZ')} Kč`) : null,
    ...(shown('slots') && t.status !== 'live' && t.status !== 'finished' ? slotFields(t, counts, a.autoInline) : []),
    ...a.fields,
  ].filter((f) => f !== null);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(a.title.trim() || t.name)
    .setURL(tournamentUrl(t.id))
    .addFields(fields.slice(0, 25));
  const description = [status, body].filter(Boolean).join('\n\n');
  if (description) embed.setDescription(description);
  if (a.authorName.trim()) embed.setAuthor({ name: a.authorName, url: a.authorUrl || undefined, iconURL: a.authorIconUrl || undefined });
  if (a.thumbnailUrl) embed.setThumbnail(a.thumbnailUrl);
  if (a.imageUrl) embed.setImage(a.imageUrl);
  if (a.footerText.trim()) embed.setFooter({ text: a.footerText, iconURL: a.footerIconUrl || undefined });
  if (a.timestamp === 'start' && t.starts_at) embed.setTimestamp(new Date(t.starts_at));
  if (a.timestamp === 'posted') embed.setTimestamp(postedAt);

  // Teams are made on the website, so a premade card only links there.
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    t.team_formation === 'premade'
      ? new ButtonBuilder().setURL(tournamentUrl(t.id)).setLabel(a.buttonLabel || texts.createTeam).setStyle(ButtonStyle.Link)
      : new ButtonBuilder()
          .setCustomId(componentId('tournament', 'register', t.id))
          .setLabel(a.buttonLabel || texts.register)
          .setStyle(ButtonStyle.Success)
          .setDisabled(everythingFull(t, counts)),
    // Second way in, and the only one for a player with no profile yet.
    ...(t.team_formation === 'premade'
      ? []
      : [new ButtonBuilder().setURL(joinUrl(t.id)).setLabel(texts.website).setStyle(ButtonStyle.Link)]),
  );
  const mention = a.mention === 'none' ? null : `@${a.mention}`;
  const content = [mention, a.content.trim()].filter(Boolean).join(' ');
  return {
    content,
    // Only the ping the organizer chose - never one typed into the text. Edits never ping again.
    allowedMentions: { parse: mention ? ['everyone'] : [] },
    embeds: [embed],
    components: open ? [row] : [],
  };
}

async function paymentReply(t: Tournament, reg: Registration): Promise<BaseMessageOptions> {
  const png = await paymentQrPng({
    iban: t.payment_iban || paymentIban,
    amountCzk: t.entry_fee_czk ?? 0,
    variableSymbol: reg.variable_symbol,
    message: qrMessage(reg.nickname, reg.max_rank),
  });
  return {
    content: texts.payment(t, reg),
    files: [new AttachmentBuilder(png, { name: `platba-${reg.variable_symbol}.png` })],
  };
}

/** DMs the QR once. The claim-first update keeps two ticks from both sending it. */
async function deliverQr(client: Client, t: Tournament, reg: Registration): Promise<void> {
  const claimed = await sql!`
    update registration set qr_sent_at = now()
    where id = ${reg.id} and qr_sent_at is null returning id`;
  if (claimed.length === 0) return;

  try {
    const user = await client.users.fetch(reg.discord_id);
    await user.send(await paymentReply(t, reg));
  } catch (error) {
    // Closed DMs. Left marked as sent: clicking Register again shows the QR.
    console.warn(`Payment QR DM to ${reg.discord_id} failed:`, error instanceof Error ? error.message : error);
  }
}

/** Moves the Discord role towards what the row says, once per change. */
async function syncCaptainRole(guild: Guild, roleId: string, reg: Registration, wants: boolean): Promise<void> {
  const claimed = await sql!`
    update registration set has_captain_role = ${wants}
    where id = ${reg.id} and has_captain_role <> ${wants} returning id`;
  if (claimed.length === 0) return;

  const options = { user: reg.discord_id, role: roleId, reason: 'Tournament sign-up' };
  try {
    await (wants ? guild.members.addRole(options) : guild.members.removeRole(options));
  } catch (error) {
    // Most likely the member left the server - nothing to retry.
    console.warn(`Captain role ${wants ? 'add' : 'remove'} for ${reg.discord_id} failed:`, error instanceof Error ? error.message : error);
  }
}

async function guildFor(client: Client, t: Tournament): Promise<Guild | null> {
  return t.discord_guild_id ? client.guilds.fetch(t.discord_guild_id).catch(() => null) : null;
}

/**
 * What register_player() in the website's database returns. It holds the whole
 * decision - profile check, slot limits, captain rule - so the website and the
 * bot always agree.
 */
type RegisterOutcome = {
  outcome:
    | 'registered'
    | 'already'
    | 'closed'
    | 'full'
    | 'no_profile'
    | 'not_found'
    | 'team_required'
    | 'team_full'
    | 'ineligible'
    | 'conflict'
    | 'error';
  registration_id: string | null;
  just_filled: boolean;
  detail: string | null;
};

async function register(tournamentId: string, discordId: string): Promise<RegisterOutcome> {
  const [row] = await sql!<RegisterOutcome[]>`
    select outcome, registration_id, just_filled, detail
    from register_player(${tournamentId}, ${discordId})`;
  return row ?? { outcome: 'error', registration_id: null, just_filled: false, detail: null };
}

/** The registration plus its tournament, for the reply and the QR. */
async function registrationById(id: string): Promise<(Registration & { t: Tournament }) | null> {
  const [row] = await sql!<(Registration & { t: Tournament })[]>`
    select r.*, to_jsonb(t) as t from registration r join tournament t on t.id = r.tournament_id
    where r.id = ${id}`;
  return row ?? null;
}

async function statusReply(
  kind: 'already' | 'registered',
  t: Tournament,
  reg: Registration,
): Promise<BaseMessageOptions> {
  const heading = kind === 'already' ? texts.already(t.name, reg.role) : texts.registered(t.name, reg.role);
  if (reg.payment_status === 'paid') return { content: `${heading}\n${texts.paid}` };
  if (reg.payment_status === 'sent') return { content: `${heading}\n${texts.sent}` };
  if (reg.payment_status !== 'unpaid') return { content: heading };

  const payment = await paymentReply(t, reg);
  return { ...payment, content: `${heading}\n${texts.payBelow}\n\n${payment.content}` };
}

async function handleRegisterButton(
  interaction: Parameters<ComponentHandler>[0],
  tournamentId: string,
): Promise<void> {
  if (!interaction.isButton()) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await register(tournamentId, interaction.user.id);

  if (result.outcome !== 'registered' && result.outcome !== 'already') {
    const message = {
      no_profile: texts.noProfile(tournamentId),
      closed: texts.closed,
      full: texts.full,
      team_full: texts.full,
      team_required: texts.teamRequired(tournamentId),
      ineligible: texts.ineligible,
      conflict: texts.conflict(result.detail),
      not_found: texts.gone,
      error: texts.unavailable,
    }[result.outcome];
    await interaction.editReply(message);
    return;
  }

  const row = await registrationById(result.registration_id!);
  if (!row) {
    await interaction.editReply(texts.unavailable);
    return;
  }
  const { t, ...reg } = row;
  await interaction.editReply(await statusReply(result.outcome, t, reg as Registration));
  if (result.outcome === 'already') return;

  // Don't wait for the next tick for the parts the player notices right away.
  const guild = await guildFor(interaction.client, t);
  if (guild && t.captain_role_id && reg.role === 'captain') {
    await syncCaptainRole(guild, t.captain_role_id, reg as Registration, true);
  }
  if (reg.payment_status === 'unpaid') await deliverQr(interaction.client, t, reg as Registration);

  await refreshCard(interaction.client, t, await countRoles(sql!, t.id));
  if (result.just_filled) await announceFull(interaction.client, t);
}

/** One-off heads-up in the sign-up channel when the last main slot goes. */
async function announceFull(client: Client, t: Tournament): Promise<void> {
  const channel = t.discord_channel_id
    ? await client.channels.fetch(t.discord_channel_id).catch(() => null)
    : null;
  if (channel?.isSendable()) await channel.send(texts.announceFull(t.name)).catch(() => {});
}

export const handleTournamentComponent: ComponentHandler = async (interaction, action, payload) => {
  if (!enabled) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: texts.unavailable, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  try {
    if (action === 'register') await handleRegisterButton(interaction, payload);
  } catch (error) {
    // Database down is the likely case - say so instead of the generic error.
    console.error(`Tournament ${action} failed:`, error);
    const message = { content: texts.unavailable, flags: MessageFlags.Ephemeral } as const;
    if (interaction.deferred || interaction.replied) await interaction.editReply(texts.unavailable).catch(() => {});
    else await interaction.reply(message).catch(() => {});
  }
};

// Last payload per card, so an unchanged card isn't re-edited every tick.
const renderedCards = new Map<number, string>();

const postsOf = (tournamentId: string) => sql!<Post[]>`
  select p.*, c.discord_channel_id as community_channel_id
  from tournament_post p left join community c on c.id = p.community_id
  where p.tournament_id = ${tournamentId} order by p.id`;

/** Brings every posted card of the tournament up to date. */
async function refreshCard(client: Client, t: Tournament, counts: RoleCounts, posts?: Post[]): Promise<void> {
  for (const post of posts ?? (await postsOf(t.id))) {
    if (!post.channel_id || !post.message_id) continue;
    const payload = renderCard(t, counts, post.posted_at ?? new Date());
    const key = JSON.stringify(payload);
    if (renderedCards.get(post.id) === key) continue;

    const channel = await client.channels.fetch(post.channel_id).catch(() => null);
    const message = channel?.isTextBased() ? await channel.messages.fetch(post.message_id).catch(() => null) : null;
    if (!message) continue;
    try {
      await message.edit(payload);
      if (post.error) await sql!`update tournament_post set error = null where id = ${post.id}`;
    } catch (error) {
      // Discord refused the organizer's edit (a broken image link, say): the old card stays, the desk says why.
      await postFailed(t, post, error instanceof Error ? error.message : 'Úprava selhala.');
    }
    // Either way not retried until the card changes again.
    renderedCards.set(post.id, key);
  }
}

/**
 * Why a card is not up (or not up to date), for the organizer's desk. Written
 * only when it changes, so a card that keeps failing logs once, not every tick.
 */
async function postFailed(t: Tournament, post: Post, reason: string): Promise<void> {
  if (post.error === reason) return;
  post.error = reason;
  await sql!`update tournament_post set error = ${reason} where id = ${post.id}`;
  console.warn(`Tournament "${t.name}" card ${post.id}: ${reason}`);
}

async function publish(client: Client, t: Tournament, post: Post): Promise<void> {
  const target = post.channel_id ?? post.community_channel_id;
  if (!target) return postFailed(t, post, 'Komunita nemá vybraný kanál.');
  const channel = await client.channels.fetch(target).catch(() => null);
  if (!channel || channel.isDMBased()) return postFailed(t, post, 'Kanál neexistuje nebo bot už na tom serveru není.');
  if (!channel.isSendable()) return postFailed(t, post, 'Bot do toho kanálu nemůže psát.');

  try {
    await postCard(t, post, channel as GuildTextBasedChannel);
  } catch (error) {
    // Missing Permissions is the usual one: the channel changed after it was picked.
    return postFailed(t, post, error instanceof Error ? error.message : 'Odeslání selhalo.');
  }
}

/**
 * The card itself - in the channel publish() checked. The first card posted
 * also becomes the tournament's own: its server gets the captain role, its
 * channel the "looking for a team" posts.
 * ponytail: one captain role, on the first card's server only; per-server roles if organizers need them.
 */
async function postCard(t: Tournament, post: Post, channel: GuildTextBasedChannel): Promise<void> {
  // Role first and saved straight away, so a crash can't leave one untracked.
  // ponytail: a crash between create and save still orphans the role; delete it by hand if it ever happens.
  if (!t.captain_role_id && t.team_formation === 'captains') {
    const role = await channel.guild.roles.create({ name: captainRoleName, reason: `Tournament: ${t.name}` });
    await sql!`update tournament set captain_role_id = ${role.id}, discord_guild_id = ${channel.guild.id} where id = ${t.id}`;
    t.captain_role_id = role.id;
    t.discord_guild_id = channel.guild.id;
  }

  const postedAt = new Date();
  const message = await channel.send(renderCard(t, await countRoles(sql!, t.id), postedAt));
  await sql!`
    update tournament_post
    set guild_id = ${channel.guild.id}, channel_id = ${channel.id}, message_id = ${message.id}, posted_at = ${postedAt}, error = null
    where id = ${post.id}`;
  if (!t.discord_message_id) {
    await sql!`
      update tournament
      set discord_channel_id = ${channel.id}, discord_message_id = ${message.id},
        discord_guild_id = case when captain_role_id is null then ${channel.guild.id} else discord_guild_id end
      where id = ${t.id} and discord_message_id is null`;
    t.discord_channel_id = channel.id;
    t.discord_message_id = message.id;
  }
}

/** Tournament over: retire the cards and delete the captain role. */
async function archive(client: Client, t: Tournament, posts: Post[]): Promise<void> {
  await refreshCard(client, t, await countRoles(sql!, t.id), posts).catch(() => {});

  if (!t.captain_role_id) return;
  const guild = await guildFor(client, t);
  if (!guild) return; // Bot not in that server any more; retried next tick.
  await guild.roles.delete(t.captain_role_id!, `Tournament closed: ${t.name}`).catch((error: unknown) => {
    // Already deleted by hand is fine; anything else is retried next tick.
    if ((error as { code?: number }).code !== 10011) throw error;
  });
  await sql!.begin(async (tx) => {
    await tx`update tournament set captain_role_id = null where id = ${t.id}`;
    await tx`update registration set has_captain_role = false where tournament_id = ${t.id}`;
  });
  for (const post of posts) renderedCards.delete(post.id);
}

/** "Payment confirmed" DM, once. Claim-first like the QR. */
async function deliverPaidNote(client: Client, t: Tournament, reg: Registration): Promise<void> {
  const claimed = await sql!`
    update registration set paid_notified_at = now()
    where id = ${reg.id} and paid_notified_at is null returning id`;
  if (claimed.length === 0) return;
  try {
    const user = await client.users.fetch(reg.discord_id);
    await user.send(texts.paidConfirmed(t.name, t.entry_fee_czk));
  } catch (error) {
    console.warn(`Payment note DM to ${reg.discord_id} failed:`, error instanceof Error ? error.message : error);
  }
}

type TeamSearch = {
  id: string;
  discord_id: string;
  note: string | null;
  discord_message_id: string | null;
  removed_at: Date | null;
  t: Tournament;
};

/** Mirrors "looking for a team" posts: post new ones, delete withdrawn ones. */
async function syncTeamSearches(client: Client): Promise<void> {
  const rows = await sql!<TeamSearch[]>`
    select s.id, s.discord_id, s.note, s.discord_message_id, s.removed_at, to_jsonb(t) as t
    from team_search s join tournament t on t.id = s.tournament_id
    where (s.removed_at is null and s.discord_message_id is null and t.status = 'open' and t.discord_channel_id is not null)
       or (s.discord_message_id is not null and (s.removed_at is not null or t.status <> 'open'))`;

  for (const row of rows) {
    const channel = await client.channels.fetch(row.t.discord_channel_id!).catch(() => null);
    if (!channel?.isSendable() || !channel.isTextBased()) continue;

    if (row.discord_message_id) {
      await channel.messages.delete(row.discord_message_id).catch(() => {});
      await sql!`update team_search set discord_message_id = null,
        removed_at = coalesce(removed_at, now()) where id = ${row.id}`;
      continue;
    }
    // Claim first, so two ticks never post the same search twice.
    const claimed = await sql!`update team_search set discord_message_id = 'posting'
      where id = ${row.id} and discord_message_id is null returning id`;
    if (claimed.length === 0) continue;
    try {
      const message = await channel.send({
        content: texts.lookingForTeam(row.discord_id, row.t.name, row.note),
        allowedMentions: { users: [] },
      });
      await sql!`update team_search set discord_message_id = ${message.id} where id = ${row.id}`;
    } catch (error) {
      await sql!`update team_search set discord_message_id = null where id = ${row.id}`;
      throw error;
    }
  }
}

async function sync(client: Client): Promise<void> {
  // Private tournaments are reachable by link only - no card in the channel.
  const tournaments = await sql!<Tournament[]>`
    select t.*, g.name as game_name
    from tournament t
    left join game g on g.id = t.game_id
    where (t.status <> 'finished' and t.visibility = 'public') or t.captain_role_id is not null`;

  for (const t of tournaments) {
    try {
      const posts = await postsOf(t.id);
      if (t.status === 'finished') {
        await archive(client, t, posts);
        continue;
      }
      // A card for each community it was announced in - new ones only while sign-ups are open.
      if (t.status === 'open') {
        for (const post of posts) if (!post.message_id) await publish(client, t, post);
      }
      await refreshCard(client, t, await countRoles(sql!, t.id), posts);
    } catch (error) {
      console.error(`Tournament sync for "${t.name}" failed:`, error);
    }
  }

  // Role changes and promotions made on the website.
  const roleChanges = await sql!<(Registration & { wants: boolean; t: Tournament })[]>`
    select r.*, (r.role = 'captain' and r.removed_at is null) as wants, to_jsonb(t) as t
    from registration r join tournament t on t.id = r.tournament_id
    where t.status <> 'finished' and t.captain_role_id is not null
      and r.has_captain_role <> (r.role = 'captain' and r.removed_at is null)`;
  for (const row of roleChanges) {
    const guild = await guildFor(client, row.t);
    if (guild) await syncCaptainRole(guild, row.t.captain_role_id!, row, row.wants);
  }

  const pendingQrs = await sql!<(Registration & { t: Tournament })[]>`
    select r.*, to_jsonb(t) as t
    from registration r join tournament t on t.id = r.tournament_id
    where t.status <> 'finished' and t.entry_fee_czk is not null
      and r.payment_status = 'unpaid' and r.qr_sent_at is null and r.removed_at is null`;
  for (const row of pendingQrs) await deliverQr(client, row.t, row);

  const confirmed = await sql!<(Registration & { t: Tournament })[]>`
    select r.*, to_jsonb(t) as t
    from registration r join tournament t on t.id = r.tournament_id
    where r.payment_status = 'paid' and r.paid_notified_at is null and r.removed_at is null`;
  for (const row of confirmed) await deliverPaidNote(client, row.t, row);

  await syncTeamSearches(client).catch((error: unknown) => console.error('Team search sync failed:', error));
}

if (enabled) {
  registerTask({ name: 'Tournament sync', intervalMs: 15_000, run: sync, database: true });
}
