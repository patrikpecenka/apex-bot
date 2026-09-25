/**
 * `/status` — answers the question that gets asked every time a match won't
 * start. Public reply on purpose: everyone in the channel is wondering.
 */

import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { buildServerStatusEmbed, fetchServerStatus } from '../apexStatus.ts';

export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Check whether the Apex Legends servers are up')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  try {
    const embed = buildServerStatusEmbed(await fetchServerStatus());
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('/status failed:', error);
    await interaction.editReply({
      content: `Nepodařilo se spojit s Apex API: ${
        error instanceof Error ? error.message : String(error)
      }`,
      flags: MessageFlags.SuppressEmbeds,
    });
  }
}
