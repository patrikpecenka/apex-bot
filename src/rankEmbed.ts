import {
  EmbedBuilder,
  type Guild,
  type GuildEmoji,
  type Message,
  type Role,
  type TextBasedChannel,
} from 'discord.js';
import { seasonRoleName, selfAssignTiers } from './seasonRoles.ts';
import { setRankMessage } from './rankMessageStore.ts';
import { defaultChannels } from './config.ts';

export type PruneSummary = { season: number; tiers: string[] } | null;

/** Resolves the :rankBronze: style emojis by name, erroring clearly if any are missing. */
export async function resolveRankEmojis(guild: Guild): Promise<Map<string, GuildEmoji>> {
  const all = await guild.emojis.fetch();
  const found = new Map<string, GuildEmoji>();
  const missing: string[] = [];

  for (const { emoji } of selfAssignTiers) {
    const match = all.find((candidate) => candidate.name?.toLowerCase() === emoji.toLowerCase());
    if (match) found.set(emoji, match);
    else missing.push(`:${emoji}:`);
  }

  if (missing.length > 0) {
    throw new Error(`Missing server emoji: ${missing.join(', ')}`);
  }
  return found;
}

function pruneSentence(prune: PruneSummary): string | null {
  if (!prune) return null;
  const tiers = prune.tiers.map((tier) => tier.toLowerCase());
  const range =
    tiers.length > 1 ? `${tiers[0]} - ${tiers[tiers.length - 1]}` : tiers[0];
  return (
    `Z důvodu nedostatku místa pro role, bylo třeba umazat role ze season ${prune.season} ` +
    `(${range}). Diamond, Master a Apex Predator zůstávají přiřazeny.`
  );
}

export const rankEmbedColor = 0xed4245;

/** The wording of the announcement, kept in one place. */
export function rankTexts(
  season: number,
  prune: PruneSummary,
): { title: string; description: string } {
  // Links the channel when RANK_CHECK_CHANNEL_ID is configured, otherwise falls
  // back to plain text rather than pointing at the wrong channel.
  const rankCheck = defaultChannels.rankCheck ? `<#${defaultChannels.rankCheck}>` : '#rank-check';

  const lines = [
    `Vyber svůj aktuální rank pro season ${season}`,
    `Pokud máš rank Apex Predator nebo Master, nahraj screenshot do ${rankCheck}`,
  ];

  const prunedNote = pruneSentence(prune);
  if (prunedNote) lines.push('', prunedNote);

  return {
    title: `Season update - Season ${season}`,
    description: lines.join('\n'),
  };
}

export function buildRankEmbed(season: number, prune: PruneSummary): EmbedBuilder {
  const { title, description } = rankTexts(season, prune);
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(rankEmbedColor);
}

export const seasonStartEmbedColor = 0x57f287;

/** Posted to the rank-check room announcing that verification is open for the new season. */
export function buildSeasonStartEmbed(season: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`↓ ↓ ↓  -----  Season ${season} starts here  -----  ↓ ↓ ↓`)
    .setDescription(
      [
        'Room pouze pro ověření APEX PREDATOR A MASTER',
        '',
        `Ostatní ranky můžete přiřadit svépomocí v roomce <#${defaultChannels.rankPicker}>`,
      ].join('\n'),
    )
    .setColor(seasonStartEmbedColor);
}

/** Posts the season-start notice to the rank-check room. */
export async function postSeasonStartNotice(
  channel: TextBasedChannel,
  season: number,
): Promise<Message> {
  if (!channel.isSendable()) {
    throw new Error('I cannot post in that channel.');
  }
  return channel.send({ embeds: [buildSeasonStartEmbed(season)] });
}

/**
 * Posts the picker, adds one reaction per selectable tier, and records the
 * message so reactions keep working after a restart.
 */
export async function postRankMessage(options: {
  guild: Guild;
  channel: TextBasedChannel;
  season: number;
  roles: Role[];
  prune: PruneSummary;
  ping: boolean;
}): Promise<Message> {
  const { guild, channel, season, roles, prune, ping } = options;

  if (!channel.isSendable()) {
    throw new Error('I cannot post in that channel.');
  }

  const emojis = await resolveRankEmojis(guild);

  const roleByEmoji = new Map<string, Role>();
  for (const { tier, emoji } of selfAssignTiers) {
    const wanted = seasonRoleName(season, tier);
    const role = roles.find((candidate) => candidate.name === wanted);
    if (!role) throw new Error(`Missing role ${wanted}`);
    roleByEmoji.set(emojis.get(emoji)!.id, role);
  }

  const message = await channel.send({
    content: ping ? '@everyone' : undefined,
    embeds: [buildRankEmbed(season, prune)],
    allowedMentions: { parse: ping ? ['everyone'] : [] },
  });

  // Sequential so the reactions land in tier order rather than racing.
  for (const { emoji } of selfAssignTiers) {
    await message.react(emojis.get(emoji)!);
  }

  await setRankMessage(guild.id, {
    season,
    channelId: message.channelId,
    messageId: message.id,
    roles: Object.fromEntries(
      [...roleByEmoji.entries()].map(([emojiId, role]) => [emojiId, role.id]),
    ),
  });

  return message;
}

/** Marks a superseded picker as closed so users can see it's no longer live. */
export async function closeRankMessage(
  guild: Guild,
  previous: { channelId: string; messageId: string; season: number },
): Promise<void> {
  const channel = await guild.channels.fetch(previous.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const message = await channel.messages.fetch(previous.messageId).catch(() => null);
  if (!message) return;

  const embed = EmbedBuilder.from(message.embeds[0] ?? {})
    .setColor(0x4f545c)
    .setFooter({ text: `Season ${previous.season} uzavřena — role už nelze přiřadit.` });

  await message.edit({ embeds: [embed] }).catch(() => {});
  await message.reactions.removeAll().catch(() => {});
}
