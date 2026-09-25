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
import { hasTrustedRole } from '../permissions.ts';

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
      content: 'Tenhle příkaz funguje jen na serveru.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { guild, member } = interaction;

  // Same Owner/Admin role check as /season. The Administrator gate on the
  // builder just hides the command from non-admins in the UI; this is the
  // check that actually enforces it.
  if (!hasTrustedRole(member)) {
    await interaction.reply({
      content: 'Smazat season můžou jen členové s rolí Owner nebo Admin.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const season = interaction.options.getInteger('number', true);

  await interaction.deferReply();
  await guild.roles.fetch();

  const group = groupSeasons(guild).find((entry) => entry.season === season);
  if (!group) {
    await interaction.editReply(`Pro Season ${season} jsem nenašel žádné role.`);
    return;
  }

  const removable = deletableRoles(guild, group.roles);
  const blocked = group.roles.length - removable.length;

  if (removable.length === 0) {
    await interaction.editReply(
      `Pro Season ${season} jsem našel ${group.roles.length} rolí, ale všechny jsou nad mojí vlastní rolí. Posuň moji roli výš v Nastavení serveru → Role.`,
    );
    return;
  }

  // Deleting roles strips them from every member and cannot be undone, so make
  // the caller confirm what they're about to lose.
  const confirmId = `confirm-delete-season-${season}-${interaction.id}`;
  const cancelId = `cancel-delete-season-${season}-${interaction.id}`;
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Smazat').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Zrušit').setStyle(ButtonStyle.Secondary),
  );

  const prompt = await interaction.editReply({
    content: [
      `Smazat ${removable.length} rolí pro **Season ${season}**?`,
      removable.map((role) => `• ${role.name}`).join('\n'),
      blocked > 0 ? `\n${blocked} rolí přeskočím — jsou nad mojí rolí.` : '',
      '\nRole se odeberou všem členům a nejde to vzít zpět.',
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
    await interaction.editReply({ content: 'Vypršel čas, nic jsem nesmazal.', components: [] });
    return;
  }

  if (choice.customId === cancelId) {
    await choice.update({ content: 'Zrušeno, nic jsem nesmazal.', components: [] });
    return;
  }

  await choice.update({ content: `Mažu ${removable.length} rolí…`, components: [] });

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
      content: `Smazáno ${deleted.length} rolí pro **Season ${season}**.${
        blocked > 0 ? ` ${blocked} jsem přeskočil — jsou nad mojí rolí.` : ''
      }`,
      components: [],
    });
  } catch (error) {
    console.error(`Failed deleting Season ${season}:`, error);
    await interaction.editReply({
      content: `Částečně se to nepovedlo: ${error instanceof Error ? error.message : String(error)}`,
      components: [],
    });
  }
}
