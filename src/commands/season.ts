import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Role,
  type TextBasedChannel,
} from 'discord.js';
import {
  maxGuildRoles,
  parseSeasonNumber,
  prunableTiers,
  seasonRoleName,
  seasonRolePermissions,
  seasonTiers,
} from '../seasonRoles.ts';
import {
  closeRankMessage,
  postRankMessage,
  postSeasonStartNotice,
  type PruneSummary,
} from '../rankEmbed.ts';
import { getRankMessage } from '../rankMessageStore.ts';
import { defaultChannels, rankPickerEnabled } from '../config.ts';
import { hasTrustedRole } from '../permissions.ts';
import {
  deletableRoles,
  deleteRoles,
  findPruneTarget,
  freeRoleSlots,
  highestSeasonRole,
} from '../seasonManager.ts';

export const data = new SlashCommandBuilder()
  .setName('season')
  .setDescription('Create the rank roles for a new Apex Legends season')
  .addIntegerOption((option) =>
    option
      .setName('number')
      .setDescription('Season number, e.g. 30')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(999),
  )
  .addChannelOption((option) =>
    option
      .setName('role_picker_channel')
      .setDescription('Where to post the rank picker (defaults to the rank channel)')
      .addChannelTypes(ChannelType.GuildText),
  )
  .addChannelOption((option) =>
    option
      .setName('rank_check_channel')
      .setDescription('Where to post the season-start notice (defaults to the rank-check room)')
      .addChannelTypes(ChannelType.GuildText),
  )
  .addBooleanOption((option) =>
    option
      .setName('ping')
      .setDescription('Ping @everyone with the announcement (default: yes)'),
  )
  // Hides the command from everyone without Administrator. Server admins can
  // override this in Server Settings -> Integrations, so execute() re-checks.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: 'Tenhle příkaz funguje jen na serveru.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { guild, member } = interaction;

  if (!hasTrustedRole(member)) {
    await interaction.reply({
      content: 'Tenhle příkaz můžou použít jen členové s rolí Owner nebo Admin.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const season = interaction.options.getInteger('number', true);

  await interaction.deferReply();

  await guild.roles.fetch();

  // Any "Season N - ..." role counts, not just the seven this command would
  // create. A renamed or hand-made tier still means the season is in use, and
  // creating on top of it would leave duplicates behind.
  const existing = guild.roles.cache.filter(
    (role) => parseSeasonNumber(role.name) === season,
  );

  if (existing.size > 0) {
    const listing = existing
      .map((role) => `<@&${role.id}>`)
      .join('\n');
    await interaction.editReply({
      content:
        `**Season ${season}** už existuje — na serveru je ${existing.size} rolí:\n${listing}\n\n` +
        `Pokud ji chceš vytvořit znovu, spusť nejdřív \`/delete season number:${season}\`.`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.editReply(
      'Na tohle potřebuju právo **Spravovat role** (Manage Roles).',
    );
    return;
  }

  // Out of room? Strip the low tiers off the oldest season that still has
  // them. One season per run, as requested.
  let pruneNote = '';
  let pruneSummary: PruneSummary = null;
  if (freeRoleSlots(guild) < seasonTiers.length) {
    const target = findPruneTarget(guild, season);
    if (!target) {
      await interaction.editReply(
        `Server je na limitu ${maxGuildRoles} rolí a žádná stará season už nemá Platinum, Gold, Silver ani Bronze, které by šly uvolnit. Smaž nejdřív nějaké role ručně.`,
      );
      return;
    }

    const removable = deletableRoles(guild, target.roles);
    if (removable.length === 0) {
      await interaction.editReply(
        `Potřebuju uvolnit místo umazáním Season ${target.season}, ale její role jsou nad mojí. Posuň moji roli výš a zkus to znovu.`,
      );
      return;
    }

    const deleted = await deleteRoles(
      removable,
      `Freeing space for Season ${season}, requested by ${interaction.user.tag}`,
    );
    const deletedTiers = deleted.map((role) => role.name.slice(role.name.indexOf(' - ') + 3));
    // Ordered low-to-high so the embed can read them as a "bronze - platinum" range.
    const orderedTiers = [...prunableTiers]
      .reverse()
      .filter((tier) => deletedTiers.includes(tier));

    pruneSummary = { season: target.season, tiers: orderedTiers };
    pruneNote = `\n\nUvolnil jsem místo smazáním ${deleted.length} rolí ze Season ${target.season}: ${orderedTiers.join(', ')}.`;

    await guild.roles.fetch();

    if (freeRoleSlots(guild) < seasonTiers.length) {
      await interaction.editReply(
        `Umazal jsem Season ${target.season}, ale uvolnilo se jen ${deleted.length} míst a potřeba jich je ${seasonTiers.length}. Spusť příkaz znovu, umaže se další nejstarší season.`,
      );
      return;
    }
  }

  // Sit directly above the highest-placed role of any existing season, so the
  // newest season always reads top-down as 30, 29, 28...
  const anchor = highestSeasonRole(guild);
  const anchorPosition = anchor?.position ?? 0;

  // Discord refuses to place a role at or above the bot's own highest role.
  const ceiling = me.roles.highest.position;
  if (anchorPosition + seasonTiers.length >= ceiling) {
    await interaction.editReply(
      [
        `Moje nejvyšší role (**${me.roles.highest.name}**) je moc nízko na to, abych tyhle role umístil.`,
        anchor
          ? `Musí být nad **${anchor.name}** a mít nad sebou aspoň ${seasonTiers.length} volných míst.`
          : `Musí mít nad sebou aspoň ${seasonTiers.length} volných míst.`,
        'Přetáhni moji roli výš v Nastavení serveru → Role a spusť to znovu.',
      ].join('\n'),
    );
    return;
  }

  const created: Role[] = [];
  try {
    // Lowest rank first, each one slotted directly above the previous, so the
    // finished stack ends with Apex Predator on top.
    for (const [index, tier] of [...seasonTiers].reverse().entries()) {
      const isTopTier = index === seasonTiers.length - 1;
      const role = await guild.roles.create({
        name: seasonRoleName(season, tier.name),
        colors: { primaryColor: tier.color },
        permissions: seasonRolePermissions,
        hoist: isTopTier,
        mentionable: false,
        position: anchorPosition + 1 + index,
        reason: `Season ${season} created by ${interaction.user.tag}`,
      });
      created.push(role);
    }

    // Creating shifts everything above, so re-assert the exact order in one
    // batch rather than trusting the incremental positions to have held.
    await guild.roles.fetch();
    const base = anchor ? anchor.position : 0;
    await guild.roles.setPositions(
      created.map((role, index) => ({ role, position: base + 1 + index })),
    );

    // The previous season's top role was the one hoisted; only the newest
    // season's top role should stand out in the member list now.
    if (anchor?.hoist) {
      await anchor.setHoist(false, `Season ${season} replaces it as current`);
    }
  } catch (error) {
    console.error('Failed to create season roles:', error);
    await interaction.editReply(
      `Vytvořil jsem ${created.length} z ${seasonTiers.length} rolí a pak narazil na chybu: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  let embedNote = '';
  if (rankPickerEnabled) {
    // Defaults to the configured rank channel, then to wherever the command was
    // run, so a server that doesn't have that channel still gets its picker.
    const configured = defaultChannels.rankPicker
      ? await guild.channels.fetch(defaultChannels.rankPicker).catch(() => null)
      : null;
    const targetChannel =
      interaction.options.getChannel('role_picker_channel') ?? configured ?? interaction.channel;
    const ping = interaction.options.getBoolean('ping') ?? true;

    // Retire the previous season's picker before the new one goes up, so there is
    // never a window with two live embeds handing out roles.
    const previous = await getRankMessage(guild.id);
    if (previous) await closeRankMessage(guild, previous);

    try {
      const posted = await postRankMessage({
        guild,
        channel: targetChannel as TextBasedChannel,
        season,
        roles: created,
        prune: pruneSummary,
        ping,
      });
      embedNote = `\n\nVýběr ranku vypsán: ${posted.url}`;
    } catch (error) {
      console.error('Failed to post the rank embed:', error);
      embedNote = `\n\nRole se vytvořily, ale vypsání výběru ranku selhalo: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  let seasonStartNote = '';
  const configuredRankCheck = defaultChannels.rankCheck
    ? await guild.channels.fetch(defaultChannels.rankCheck).catch(() => null)
    : null;
  const rankCheckChannel =
    interaction.options.getChannel('rank_check_channel') ?? configuredRankCheck;
  if (rankCheckChannel) {
    try {
      const posted = await postSeasonStartNotice(rankCheckChannel as TextBasedChannel, season);
      seasonStartNote = `\n\nOznámení o startu season vypsáno: ${posted.url}`;
    } catch (error) {
      console.error('Failed to post the season-start notice:', error);
      seasonStartNote = `\n\nVypsání oznámení o startu season do rank-check roomky selhalo: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  const listing = seasonTiers
    .map((tier) => `<@&${created.find((role) => role.name.endsWith(tier.name))?.id}>`)
    .join('\n');

  await interaction.editReply(
    `Vytvořena **Season ${season}** — ${seasonTiers.length} rolí, umístěných nad ${
      anchor ? `Season ${parseSeasonNumber(anchor.name)}` : 'vším ostatním'
    }:\n${listing}${pruneNote}${embedNote}${seasonStartNote}`,
  );
}
