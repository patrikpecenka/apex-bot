/**
 * One-shot post of a message from `content/messages.json`, for when the bot
 * isn't running or you'd rather not use `/create`:
 *
 *   npm run post -- rules              # uses the entry's own channelId
 *   npm run post -- rules <channelId>  # overrides it
 *
 * Always posts a new message. Use `/create` for the post-or-edit behaviour —
 * only that path records the message id.
 */

import { Client, GatewayIntentBits } from 'discord.js';
import { token } from './config.ts';
import { getMessageDefinition, renderMessage } from './messages.ts';

const [key, channelOverride] = process.argv.slice(2);

if (!key) {
  console.error('Usage: npm run post -- <key> [channelId]');
  process.exit(1);
}

const definition = await getMessageDefinition(key);
const targetId = channelOverride ?? definition.channelId;

if (!targetId) {
  console.error(`"${key}" has no channelId — pass one as the second argument.`);
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(token);

const channel = await client.channels.fetch(targetId);
if (!channel?.isSendable()) {
  console.error(`Channel ${targetId} is missing or cannot be posted in.`);
  await client.destroy();
  process.exit(1);
}

const { payload, warnings } = await renderMessage(client, key, definition);
for (const warning of warnings) console.warn(`Warning: ${warning}`);

const message = await channel.send(payload);
console.log(`Posted ${key}: ${message.url}`);

await client.destroy();
