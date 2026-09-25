import postgres from 'postgres';
import { databaseUrl } from './config.ts';

/**
 * The tournament website's database, shared by everything that talks to it.
 * `prepare: false` keeps it working through Supabase's transaction pooler.
 * Null when DATABASE_URL is not set - those features stay off.
 */
export const sql = databaseUrl ? postgres(databaseUrl, { prepare: false, max: 3, onnotice: () => {} }) : null;

const loginPauseMs = 5 * 60_000;
let pausedUntil = 0;

/**
 * A rejected database login (wrong DATABASE_URL, rotated password). Supabase's
 * pooler blocks every new connection after a burst of these (ECIRCUITBREAKER),
 * and retrying every 15 seconds from several tasks keeps it blocked - so back
 * off for a few minutes, say so once, and try again.
 */
export function pauseOnLoginFailure(error: unknown): boolean {
  const { code, message = '' } = (error ?? {}) as { code?: string; message?: string };
  const login = code === '28P01' || code === '28000' || /ECIRCUITBREAKER|password authentication failed/i.test(message);
  if (!login) return false;
  if (!databasePaused()) {
    console.error(`Database login rejected: ${message}\nCheck DATABASE_URL. Pausing database work for ${loginPauseMs / 60_000} minutes so the lockout can lift.`);
  }
  pausedUntil = Date.now() + loginPauseMs;
  return true;
}

export const databasePaused = () => Date.now() < pausedUntil;
