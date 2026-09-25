/**
 * `/room` — owner controls for the squad room you're sitting in.
 *
 * Everything here acts on the caller's *current* voice channel, so there is no
 * room to pick and nothing to get wrong: if you aren't in one of the bot's
 * rooms, the command says so and stops.
 */

import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type VoiceBasedChannel,
} from 'discord.js';
import {
  currentRoom,
  grantAccess,
  lockRoom,
  regenerateCode,
  revokeAccess,
  trackRoomMessage,
  unlockRoom,
  type TempRoom,
} from '../tempVoice.ts';
import { hasTrustedRole } from '../permissions.ts';

const texts = {
  notInRoom:
    'Nejsi v žádné squad roomce. Nejdřív se připoj do kanálu, který roomku vytvoří, a zkus to znovu.',
  notOwner: 'Tohle může udělat jen ten, komu roomka patří (nebo moderátor).',
  locked: (code: string, channel: string) =>
    `${channel} je teď **zamčená**.\n` +
    `Kód roomky: **${code}** — kdo napíše \`/join code:${code}\`, dostane se dovnitř.\n` +
    'Nebo lidi přidávej po jednom přes `/room invite`.',
  alreadyLocked: (code: string) => `Tahle roomka je už zamčená. Její kód je **${code}**.`,
  unlocked: 'Roomka je odemčená — může se připojit kdokoliv a starý kód už neplatí.',
  alreadyUnlocked: 'Tahle roomka je už otevřená pro všechny.',
  notLocked: 'Roomka je otevřená, takže žádný kód nemá. Nejdřív ji zamkni přes `/room lock`.',
  code: (code: string) => `Kód roomky: **${code}** — ostatní se dostanou dovnitř přes \`/join code:${code}\`.`,
  newCode: (code: string) =>
    `Nový kód roomky: **${code}**. Starý přestal platit; kdo už přístup má, o něj nepřijde.`,
  invited: (user: string) => `${user} se teď může připojit.`,
  inviteDmFailed: (user: string) =>
    `${user} se teď může připojit, ale nepodařilo se mu poslat DM — pošli mu odkaz sám.`,
  inviteOpen: ' (roomka je odemčená, takže by se dovnitř dostal i tak)',
  inviteSelf: 'V roomce už jsi.',
  inviteBot: 'Boty pozvat nejde.',
  kickOwner: 'Majitele roomky vyhodit nemůžeš.',
  kicked: (user: string) => `${user} byl z roomky odebrán.`,
  dm: (owner: string, url: string) => `**${owner}** tě zve do své squad roomky: ${url}`,
  notFound: 'Tohohle člena jsem na serveru nenašel.',
  guildOnly: 'Tenhle příkaz funguje jen na serveru.',
} as const;

export const data = new SlashCommandBuilder()
  .setName('room')
  .setDescription('Manage the squad room you are in')
  .addSubcommand((sub) =>
    sub.setName('lock').setDescription('Make your room private and get a code for it'),
  )
  .addSubcommand((sub) => sub.setName('unlock').setDescription('Let anyone join your room again'))
  .addSubcommand((sub) =>
    sub
      .setName('code')
      .setDescription('Show your room code')
      .addBooleanOption((option) =>
        option.setName('new').setDescription('Generate a fresh code and retire the old one'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('invite')
      .setDescription('Let someone into your room and DM them the link')
      .addUserOption((option) =>
        option.setName('user').setDescription('Who to let in').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('kick')
      .setDescription('Remove someone from your room and revoke their access')
      .addUserOption((option) =>
        option.setName('user').setDescription('Who to remove').setRequired(true),
      ),
  )
  .setContexts(InteractionContextType.Guild);

/** Resolves the caller's room, or replies with why it can't. */
async function resolveRoom(
  interaction: ChatInputCommandInteraction<'cached'>,
): Promise<{ channel: VoiceBasedChannel; room: TempRoom } | null> {
  const found = await currentRoom(interaction.member);
  if (!found) {
    await interaction.editReply(texts.notInRoom);
    return null;
  }

  if (found.room.ownerId !== interaction.user.id && !hasTrustedRole(interaction.member)) {
    await interaction.editReply(texts.notOwner);
    return null;
  }

  return found;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: texts.guildOnly,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Ephemeral throughout: room codes are the whole point of the feature, and a
  // code posted in the channel is not a private room.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const found = await resolveRoom(interaction);
  if (!found) return;

  const { channel, room } = found;

  switch (interaction.options.getSubcommand()) {
    case 'lock': {
      if (room.locked && room.code) {
        await interaction.editReply(texts.alreadyLocked(room.code));
        return;
      }
      const code = await lockRoom(channel, room);
      await interaction.editReply(texts.locked(code, `<#${channel.id}>`));
      return;
    }

    case 'unlock': {
      if (!room.locked) {
        await interaction.editReply(texts.alreadyUnlocked);
        return;
      }
      await unlockRoom(channel, room);
      await interaction.editReply(texts.unlocked);
      return;
    }

    case 'code': {
      if (!room.locked || !room.code) {
        await interaction.editReply(texts.notLocked);
        return;
      }
      if (interaction.options.getBoolean('new')) {
        await interaction.editReply(texts.newCode(await regenerateCode(channel, room)));
        return;
      }
      await interaction.editReply(texts.code(room.code));
      return;
    }

    case 'invite': {
      const target = interaction.options.getMember('user') as GuildMember | null;
      if (!target) {
        await interaction.editReply(texts.notFound);
        return;
      }
      if (target.id === interaction.user.id) {
        await interaction.editReply(texts.inviteSelf);
        return;
      }
      if (target.user.bot) {
        await interaction.editReply(texts.inviteBot);
        return;
      }

      await grantAccess(channel, target.id);

      const note = room.locked ? '' : texts.inviteOpen;
      const dm = await target
        .send(texts.dm(interaction.member.displayName, channel.url))
        .catch(() => null);
      // Tied to the room: when the room goes, so does the link pointing at it.
      if (dm) await trackRoomMessage(channel.id, dm);

      await interaction.editReply(
        (dm ? texts.invited(`<@${target.id}>`) : texts.inviteDmFailed(`<@${target.id}>`)) +
          note +
          (dm ? '' : `\n${channel.url}`),
      );
      return;
    }

    case 'kick': {
      const target = interaction.options.getMember('user') as GuildMember | null;
      if (!target) {
        await interaction.editReply(texts.notFound);
        return;
      }
      if (target.id === room.ownerId) {
        await interaction.editReply(texts.kickOwner);
        return;
      }

      await revokeAccess(channel, target);
      await interaction.editReply(texts.kicked(`<@${target.id}>`));
    }
  }
}
