import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { groupSeasons, deletableRoles, deleteRoles } from '../seasonManager.ts';
import { closeRankMessage } from '../rankEmbed.ts';
import { clearRankMessage, getRankMessage } from '../rankMessageStore.ts';

export const data = new SlashCommandBuilder()
  .setName('delete')
  .setDescription('Delete things')
  .addSubcommand((sub) =>
    sub
      .setName('season')
      .setDescription('Delete every rank role for a season')
      .addIntegerOption((option) =>
        option
          .setName('number')
          .setDescription('Season number, e.g. 30')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(999),
      ),
  )
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

  // Owner only — stricter than /season, which admins may also run. The
  // Administrator gate on the builder just hides it from non-admins in the UI;
  // this is the check that actually enforces it.
  if (guild.ownerId !== interaction.user.id) {
    await interaction.reply({
      content: 'Only the server owner can delete a season.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const season = interaction.options.getInteger('number', true);

  await interaction.deferReply();
  await guild.roles.fetch();

  const group = groupSeasons(guild).find((entry) => entry.season === season);
  if (!group) {
    await interaction.editReply(`No roles found for Season ${season}.`);
    return;
  }

  const removable = deletableRoles(guild, group.roles);
  const blocked = group.roles.length - removable.length;

  if (removable.length === 0) {
    await interaction.editReply(
      `Found ${group.roles.length} role(s) for Season ${season}, but all of them sit above my own role. Move my role higher in Server Settings → Roles.`,
    );
    return;
  }

  // Deleting roles strips them from every member and cannot be undone, so make
  // the caller confirm what they're about to lose.
  const confirmId = `confirm-delete-season-${season}-${interaction.id}`;
  const cancelId = `cancel-delete-season-${season}-${interaction.id}`;
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Delete').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  const prompt = await interaction.editReply({
    content: [
      `Delete ${removable.length} role(s) for **Season ${season}**?`,
      removable.map((role) => `• ${role.name}`).join('\n'),
      blocked > 0 ? `\n${blocked} role(s) will be skipped — they sit above my role.` : '',
      '\nThis removes them from every member and cannot be undone.',
    ]
      .filter(Boolean)
      .join('\n'),
    components: [buttons],
  });

  let choice;
  try {
    choice = await prompt.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (button) => button.user.id === interaction.user.id,
      time: 30_000,
    });
  } catch {
    await interaction.editReply({ content: 'Timed out, nothing was deleted.', components: [] });
    return;
  }

  if (choice.customId === cancelId) {
    await choice.update({ content: 'Cancelled, nothing was deleted.', components: [] });
    return;
  }

  await choice.update({ content: `Deleting ${removable.length} role(s)...`, components: [] });

  try {
    const deleted = await deleteRoles(removable, `Season ${season} deleted by ${interaction.user.tag}`);

    // If this season owned the live rank picker, retire it — otherwise it would
    // sit there handing out roles that no longer exist.
    const active = await getRankMessage(guild.id);
    if (active?.season === season) {
      await closeRankMessage(guild, active);
      await clearRankMessage(guild.id);
    }

    await interaction.editReply({
      content: `Deleted ${deleted.length} role(s) for **Season ${season}**.${
        blocked > 0 ? ` Skipped ${blocked} that sit above my role.` : ''
      }`,
      components: [],
    });
  } catch (error) {
    console.error(`Failed deleting Season ${season}:`, error);
    await interaction.editReply({
      content: `Partly failed: ${error instanceof Error ? error.message : String(error)}`,
      components: [],
    });
  }
}
