/**
 * `/predator post|stop` — the live Apex Predator cutoff message.
 *
 * Mirrors /maprotation: one live message per guild, admin-gated, and a stale
 * record (message deleted by hand) frees the slot instead of blocking it.
 */

import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextBasedChannel,
} from 'discord.js';
import { buildPredatorMessage, fetchPredator, predatorStore } from '../predator.ts';
import { defaultChannels } from '../config.ts';
import { hasTrustedRole } from '../permissions.ts';

export const data = new SlashCommandBuilder()
  .setName('predator')
  .setDescription('Live-updating Apex Predator cutoff message')
  .addSubcommand((sub) =>
    sub
      .setName('post')
      .setDescription('Post the live predator cutoff message')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Where to post it (defaults to this channel)')
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('stop').setDescription('Remove the live predator cutoff message'),
  )
  // Hides the command from everyone without Administrator. Server admins can
  // override this in Server Settings -> Integrations, so execute() re-checks.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: 'Tenhle příkaz funguje jen na serveru.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { guild, member } = interaction;

  if (!hasTrustedRole(member)) {
    await interaction.reply({
      content: 'Spravovat zprávu s hranicí pro predátora můžou jen členové s rolí Owner nebo Admin.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.options.getSubcommand() === 'stop') {
    const existing = await predatorStore.get(guild.id);
    if (!existing) {
      await interaction.reply({
        content: 'Žádná živá zpráva s hranicí pro predátora není vypsaná.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = await guild.channels.fetch(existing.channelId).catch(() => null);
    if (channel?.isTextBased()) {
      const message = await channel.messages.fetch(existing.messageId).catch(() => null);
      await message?.delete().catch(() => {});
    }
    await predatorStore.remove(guild.id);

    await interaction.reply({
      content: 'Zpráva s hranicí pro predátora byla odstraněna.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // One live message at a time — if the tracked one is still there, point at
  // it. If it's gone, the slot is free again: clear it and post a new one.
  const existing = await predatorStore.get(guild.id);
  if (existing) {
    const channel = await guild.channels.fetch(existing.channelId).catch(() => null);
    const message = channel?.isTextBased()
      ? await channel.messages.fetch(existing.messageId).catch(() => null)
      : null;
    if (message) {
      await interaction.editReply(
        `Zpráva s hranicí pro predátora už běží: ${message.url}\nPokud ji chceš přesunout, spusť nejdřív \`/predator stop\`.`,
      );
      return;
    }
    await predatorStore.remove(guild.id);
  }

  const configured = defaultChannels.predator
    ? await guild.channels.fetch(defaultChannels.predator).catch(() => null)
    : null;
  const targetChannel = (interaction.options.getChannel('channel') ??
    configured ??
    interaction.channel) as TextBasedChannel | null;

  if (!targetChannel?.isSendable()) {
    await interaction.editReply('Do tohohle kanálu psát nemůžu.');
    return;
  }

  try {
    const rendered = buildPredatorMessage(await fetchPredator(), Date.now());
    const message = await targetChannel.send(rendered);
    await predatorStore.set(guild.id, { channelId: message.channelId, messageId: message.id });
    await interaction.editReply(`Vypsáno: ${message.url}`);
  } catch (error) {
    await interaction.editReply(
      `Nepovedlo se vypsat hranici pro predátora: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
