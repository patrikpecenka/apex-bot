import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { rankPickerEnabled, token } from './config.ts';
import { commandsByName } from './commands/registry.ts';
import { registerReactionRoles } from './reactionRoles.ts';
import { registerCommandsToGuild } from './commandDeploy.ts';
import { buildMapRotationMessage, fetchMapRotation } from './mapRotation.ts';
import { allMapRotationMessages, clearMapRotationMessage } from './mapRotationStore.ts';

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

// Every minute: the countdown ring needs to visibly tick down, so unlike a
// static time range this has to re-render regardless of whether the map
// itself changed. Minute precision is enough for the ring, so no need to run
// this any more often than that.
async function refreshMapRotations(): Promise<void> {
  const entries = Object.entries(await allMapRotationMessages());
  if (entries.length === 0) return;

  let rotation;
  try {
    rotation = await fetchMapRotation();
  } catch (error) {
    console.error('Failed to fetch map rotation:', error);
    return;
  }

  const rendered = await buildMapRotationMessage(rotation, Date.now());

  for (const [guildId, { channelId, messageId }] of entries) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const message = channel?.isTextBased()
      ? await channel.messages.fetch(messageId).catch(() => null)
      : null;
    if (!message) {
      await clearMapRotationMessage(guildId);
      continue;
    }

    await message.edit(rendered).catch(() => {});
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`In ${readyClient.guilds.cache.size} server(s):`);
  for (const guild of readyClient.guilds.cache.values()) {
    console.log(`  - ${guild.name} (${guild.id})`);
  }

  setInterval(() => void refreshMapRotations(), 60_000);
  void refreshMapRotations();
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

// A server that adds the bot gets commands right away, rather than waiting
// for the next restart's deploy pass.
client.on(Events.GuildCreate, async (guild) => {
  try {
    await registerCommandsToGuild(guild.id);
    console.log(`Registered commands to new guild: ${guild.name} (${guild.id})`);
  } catch (error) {
    console.error(`Failed to register commands to new guild ${guild.id}:`, error);
  }
});

client.on(Events.Error, (error) => {
  console.error('Client error:', error);
});

await client.login(token);
