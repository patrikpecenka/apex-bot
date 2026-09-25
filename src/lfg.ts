/**
 * Squad finder. `/lfg` posts a card in the LFG channel, and the Join / Leave /
 * Close buttons on it keep the roster up to date.
 *
 * All state lives in `data/lfgPosts.json`, keyed by message - deliberately not
 * in a component collector, because collectors die with the process and this
 * bot restarts often. A card posted before a restart keeps working after it.
 *
 * User-facing wording is collected in `texts` so translating the feature later
 * is a single-object edit.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Guild,
  type BaseMessageOptions,
} from 'discord.js';
import { createJsonStore } from './jsonStore.ts';
import { componentId, type ComponentHandler } from './components/ids.ts';
import { hasTrustedRole } from './permissions.ts';
import { registerTask } from './liveMessages.ts';

/** A full Apex squad. The poster is always one of the three. */
export const squadSize = 3;

/** How long a card stays joinable before the sweep retires it. */
export const lifetimeMs = 60 * 60 * 1000;

export const platforms = [
  { label: 'PC', value: 'pc' },
  { label: 'PlayStation', value: 'playstation' },
  { label: 'Xbox', value: 'xbox' },
] as const;

export type LfgPost = {
  channelId: string;
  messageId: string;
  ownerId: string;
  /** Display label, e.g. "PlayStation". */
  platform: string;
  room?: string;
  note?: string;
  /** How many people the squad holds in total, the poster included. */
  size: number;
  /** User ids, owner first. */
  joined: string[];
  /** Epoch ms. */
  expiresAt: number;
};

const store = createJsonStore<LfgPost>('lfgPosts.json');

const key = (guildId: string, messageId: string) => `${guildId}:${messageId}`;

/** 1 hráče, 2 hráče, ... 5 hráčů. */
function players(count: number): string {
  return count < 5 ? `${count} hráče` : `${count} hráčů`;
}

const texts = {
  title: (open: number, platform: string) => `Hledám ${players(open)} — ${platform}`,
  full: (platform: string) => `Squad je plný — ${platform}`,
  closed: 'Squad zavřený',
  expired: 'Squad vypršel',
  squad: 'Squad',
  room: 'Roomka',
  note: 'Poznámka',
  expires: 'Vyprší',
  join: 'Přidat se',
  leave: 'Odejít',
  close: 'Zavřít',
  footer: 'Tlačítka fungují i po restartu bota.',
  alreadyIn: 'V tomhle squadu už jsi.',
  notIn: 'V tomhle squadu nejsi.',
  isFull: 'Tenhle squad je už plný.',
  gone: 'Tenhle příspěvek už není aktivní.',
  ownerLeft: 'Odchodem jsi squad zavřel.',
  notYours: 'Zavřít ho může jen ten, kdo ho vypsal (nebo moderátor).',
  joinedDm: (name: string, url: string) => `**${name}** se přidal do tvého squadu: ${url}`,
} as const;

const openColor = 0xf9a01b;
const fullColor = 0x2ecc71;
const doneColor = 0x4f545c;

type PostState = 'open' | 'full' | 'closed' | 'expired';

function stateOf(post: LfgPost, now = Date.now()): PostState {
  if (post.expiresAt <= now) return 'expired';
  return post.joined.length >= post.size ? 'full' : 'open';
}

/** The card itself. Used by the command, the buttons and the expiry sweep. */
export function renderLfgPost(post: LfgPost, state: PostState): BaseMessageOptions {
  const open = Math.max(0, post.size - post.joined.length);
  const done = state === 'closed' || state === 'expired';

  const embed = new EmbedBuilder()
    .setColor(done ? doneColor : state === 'full' ? fullColor : openColor)
    .setTitle(
      state === 'closed'
        ? texts.closed
        : state === 'expired'
          ? texts.expired
          : state === 'full'
            ? texts.full(post.platform)
            : texts.title(open, post.platform),
    )
    .addFields({
      name: `${texts.squad} ${post.joined.length}/${post.size}`,
      value: post.joined.map((id) => `<@${id}>`).join('\n'),
    });

  if (post.room) embed.addFields({ name: texts.room, value: post.room, inline: true });
  if (post.note) embed.addFields({ name: texts.note, value: post.note, inline: true });
  if (!done) {
    embed.addFields({
      name: texts.expires,
      // Rendered client-side, so the countdown stays right without us editing.
      value: `<t:${Math.floor(post.expiresAt / 1000)}:R>`,
      inline: true,
    });
    embed.setFooter({ text: texts.footer });
  }

  const disabled = done || state === 'full';
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId('lfg', 'join'))
      .setLabel(texts.join)
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(componentId('lfg', 'leave'))
      .setLabel(texts.leave)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(done),
    new ButtonBuilder()
      .setCustomId(componentId('lfg', 'close'))
      .setLabel(texts.close)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(done),
  );

  return { embeds: [embed], components: done ? [] : [row], allowedMentions: { parse: [] } };
}

