import type { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { anyVoiceHubs } from '../config.ts';
import * as season from './season.ts';
import * as deleteSeason from './deleteSeason.ts';
import * as mapRotation from './mapRotation.ts';
import * as create from './create.ts';
import * as lfg from './lfg.ts';
import * as status from './status.ts';
import * as predator from './predator.ts';
import * as room from './room.ts';
import * as join from './join.ts';

export type Command = {
  // Structural, so both plain-option and subcommand builders fit.
  data: Pick<SlashCommandBuilder, 'name' | 'toJSON'>;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
};

/** Add new commands here — both the client and the deploy script read this. */
export const commands: Command[] = [
  season,
  deleteSeason,
  mapRotation,
  create,
  lfg,
  status,
  predator,
  // No hubs configured means no rooms exist to manage, so don't offer the
  // commands at all rather than have them always answer "you're not in a room".
  ...(anyVoiceHubs ? [room, join] : []),
];

export const commandsByName = new Map(
  commands.map((command) => [command.data.name, command]),
);
