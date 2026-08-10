/**
 * Registers slash commands with Discord. Run this once, and again whenever a
 * command's name, description, or options change:
 *
 *   npm run deploy
 *
 * Registers to a single guild (instant) rather than globally (up to an hour).
 * Uses GUILD_ID if set, otherwise auto-detects when the bot is in one server.
 */

import { REST, Routes } from 'discord.js';
import { token } from './config.ts';
import { commands } from './commands/registry.ts';

type PartialApp = { id: string };
type PartialGuild = { id: string; name: string };

const rest = new REST().setToken(token);

const app = (await rest.get(Routes.currentApplication())) as PartialApp;

let guildId = process.env.GUILD_ID ?? '';
if (!guildId) {
  const guilds = (await rest.get(Routes.userGuilds())) as PartialGuild[];
  if (guilds.length !== 1) {
    console.error(
      `Bot is in ${guilds.length} servers. Set GUILD_ID in .env to pick one:\n` +
        guilds.map((g) => `  ${g.id}  ${g.name}`).join('\n'),
    );
    process.exit(1);
  }
  guildId = guilds[0]!.id;
  console.log(`Using ${guilds[0]!.name} (${guildId})`);
}

const body = commands.map((command) => command.data.toJSON());

try {
  await rest.put(Routes.applicationGuildCommands(app.id, guildId), { body });
  console.log(`Registered ${body.length} command(s): ${body.map((c) => `/${c.name}`).join(', ')}`);
} catch (error) {
  if (error instanceof Error && error.message.includes('Missing Access')) {
    console.error(
      'Missing Access — the bot was invited without the applications.commands scope.\n' +
        'Re-invite it with that scope (the existing bot stays put, nothing is lost).',
    );
    process.exit(1);
  }
  throw error;
}
