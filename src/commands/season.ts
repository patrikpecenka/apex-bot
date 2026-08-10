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
import { closeRankMessage, postRankMessage, type PruneSummary } from '../rankEmbed.ts';
import { getRankMessage } from '../rankMessageStore.ts';
import { rankChannelId, rankPickerEnabled } from '../config.ts';
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
      .setName('channel')
      .setDescription('Where to post the rank picker (defaults to the rank channel)')
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
      content: 'This command only works inside a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { guild } = interaction;
  const isOwner = guild.ownerId === interaction.user.id;
  const isAdmin = interaction.memberPermissions.has(
    PermissionFlagsBits.Administrator,
  );

  if (!isOwner && !isAdmin) {
    await interaction.reply({
      content: 'Only the server owner and administrators can use this.',
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
        `**Season ${season}** already exists — ${existing.size} role(s) are still on the server:\n${listing}\n\n` +
        `Run \`/delete season number:${season}\` first if you want to recreate it.`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.editReply(
      'I need the **Manage Roles** permission to do this.',
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
        `The server is at Discord's ${maxGuildRoles}-role limit and no old season has Platinum, Gold, Silver or Bronze left to free up. Delete some roles manually first.`,
      );
      return;
    }

    const removable = deletableRoles(guild, target.roles);
    if (removable.length === 0) {
      await interaction.editReply(
        `Need to free space by pruning Season ${target.season}, but its roles sit above mine. Move my role higher and try again.`,
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
    pruneNote = `\n\nFreed space by deleting ${deleted.length} role(s) from Season ${target.season}: ${orderedTiers.join(', ')}.`;

    await guild.roles.fetch();

    if (freeRoleSlots(guild) < seasonTiers.length) {
      await interaction.editReply(
        `Pruned Season ${target.season}, but that only freed ${deleted.length} slot(s) and ${seasonTiers.length} are needed. Run the command again to prune the next oldest season.`,
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
        `My highest role (**${me.roles.highest.name}**) sits too low to place these roles.`,
        anchor
          ? `It has to be above **${anchor.name}** with at least ${seasonTiers.length} slots to spare.`
          : `It needs at least ${seasonTiers.length} slots above it.`,
        'Drag my role higher in Server Settings → Roles and run this again.',
      ].join('\n'),
    );
    return;
  }

  const created: Role[] = [];
  try {
    // Lowest rank first, each one slotted directly above the previous, so the
    // finished stack ends with Apex Predator on top.
    for (const [index, tier] of [...seasonTiers].reverse().entries()) {
      const role = await guild.roles.create({
        name: seasonRoleName(season, tier.name),
        colors: { primaryColor: tier.color },
        permissions: seasonRolePermissions,
        hoist: false,
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
  } catch (error) {
    console.error('Failed to create season roles:', error);
    await interaction.editReply(
      `Created ${created.length} of ${seasonTiers.length} roles, then hit an error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  let embedNote = '';
  if (rankPickerEnabled) {
    // Defaults to the configured rank channel, then to wherever the command was
    // run, so a server that doesn't have that channel still gets its picker.
    const configured = rankChannelId
      ? await guild.channels.fetch(rankChannelId).catch(() => null)
      : null;
    const targetChannel =
      interaction.options.getChannel('channel') ?? configured ?? interaction.channel;
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
      embedNote = `\n\nRank picker posted: ${posted.url}`;
    } catch (error) {
      console.error('Failed to post the rank embed:', error);
      embedNote = `\n\nRoles were created, but posting the rank picker failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  const listing = seasonTiers
    .map((tier) => `<@&${created.find((role) => role.name.endsWith(tier.name))?.id}>`)
    .join('\n');

  await interaction.editReply(
    `Created **Season ${season}** — ${seasonTiers.length} roles, placed above ${
      anchor ? `Season ${parseSeasonNumber(anchor.name)}` : 'everything else'
    }:\n${listing}${pruneNote}${embedNote}`,
  );
}
