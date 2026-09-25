/**
 * Routes button / menu clicks to the feature that owns them, the same way
 * commands/registry.ts routes slash commands.
 *
 * Add a feature here and its buttons work; anything unrecognised gets a polite
 * ephemeral instead of a silent dead click.
 */

import {
  MessageFlags,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { parseComponentId, type ComponentHandler } from './ids.ts';
import { handleLfgButton } from '../lfg.ts';
import { handleTournamentComponent } from '../tournamentSignup.ts';

/** Feature prefix -> handler. */
export const componentHandlers = new Map<string, ComponentHandler>([
  ['lfg', handleLfgButton],
  ['tournament', handleTournamentComponent],
]);

export async function handleComponent(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
): Promise<void> {
  const { feature, action, payload } = parseComponentId(interaction.customId);
  const handler = componentHandlers.get(feature);

  if (!handler) {
    console.warn(`Unhandled component id: ${interaction.customId}`);
    await interaction
      .reply({ content: 'Tahle zpráva už není aktivní.', flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  await handler(interaction, action, payload);
}
