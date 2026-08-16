/**
 * `/create <key> [channel]` - posts one of the messages defined in
 * `content/messages.json`, or edits the one it posted last time so the server
 * only ever has a single live copy.
 *
 * The subcommands are generated from the JSON keys at startup. Adding a new key
 * therefore needs a bot restart (`npm start` redeploys commands on boot);
 * *editing* an existing key needs nothing - `/create` re-reads the file on every
 * run.
 */

import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
} from 'discord.js';
import { getMessageDefinition, messageKeysSync, messagesPath, renderMessage } from '../messages.ts';
import { clearPostedMessage, getPostedMessage, setPostedMessage } from '../postedMessageStore.ts';
import { hasOwnerRole, ownerRoleName } from '../permissions.ts';

/** Discord's rule for subcommand names: lowercase, no spaces, max 32 chars. */
const validKeyPattern = /^[-_\p{Ll}\p{N}]{1,32}$/u;

const keys = messageKeysSync().filter((key) => {
  if (validKeyPattern.test(key)) return true;
  console.warn(
    `Skipping message key "${key}": /create subcommands must be lowercase, 1-32 characters, no spaces.`,
  );
  return false;
});

const builder = new SlashCommandBuilder()
  .setName('create')
  .setDescription('Post or update one of the server messages')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

for (const key of keys) {
  builder.addSubcommand((sub) =>
    sub
      .setName(key)
      .setDescription(`Post or update the "${key}" message`)
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Where to post (defaults to the channelId in messages.json)')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  );
}

export const data = builder;

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: 'This command only works inside a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { guild, member } = interaction;

  if (!hasOwnerRole(member)) {
    await interaction.reply({
      content: `Only members with the ${ownerRoleName} role can use this.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const key = interaction.options.getSubcommand(false);
  if (!key) {
    await interaction.reply({
      content:
        `No messages are loaded — \`${messagesPath}\` is missing or unreadable. ` +
        'Fix the file and restart the bot.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Ephemeral throughout: the point of the command is the message it posts, not
  // a second one cluttering the channel.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Read fresh every run — that is what makes "edit the JSON, run it again"
  // work without a restart.
  let payload;
  try {
    const definition = await getMessageDefinition(key);
    payload = { definition, rendered: await renderMessage(interaction.client, key, definition) };
  } catch (error) {
    await interaction.editReply(
      `Couldn't build **${key}**:\n\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``,
    );
    return;
  }

  const { definition, rendered } = payload;
  const warningNote =
    rendered.warnings.length > 0 ? `\n⚠️ ${rendered.warnings.join('\n⚠️ ')}` : '';

  const chosen = interaction.options.getChannel('channel');
  const configured = definition.channelId
    ? await guild.channels.fetch(definition.channelId).catch(() => null)
    : null;
  const target = (chosen ?? configured ?? interaction.channel) as GuildTextBasedChannel | null;

  if (!target?.isSendable()) {
    await interaction.editReply(
      definition.channelId && !chosen && !configured
        ? `Channel \`${definition.channelId}\` from the "${key}" entry is missing or I can't post in it.`
        : `I can't post in ${target ? `<#${target.id}>` : 'that channel'} — check my permissions.`,
    );
    return;
  }

  // An existing post in the same channel gets edited; one left behind in a
  // different channel is reported rather than deleted, so nothing vanishes
  // without the caller seeing it.
  const previous = await getPostedMessage(guild.id, key);
  let staleNote = '';

  if (previous) {
    const previousChannel = await guild.channels.fetch(previous.channelId).catch(() => null);
    const previousMessage = previousChannel?.isTextBased()
      ? await previousChannel.messages.fetch(previous.messageId).catch(() => null)
      : null;

    if (previousMessage && previous.channelId === target.id) {
      try {
        // `attachments: []` drops the old uploads so re-posted banners replace
        // them instead of stacking up.
        const edited = await previousMessage.edit({ ...rendered.payload, attachments: [] });
        await setPostedMessage(guild.id, key, {
          channelId: target.id,
          messageId: edited.id,
        });
        await interaction.editReply(
          `Updated **${key}** in <#${target.id}>: ${edited.url}${warningNote}`,
        );
        return;
      } catch (error) {
        // Either a different bot account posted it, or the entry switched
        // between cards and embeds - Discord won't convert a message's type.
        console.error(`Editing the ${key} message failed, posting a new one:`, error);
        staleNote = `\nCouldn't edit the old message (${previousMessage.url}) — posted a new one instead. Delete the old one.`;
      }
    } else if (previousMessage) {
      staleNote = `\nThe previous copy is still up in <#${previous.channelId}>: ${previousMessage.url} — delete it if you don't want two.`;
    } else {
      // Deleted by hand; drop the dangling reference.
      await clearPostedMessage(guild.id, key);
    }
  }

  const posted = await target.send(rendered.payload);
  await setPostedMessage(guild.id, key, { channelId: target.id, messageId: posted.id });
  await interaction.editReply(
    `Posted **${key}** to <#${target.id}>: ${posted.url}${staleNote}${warningNote}`,
  );
}
