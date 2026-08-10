/**
 * Shared guild-command registration, used by both the deploy script and the
 * live GuildCreate handler in index.ts (so a server that adds the bot gets
 * commands instantly, without waiting for a restart).
 */

import { REST, Routes } from 'discord.js';
import { token } from './config.ts';
import { commands } from './commands/registry.ts';

type PartialApp = { id: string };
type PartialGuild = { id: string; name: string };

const rest = new REST().setToken(token);
const body = commands.map((command) => command.data.toJSON());

let appId: string | null = null;
async function getAppId(): Promise<string> {
  if (!appId) {
    const app = (await rest.get(Routes.currentApplication())) as PartialApp;
    appId = app.id;
  }
  return appId;
}

/** Every guild the bot is currently in. */
export async function currentGuildIds(): Promise<string[]> {
  const guilds = (await rest.get(Routes.userGuilds())) as PartialGuild[];
  return guilds.map((guild) => guild.id);
}

/** Registers the current command set to a single guild — instant, unlike global. */
export async function registerCommandsToGuild(guildId: string): Promise<void> {
  const id = await getAppId();
  try {
    await rest.put(Routes.applicationGuildCommands(id, guildId), { body });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Missing Access')) {
      throw new Error(
        `Missing Access on ${guildId} — the bot was invited without the applications.commands scope.\n` +
          'Re-invite it with that scope (the existing bot stays put, nothing is lost).',
      );
    }
    throw error;
  }
}

export const commandNames = body.map((command) => `/${command.name}`);
