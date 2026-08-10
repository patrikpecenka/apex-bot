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
};

/**
 * Master switch for the self-assign rank picker. Off for now: /season only
 * creates the roles, no embed is posted, and reactions hand out nothing.
 * Flip back to true (or set RANK_PICKER=on) to re-enable it.
 */
export const rankPickerEnabled = process.env.RANK_PICKER === 'on';

/** Free key from https://api.mozambiquehe.re/getkey — powers /maprotation. */
export const apexApiKey = process.env.APEX_API_KEY ?? '';
