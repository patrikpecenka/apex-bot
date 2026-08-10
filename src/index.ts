import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { rankPickerEnabled, token } from './config.ts';
import { commandsByName } from './commands/registry.ts';
import { registerReactionRoles } from './reactionRoles.ts';

// Guilds is enough to see servers and their channels. Reading message text
// would additionally need the privileged MessageContent intent, which has to be
// enabled in the Developer Portal first.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],
  // Reaction events on messages posted before the last restart arrive partial;
  // without these the rank picker would only work until the bot restarts.
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

if (rankPickerEnabled) registerReactionRoles(client);

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`In ${readyClient.guilds.cache.size} server(s):`);
  for (const guild of readyClient.guilds.cache.values()) {
    console.log(`  - ${guild.name} (${guild.id})`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) {
    console.warn(`Unknown command: /${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`/${interaction.commandName} failed:`, error);
    const message = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral } as const;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(message).catch(() => {});
    } else {
      await interaction.reply(message).catch(() => {});
    }
  }
});

client.on(Events.Error, (error) => {
  console.error('Client error:', error);
});

await client.login(token);
