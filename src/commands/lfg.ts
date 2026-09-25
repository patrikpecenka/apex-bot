/**
 * `/lfg` — posts a squad card in the LFG channel with Join / Leave / Close
 * buttons, so finding two more for a trio doesn't need a thread of freeform
 * "anyone PC?" messages.
 *
 * Deliberately open to everyone (no role gate): this is the member-facing half
 * of the bot. Spam is held down by one live card per person at a time.
 */

import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
} from 'discord.js';
import {
  activePostFor,
  lifetimeMs,
  platformRole,
  platforms,
  renderLfgPost,
  savePost,
  squadSize,
  type LfgPost,
} from '../lfg.ts';
import { defaultChannels } from '../config.ts';

export const data = new SlashCommandBuilder()
  .setName('lfg')
  .setDescription('Look for players to fill your squad')
  .addIntegerOption((option) =>
    option
      .setName('players')
      .setDescription('How many more players you need')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(squadSize - 1),
  )
  .addStringOption((option) =>
    option
      .setName('platform')
      .setDescription('Which platform you play on')
      .setRequired(true)
      .addChoices(...platforms.map(({ label, value }) => ({ name: label, value }))),
  )
  .addStringOption((option) =>
    option.setName('room').setDescription('Which voice room you are waiting in').setMaxLength(100),
  )
  .addStringOption((option) =>
    option.setName('note').setDescription('Anything else — mode, rank, mic...').setMaxLength(200),
  )
  .addBooleanOption((option) =>
    option
      .setName('ping')
      .setDescription('Ping the role for your platform, if the server has one (default: no)'),
  )
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: 'Tenhle příkaz funguje jen na serveru.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { guild } = interaction;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // One live card per person: a second one would just split the same squad
  // across two posts, and it is the easiest way for the channel to fill up.
  const existing = await activePostFor(guild.id, interaction.user.id);
  if (existing) {
    await interaction.editReply(
      `Už máš vypsaný squad: https://discord.com/channels/${guild.id}/${existing.channelId}/${existing.messageId}\n` +
        'Pokud chceš vypsat nový, zavři nejdřív ten starý tlačítkem **Zavřít**.',
    );
    return;
  }

  const configured = defaultChannels.lfg
    ? await guild.channels.fetch(defaultChannels.lfg).catch(() => null)
    : null;
  const target = (configured ?? interaction.channel) as GuildTextBasedChannel | null;

  if (!target?.isSendable() || target.type === ChannelType.GuildStageVoice) {
    await interaction.editReply(
      `Nemůžu psát do ${target ? `<#${target.id}>` : 'kanálu pro hledání hráčů'} — zkontroluj mi prosím práva.`,
    );
    return;
  }

  const platformValue = interaction.options.getString('platform', true);
  const platform = platforms.find(({ value }) => value === platformValue)?.label ?? platformValue;
  const needed = interaction.options.getInteger('players', true);

  const post: LfgPost = {
    channelId: target.id,
    // Filled in below — the id only exists once Discord has the message.
    messageId: '',
    ownerId: interaction.user.id,
    platform,
    room: interaction.options.getString('room') ?? undefined,
    note: interaction.options.getString('note') ?? undefined,
    // The card fills at whatever the poster asked for: someone looking for one
    // more closes at two, not at a full trio.
    size: needed + 1,
    joined: [interaction.user.id],
    expiresAt: Date.now() + lifetimeMs,
  };

  const role = interaction.options.getBoolean('ping') ? platformRole(guild, platform) : undefined;

  try {
    const message = await target.send({
      ...renderLfgPost(post, 'open'),
      content: role ? `<@&${role.id}>` : undefined,
      allowedMentions: role ? { roles: [role.id] } : { parse: [] },
    });

    post.messageId = message.id;
    await savePost(guild.id, post);

    await interaction.editReply(`Squad vypsán v <#${target.id}>: ${message.url}`);
  } catch (error) {
    console.error('Failed to post an LFG card:', error);
    await interaction.editReply(
      `Nepovedlo se to vypsat: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
