/**
 * Reads configuration from the environment. `npm start` / `npm run send` load
 * `.env` via node's built-in `--env-file-if-exists` flag, so no dotenv needed.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Missing ${name}. Copy .env.example to .env and fill it in.`,
    );
    process.exit(1);
  }
  return value;
}

export const token = required('DISCORD_TOKEN');

/**
 * Default channel IDs for each feature, one place to look when wiring up
 * something new. Each can be overridden via its env var.
 */
export const defaultChannels = {
  /** Where `npm run send` / `npm run diag` post when no channel is given. */
  general: process.env.CHANNEL_ID ?? '',

  /** Where /season posts the rank picker when run without the `channel` option. */
  rankPicker: process.env.RANK_CHANNEL_ID ?? '547456557768507392',

  /** Linked from the rank embed for Master / Apex Predator proof. */
  rankCheck: process.env.RANK_CHECK_CHANNEL_ID ?? '603672062875140106',

  /** Where /lfg posts when run outside it. Falls back to the current channel. */
  lfg: process.env.LFG_CHANNEL_ID ?? '545580800457048074',

  /** Default target for /predator post. Empty means "wherever it was run". */
  predator: process.env.PREDATOR_CHANNEL_ID ?? '',
};

function idList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Voice channels that hand out a temporary squad room when someone joins them.
 * Empty (the default) leaves the feature off entirely - no listener, no intent
 * cost, nothing to go wrong on a server that hasn't set a hub up.
 */
export const voiceHubIds = idList(process.env.VOICE_HUB_IDS);

/** Same, but the room comes out locked with a code. */
export const privateVoiceHubIds = idList(process.env.VOICE_HUB_PRIVATE_IDS);

/** Any hub at all - what decides whether the feature runs. */
export const anyVoiceHubs = voiceHubIds.length + privateVoiceHubIds.length > 0;

/**
 * Off by default: the DM needs the privileged GuildMembers intent, and asking
 * for an intent that isn't ticked in the Developer Portal makes login fail
 * outright. Turning this on is a two-step change - portal, then WELCOME_DM=on.
 */
export const welcomeDmEnabled = process.env.WELCOME_DM === 'on';

/**
 * Master switch for the self-assign rank picker. Off for now: /season only
 * creates the roles, no embed is posted, and reactions hand out nothing.
 * Flip back to true (or set RANK_PICKER=on) to re-enable it.
 */
export const rankPickerEnabled = process.env.RANK_PICKER === 'on';

/** Free key from https://api.mozambiquehe.re/getkey — powers /maprotation. */
export const apexApiKey = process.env.APEX_API_KEY ?? '';

/**
 * Postgres connection string of the tournament website's database (Supabase).
 * Empty turns tournament sign-ups off entirely.
 */
export const databaseUrl = process.env.DATABASE_URL ?? '';

/**
 * The community's own server - where the Apex features live (rank picker, LFG,
 * map rotation, squad rooms, welcome DM) and where their slash commands are
 * registered. Other servers only get tournament announcements, and are left
 * again unless an organizer connected them through the website.
 *
 * Empty (the default) keeps the one-server setup: every server the bot is in
 * counts as home and none is ever left.
 */
export const homeGuildId = process.env.HOME_GUILD_ID ?? '';

export const isHomeGuild = (guildId: string) => !homeGuildId || guildId === homeGuildId;

/**
 * Account the payment QR codes point at. The default is the sample IBAN from
 * the QR Platba spec - a placeholder until the real account is filled in.
 */
export const paymentIban = process.env.PAYMENT_IBAN || 'CZ6508000000192000145399';

/**
 * The tournament website. Players create their profile there before they can
 * sign up, and the bot links them to it.
 */
export const siteUrl = (process.env.SITE_URL || 'https://tournevo.com').replace(/\/$/, '');
