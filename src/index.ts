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


let refreshingMapRotations = false;

async function refreshMapRotations(): Promise<void> {
  // A stalled fetch can outlast the interval; skip rather than pile up.
  if (refreshingMapRotations) return;
  refreshingMapRotations = true;

  try {
    const entries = Object.entries(await allMapRotationMessages());
    if (entries.length === 0) return;

    const rotation = await fetchMapRotation();
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
  } catch (error) {
    console.error('Map rotation refresh failed:', error);
  } finally {
    refreshingMapRotations = false;
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

// Node exits on an unhandled rejection by default. A background task that
// forgot a catch shouldn't drop the bot off every server it's in.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Staying online matters more here than the usual "let it crash" advice: the
// worst realistic case is one broken feature, while exiting takes the bot
// offline on every server until the host restarts it.
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

// discord.js reconnects on its own once a session exists, but the *initial*
// login has no such safety net: on a host whose egress can't reach Discord for
// the first few seconds after boot, a plain `await client.login()` rejects and
// the bot is left running but permanently offline. Retry with backoff instead.
async function login(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.login(token);
      return;
    } catch (error) {
      const delaySeconds = Math.min(60, 2 ** Math.min(attempt, 6));
      console.error(`Login attempt ${attempt} failed, retrying in ${delaySeconds}s:`, error);
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    }
  }
}

await login();
