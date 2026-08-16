import type { GuildMember } from 'discord.js';

/** Discord role names trusted to run season-management commands. */
export const trustedRoleNames = ['Owner', 'Admin'];

export function hasTrustedRole(member: GuildMember): boolean {
  return member.roles.cache.some((role) => trustedRoleNames.includes(role.name));
}

/**
 * Stricter than the above: the standing welcome/rules messages are the server's
 * front door, so only Owner can post or rewrite them.
 */
export const ownerRoleName = 'Owner';

export function hasOwnerRole(member: GuildMember): boolean {
  return member.roles.cache.some((role) => role.name === ownerRoleName);
}
