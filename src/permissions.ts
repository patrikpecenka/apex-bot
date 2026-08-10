import type { GuildMember } from 'discord.js';

/** Discord role names trusted to run season-management commands. */
export const trustedRoleNames = ['Owner', 'Admin'];

export function hasTrustedRole(member: GuildMember): boolean {
  return member.roles.cache.some((role) => trustedRoleNames.includes(role.name));
}
