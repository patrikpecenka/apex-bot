/**
 * Registers slash commands with Discord. Run this once, and again whenever a
 * command's name, description, or options change:
 *
 *   npm run deploy
 *
 * With GUILD_ID set (comma-separate for more than one), registers to just
 * those guilds — instant, ideal for a dev/test bot iterating fast. With
 * GUILD_ID unset, registers globally instead: Discord pushes the commands to
 * every server the bot is in, including ones it joins later, so this scales
 * to any number of servers with zero per-server config. Global propagation
 * can take up to an hour (usually much faster), versus instant for guilds.
 */

import { REST, Routes } from 'discord.js';
import { token } from './config.ts';
import { commands } from './commands/registry.ts';

type PartialApp = { id: string };

const rest = new REST().setToken(token);

const app = (await rest.get(Routes.currentApplication())) as PartialApp;

const guildIds = (process.env.GUILD_ID ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const body = commands.map((command) => command.data.toJSON());

async function register(guildId: string | null): Promise<void> {
  const route = guildId
    ? Routes.applicationGuildCommands(app.id, guildId)
    : Routes.applicationCommands(app.id);
  try {
    await rest.put(route, { body });
    console.log(
      `Registered ${body.length} command(s) ${guildId ? `to ${guildId}` : 'globally'}: ${body
        .map((c) => `/${c.name}`)
        .join(', ')}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('Missing Access')) {
      throw new Error(
        `Missing Access${guildId ? ` on ${guildId}` : ''} — the bot was invited without the applications.commands scope.\n` +
          'Re-invite it with that scope (the existing bot stays put, nothing is lost).',
      );
    }
    throw error;
  }
}

const targets = guildIds.length > 0 ? guildIds : [null];

let failed = false;
for (const guildId of targets) {
  try {
    await register(guildId);
  } catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : error);
  }
}

if (failed) process.exit(1);
