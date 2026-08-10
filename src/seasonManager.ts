import type { Guild, Role } from 'discord.js';
import { maxGuildRoles, parseSeasonNumber, prunableTiers } from './seasonRoles.ts';

export type SeasonGroup = { season: number; roles: Role[] };

/** Every season role on the server, grouped by season number, oldest first. */
export function groupSeasons(guild: Guild): SeasonGroup[] {
  const groups = new Map<number, Role[]>();

  for (const role of guild.roles.cache.values()) {
    const season = parseSeasonNumber(role.name);
    if (season === null) continue;
    const existing = groups.get(season);
    if (existing) existing.push(role);
    else groups.set(season, [role]);
  }

  return [...groups.entries()]
    .map(([season, roles]) => ({ season, roles }))
    .sort((a, b) => a.season - b.season);
}

/** The role a new season should be placed directly above, if any. */
export function highestSeasonRole(guild: Guild): Role | undefined {
  let best: Role | undefined;
  for (const role of guild.roles.cache.values()) {
    if (parseSeasonNumber(role.name) === null) continue;
    if (!best || role.position > best.position) best = role;
  }
  return best;
}

function tierOf(role: Role): string {
  return role.name.slice(role.name.indexOf(' - ') + 3);
}

/**
 * Picks the oldest season that still has at least one prunable tier left.
 * Seasons already stripped by an earlier prune are skipped, so this walks
 * forward — season 1, then 2, and so on — until it finds one with something
 * to give. Deliberately returns a single season per call.
 */
export function findPruneTarget(
  guild: Guild,
  protectedSeason?: number,
): SeasonGroup | null {
  for (const group of groupSeasons(guild)) {
    if (group.season === protectedSeason) continue;
    const roles = group.roles.filter((role) => prunableTiers.includes(tierOf(role)));
    if (roles.length > 0) return { season: group.season, roles };
  }
  return null;
}

/** Roles the bot is actually allowed to delete, given hierarchy and managed roles. */
export function deletableRoles(guild: Guild, roles: Role[]): Role[] {
  const ceiling = guild.members.me?.roles.highest.position ?? 0;
  return roles.filter((role) => !role.managed && role.position < ceiling);
}

export async function deleteRoles(roles: Role[], reason: string): Promise<Role[]> {
  const deleted: Role[] = [];
  for (const role of roles) {
    await role.delete(reason);
    deleted.push(role);
  }
  return deleted;
}

/** How many more roles fit before hitting Discord's cap. */
export function freeRoleSlots(guild: Guild): number {
  return Math.max(0, maxGuildRoles - guild.roles.cache.size);
}
