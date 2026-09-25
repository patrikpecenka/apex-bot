import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { anyVoiceHubs, databaseUrl, rankPickerEnabled, token, welcomeDmEnabled } from './config.ts';
import { commandsByName } from './commands/registry.ts';
import { handleComponent } from './components/registry.ts';
import { registerReactionRoles } from './reactionRoles.ts';
import { registerCommandsToGuild } from './commandDeploy.ts';
import { buildMapRotationMessage, fetchMapRotation } from './mapRotation.ts';
import { allMapRotationMessages, clearMapRotationMessage } from './mapRotationStore.ts';
import { registerLiveMessage, startLiveMessages } from './liveMessages.ts';
import { registerTempVoice, sweepTempRooms } from './tempVoice.ts';
import { registerWelcomeDm } from './welcome.ts';
import { registerServerSync } from './discordServers.ts';
// Imported for the side effect of registering its live message on the loop.
import './predator.ts';
// Same for tournament sign-ups (a no-op unless DATABASE_URL is set).
import './tournamentSignup.ts';

// Guilds is enough to see servers and their channels. Reading message text
// would additionally need the privileged MessageContent intent, which has to be
// enabled in the Developer Portal first.
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions];

// Only asked for when the feature that needs it is on: an intent the Developer
// Portal hasn't granted (GuildMembers) makes login fail outright, and one we
// don't use is a needless event firehose.
if (anyVoiceHubs) intents.push(GatewayIntentBits.GuildVoiceStates);
if (welcomeDmEnabled) intents.push(GatewayIntentBits.GuildMembers);

const client = new Client({
  intents,
  // Reaction events on messages posted before the last restart arrive partial;
  // without these the rank picker would only work until the bot restarts.
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

if (rankPickerEnabled) registerReactionRoles(client);
if (anyVoiceHubs) registerTempVoice(client);
if (welcomeDmEnabled) registerWelcomeDm(client);
// Which servers the bot is in and where it may post (a no-op unless DATABASE_URL is set).
registerServerSync(client);

// The map rotation's own live message. Everything else that ticks registers
// itself from its own module.
registerLiveMessage({
  name: 'Map rotation refresh',
  intervalMs: 60_000,
  store: {
    all: allMapRotationMessages,
    remove: clearMapRotationMessage,
  },
  render: async () => buildMapRotationMessage(await fetchMapRotation(), Date.now()),
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`In ${readyClient.guilds.cache.size} server(s):`);
  for (const guild of readyClient.guilds.cache.values()) {
    console.log(`  - ${guild.name} (${guild.id})`);
  }
  // Without it tournaments and the website's server list do nothing, silently - so say which database, or that there is none.
  console.log(
    databaseUrl
      ? `Tournament database: ${new URL(databaseUrl).hostname} (server sync, sign-up cards, payments on)`
      : "Tournament database: none - DATABASE_URL is not set, so server sync, sign-up cards and payments are off.",
  );

  // Rooms whose last member left while the bot was down would otherwise sit
  // there forever — nothing will fire a voice event for them again.
  if (anyVoiceHubs) {
    await sweepTempRooms(readyClient).catch((error: unknown) => {
      console.error('Squad room startup sweep failed:', error);
    });
  }

  startLiveMessages(readyClient);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    try {
      await handleComponent(interaction);
    } catch (error) {
      console.error(`Component ${interaction.customId} failed:`, error);
      const message = {
        content: 'Něco se pokazilo.',
        flags: MessageFlags.Ephemeral,
      } as const;
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(message).catch(() => {});
      } else {
        await interaction.reply(message).catch(() => {});
      }
    }
    return;
  }

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
    const message = { content: 'Něco se při spuštění příkazu pokazilo.', flags: MessageFlags.Ephemeral } as const;
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