export async function savePost(guildId: string, post: LfgPost): Promise<void> {
  await store.set(key(guildId, post.messageId), post);
}

export async function getPost(guildId: string, messageId: string): Promise<LfgPost | null> {
  return store.get(key(guildId, messageId));
}

export async function dropPost(guildId: string, messageId: string): Promise<void> {
  await store.remove(key(guildId, messageId));
}

/** The caller's live post, if they already have one. One per person at a time. */
export async function activePostFor(guildId: string, userId: string): Promise<LfgPost | null> {
  const now = Date.now();
  for (const [entryKey, post] of Object.entries(await store.all())) {
    if (!entryKey.startsWith(`${guildId}:`)) continue;
    if (post.ownerId !== userId) continue;
    if (post.expiresAt <= now) continue;
    return post;
  }
  return null;
}

/** Best-effort heads-up to the poster; a closed DM is not a failure. */
async function notifyOwner(interaction: ButtonInteraction<'cached'>, post: LfgPost): Promise<void> {
  if (post.ownerId === interaction.user.id) return;
  const owner = await interaction.client.users.fetch(post.ownerId).catch(() => null);
  await owner
    ?.send(texts.joinedDm(interaction.member.displayName, interaction.message.url))
    .catch(() => {});
}

export const handleLfgButton: ComponentHandler = async (interaction, action) => {
  if (!interaction.isButton() || !interaction.inCachedGuild()) return;

  const guildId = interaction.guildId;
  const post = await getPost(guildId, interaction.message.id);

  // Nothing remembered: the store was wiped, or this card predates the feature.
  // Retire the buttons so it can't be clicked again.
  if (!post) {
    await interaction.update({ components: [] }).catch(() => {});
    await interaction.followUp({ content: texts.gone, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  const state = stateOf(post);
  if (state === 'expired') {
    await interaction.update(renderLfgPost(post, 'expired'));
    await dropPost(guildId, post.messageId);
    return;
  }

  if (action === 'join') {
    if (post.joined.includes(interaction.user.id)) {
      await interaction.reply({ content: texts.alreadyIn, flags: MessageFlags.Ephemeral });
      return;
    }
    if (post.joined.length >= post.size) {
      await interaction.reply({ content: texts.isFull, flags: MessageFlags.Ephemeral });
      return;
    }

    post.joined.push(interaction.user.id);
    await savePost(guildId, post);
    await interaction.update(renderLfgPost(post, stateOf(post)));
    await notifyOwner(interaction, post);
    return;
  }

  if (action === 'leave') {
    if (!post.joined.includes(interaction.user.id)) {
      await interaction.reply({ content: texts.notIn, flags: MessageFlags.Ephemeral });
      return;
    }

    // The owner leaving means the squad is over - there is nobody left to run it.
    if (post.ownerId === interaction.user.id) {
      await interaction.update(renderLfgPost(post, 'closed'));
      await dropPost(guildId, post.messageId);
      await interaction.followUp({ content: texts.ownerLeft, flags: MessageFlags.Ephemeral });
      return;
    }

    post.joined = post.joined.filter((id) => id !== interaction.user.id);
    await savePost(guildId, post);
    await interaction.update(renderLfgPost(post, stateOf(post)));
    return;
  }

  if (action === 'close') {
    if (post.ownerId !== interaction.user.id && !hasTrustedRole(interaction.member)) {
      await interaction.reply({ content: texts.notYours, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.update(renderLfgPost(post, 'closed'));
    await dropPost(guildId, post.messageId);
  }
};

/**
 * Retires cards once they are past their hour. Runs on the shared loop, so a
 * card posted before a restart still expires afterwards.
 */
registerTask({
  name: 'LFG expiry sweep',
  intervalMs: 60_000,
  run: async (client) => {
    const now = Date.now();
    for (const [entryKey, post] of Object.entries(await store.all())) {
      if (post.expiresAt > now) continue;

      const channel = await client.channels.fetch(post.channelId).catch(() => null);
      const message = channel?.isTextBased()
        ? await channel.messages.fetch(post.messageId).catch(() => null)
        : null;
      await message?.edit(renderLfgPost(post, 'expired')).catch(() => {});
      await store.remove(entryKey);
    }
  },
});

/** The role to ping for a platform, when the server happens to have one. */
export function platformRole(guild: Guild, platform: string) {
  return guild.roles.cache.find((role) => role.name.toLowerCase() === platform.toLowerCase());
}
