/**
 * Deletes what the website's privacy policy says is kept only for a while.
 * The periods mirror RETENTION_MONTHS in the website's packages/api/src/legal.ts -
 * change them together, the policy states them to every player.
 *
 *   - expired sign-in sessions (with their IP address and browser) and login tokens
 *   - the admin activity log after 24 months
 *   - handled contact messages and reports 24 months after handling
 *   - withdrawn sign-ups and "looking for a team" posts after 24 months
 *
 * Results of played tournaments are not touched: they are the archive.
 */

import { sql } from './db.ts';
import { registerTask } from './liveMessages.ts';

const months = { auditLog: 24, handledMessages: 24, withdrawnSignUps: 24 };
const olderThan = (n: number) => sql!`now() - make_interval(months => ${n})`;

async function applyRetention(): Promise<void> {
  const deleted = {
    sessions: (await sql!`delete from session where expires_at < now()`).count,
    tokens: (await sql!`delete from verification where expires_at < now()`).count,
    auditLog: (await sql!`delete from audit_log where at < ${olderThan(months.auditLog)}`).count,
    messages: (await sql!`delete from contact_message where status <> 'open'
      and coalesce(handled_at, created_at) < ${olderThan(months.handledMessages)}`).count,
    reports: (await sql!`delete from player_report where status <> 'open'
      and coalesce(resolved_at, created_at) < ${olderThan(months.handledMessages)}`).count,
    // Only once the bot has nothing left to undo on Discord for them.
    signUps: (await sql!`delete from registration where removed_at < ${olderThan(months.withdrawnSignUps)}
      and not has_captain_role`).count,
    teamSearches: (await sql!`delete from team_search where removed_at < ${olderThan(months.withdrawnSignUps)}
      and discord_message_id is null`).count,
  };
  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  if (total > 0) console.log('Retention: deleted', deleted);
}

if (sql) registerTask({ name: 'Data retention', intervalMs: 24 * 60 * 60_000, run: applyRetention, database: true });
