/**
 * `/join code:XXXXX` — the other half of a private room.
 *
 * The code isn't what keeps people out; the Connect permission is. Getting the
 * code right just makes the bot hand that permission over, and then move the
 * caller in if they're already sitting in some other voice channel.
 */

import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { findRoomByCode, grantAccess } from '../tempVoice.ts';

const texts = {
  unknown: 'Žádná roomka s tímhle kódem není. Kód platí jen dokud roomka existuje — řekni si o nový.',
  gone: 'Tahle roomka už neexistuje.',
  moved: (channel: string) => `Jsi uvnitř — přesunul jsem tě do ${channel}.`,
  granted: (channel: string, url: string) => `${channel} je pro tebe otevřená: ${url}`,
  tooMany: 'Moc špatných kódů. Zkus to za pár minut znovu.',
  guildOnly: 'Tenhle příkaz funguje jen na serveru.',
} as const;

// A five-character code out of a 32-character alphabet is 33 million
// combinations, so this is about noise more than security - but a command
// nobody can spam is a command nobody can spam.
const maxAttempts = 5;
const windowMs = 5 * 60_000;
const attempts = new Map<string, { count: number; since: number }>();

function tooManyAttempts(userId: string): boolean {
  const entry = attempts.get(userId);
  if (!entry) return false;
  if (Date.now() - entry.since > windowMs) {
    attempts.delete(userId);
    return false;
  }
  return entry.count >= maxAttempts;
}

function recordMiss(userId: string): void {
  const entry = attempts.get(userId);
  if (!entry || Date.now() - entry.since > windowMs) {
    attempts.set(userId, { count: 1, since: Date.now() });
    return;
  }
  entry.count += 1;
}

export const data = new SlashCommandBuilder()
  .setName('join')
  .setDescription('Join a private squad room with its code')
  .addStringOption((option) =>
    option
      .setName('code')
      .setDescription('The code the room owner gave you')
      .setRequired(true)
      .setMaxLength(20),
  )
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: texts.guildOnly,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (tooManyAttempts(interaction.user.id)) {
    await interaction.editReply(texts.tooMany);
    return;
  }

  const found = await findRoomByCode(interaction.guild, interaction.options.getString('code', true));
  if (!found) {
    recordMiss(interaction.user.id);
    await interaction.editReply(texts.unknown);
    return;
  }

  const channel = await interaction.guild.channels.fetch(found.channelId).catch(() => null);
  if (!channel?.isVoiceBased()) {
    await interaction.editReply(texts.gone);
    return;
  }

  await grantAccess(channel, interaction.user.id);
  attempts.delete(interaction.user.id);

  // Already in a voice channel? Save them the click. If the room is full, or
  // they hung up in the meantime, the link still works.
  if (interaction.member.voice.channelId && interaction.member.voice.channelId !== channel.id) {
    const moved = await interaction.member.voice.setChannel(channel).then(
      () => true,
      () => false,
    );
    if (moved) {
      await interaction.editReply(texts.moved(`<#${channel.id}>`));
      return;
    }
  }

  await interaction.editReply(texts.granted(`<#${channel.id}>`, channel.url));
}
