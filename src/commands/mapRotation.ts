import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextBasedChannel,
} from 'discord.js';
import { buildMapRotationMessage, fetchMapRotation } from '../mapRotation.ts';
import {
  clearMapRotationMessage,
  getMapRotationMessage,
  setMapRotationMessage,
} from '../mapRotationStore.ts';
import { hasTrustedRole } from '../permissions.ts';

export const data = new SlashCommandBuilder()
  .setName('maprotation')
  .setDescription('Live-updating Apex Legends map rotation message')
  .addSubcommand((sub) =>
    sub
      .setName('post')
      .setDescription('Post the live map rotation message')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Where to post it (defaults to this channel)')
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) => sub.setName('stop').setDescription('Remove the live map rotation message'))
  // Hides the command from everyone without Administrator. Server admins can
  // override this in Server Settings -> Integrations, so execute() re-checks.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: 'This command only works inside a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { guild, member } = interaction;

  if (!hasTrustedRole(member)) {
    await interaction.reply({
      content: 'Only members with the Owner or Admin role can manage the map rotation message.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'stop') {
    const existing = await getMapRotationMessage(guild.id);
    if (!existing) {
      await interaction.reply({
        content: 'No live map rotation message is posted.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = await guild.channels.fetch(existing.channelId).catch(() => null);
    if (channel?.isTextBased()) {
      const message = await channel.messages.fetch(existing.messageId).catch(() => null);
      await message?.delete().catch(() => {});
    }
    await clearMapRotationMessage(guild.id);

    await interaction.reply({ content: 'Map rotation message removed.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // One live message at a time — if the tracked one is still there, point at
  // it instead of creating a second. If it's gone (deleted by hand), the slot
  // is free again, so clear the stale record and fall through to posting.
  const existing = await getMapRotationMessage(guild.id);
  if (existing) {
    const channel = await guild.channels.fetch(existing.channelId).catch(() => null);
    const message = channel?.isTextBased()
      ? await channel.messages.fetch(existing.messageId).catch(() => null)
      : null;
    if (message) {
      await interaction.editReply(
        `A map rotation message is already live: ${message.url}\nRun \`/maprotation stop\` first to move it.`,
      );
      return;
    }
    await clearMapRotationMessage(guild.id);
  }

  const targetChannel = (interaction.options.getChannel('channel') ?? interaction.channel) as TextBasedChannel;
  if (!targetChannel?.isSendable()) {
    await interaction.editReply('I cannot post in that channel.');
    return;
  }

  try {
    const rotation = await fetchMapRotation();
    const rendered = await buildMapRotationMessage(rotation, Date.now());
    const message = await targetChannel.send(rendered);
    await setMapRotationMessage(guild.id, { channelId: message.channelId, messageId: message.id });
    await interaction.editReply(`Posted: ${message.url}`);
  } catch (error) {
    await interaction.editReply(
      `Failed to post the map rotation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
