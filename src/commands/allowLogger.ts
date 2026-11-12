/**
 * `/allow-logger true|false` — turns the message log for this server on or off.
 * Owner only: it records everything everyone writes.
 */

import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { loggerStore } from '../messageLogger.ts';
import { hasOwnerRole } from '../permissions.ts';

export const data = new SlashCommandBuilder()
  .setName('allow-logger')
  .setDescription('Log every message in this server to a file')
  .addBooleanOption((option) =>
    option.setName('enabled').setDescription('true = start logging, false = stop').setRequired(true),
  )
  // Hidden from non-admins; execute() re-checks since admins can override this.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: 'Tenhle příkaz funguje jen na serveru.', flags: MessageFlags.Ephemeral });
    return;
  }

  const { guild, member } = interaction;
  if (member.id !== guild.ownerId && !hasOwnerRole(member)) {
    await interaction.reply({
      content: 'Logování zpráv může zapnout jen majitel serveru nebo role Owner.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const enabled = interaction.options.getBoolean('enabled', true);
  if (enabled) await loggerStore.set(guild.id, true);
  else await loggerStore.remove(guild.id);

  await interaction.reply({
    content: enabled ? 'Logování zpráv zapnuto.' : 'Logování zpráv vypnuto.',
    flags: MessageFlags.Ephemeral,
  });
}
