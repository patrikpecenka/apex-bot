import type { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import * as season from './season.ts';
import * as deleteSeason from './deleteSeason.ts';

export type Command = {
  // Structural, so both plain-option and subcommand builders fit.
  data: Pick<SlashCommandBuilder, 'name' | 'toJSON'>;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
};

/** Add new commands here — both the client and the deploy script read this. */
export const commands: Command[] = [season, deleteSeason];

export const commandsByName = new Map(
  commands.map((command) => [command.data.name, command]),
);
