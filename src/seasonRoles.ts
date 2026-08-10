import { PermissionFlagsBits } from 'discord.js';

/**
 * Permissions every season role gets. These mirror the Discord UI labels:
 * View Channels, Create Invite, Change Nickname, Send Messages and Create Posts,
 * Attach Files, Add Reactions, Use External Emoji, Read Message History,
 * Connect, Speak, Video, Use Application Commands, Use Activities.
 */
export const seasonRolePermissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.CreateInstantInvite,
  PermissionFlagsBits.ChangeNickname,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.Stream,
  PermissionFlagsBits.UseApplicationCommands,
  PermissionFlagsBits.UseEmbeddedActivities,
];

/** Ranks highest-first. Position in this array is the in-server hierarchy. */
export const seasonTiers = [
  { name: 'Apex Predator', color: '#f9ff03' },
  { name: 'Master', color: '#d316fc' },
  { name: 'Diamond', color: '#0060ff' },
  { name: 'Platinum', color: '#61c0f4' },
  { name: 'Gold', color: '#c7a11e' },
  { name: 'Silver', color: '#c0c0c0' },
  { name: 'Bronze', color: '#a84300' },
] as const;

/**
 * Tiers users can self-assign from the rank embed, lowest first, each paired
 * with the server emoji that represents it. Master and Apex Predator are
 * deliberately absent — those are verified by screenshot in #rank-check.
 */
export const selfAssignTiers = [
  { tier: 'Bronze', emoji: 'rankBronze' },
  { tier: 'Silver', emoji: 'rankSilver' },
  { tier: 'Gold', emoji: 'rankGold' },
  { tier: 'Platinum', emoji: 'rankPlatinum' },
  { tier: 'Diamond', emoji: 'rankDiamond' },
];

/**
 * Tiers sacrificed to free up space when the server hits Discord's role cap.
 * The low ranks matter least once a season is long over.
 */
export const prunableTiers = ['Platinum', 'Gold', 'Silver', 'Bronze'];

/** Discord's hard limit on roles per guild, including @everyone. */
export const maxGuildRoles = 250;

export function seasonRoleName(season: number, tier: string): string {
  return `Season ${season} - ${tier}`;
}

/** Matches any season role and captures its number, e.g. "Season 29 - Master". */
const seasonRolePattern = /^Season (\d+) - .+$/;

export function parseSeasonNumber(roleName: string): number | null {
  const match = seasonRolePattern.exec(roleName);
  return match ? Number(match[1]) : null;
}
