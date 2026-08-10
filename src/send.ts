/**
 * One-shot send: logs in, posts a message, exits.
 *
 *   npm run send -- "hello from the bot"
 *   npm run send -- "hello" <channelId>   # overrides CHANNEL_ID
 */

import { Client, GatewayIntentBits } from 'discord.js';
import { defaultChannels, token } from './config.ts';

const [content = 'Test message from the bot', targetId = defaultChannels.general] =
  process.argv.slice(2);

if (!targetId) {
  console.error('No channel given. Set CHANNEL_ID in .env or pass it as the second argument.');
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

const message = await channel.send(content);
console.log(`Sent: ${message.url}`);

await client.destroy();
