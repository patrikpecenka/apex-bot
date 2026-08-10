/**
 * Registers slash commands with Discord. Run this once, and again whenever a
 * command's name, description, or options change:
 *
 *   npm run deploy
 *
 * Registers to every guild the bot is currently in — instant, and requires no
 * manual list to keep in sync as the bot joins more servers. Guilds joined
 * between restarts are covered live by the GuildCreate handler in index.ts.
 * Set GUILD_ID (comma-separated for more than one) to target specific guilds
 * instead, e.g. for a dev/test bot that should stay out of other servers.
 */

import { commandNames, currentGuildIds, registerCommandsToGuild } from './commandDeploy.ts';

const overrideIds = (process.env.GUILD_ID ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const guildIds = overrideIds.length > 0 ? overrideIds : await currentGuildIds();

if (guildIds.length === 0) {
  console.log('Bot is not in any servers yet — nothing to register.');
  process.exit(0);
}

let failed = false;
for (const guildId of guildIds) {
  try {
    await registerCommandsToGuild(guildId);
    console.log(`Registered ${commandNames.length} command(s) to ${guildId}: ${commandNames.join(', ')}`);
  } catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : error);
  }
}

if (failed) process.exit(1);
