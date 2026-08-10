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
export const channelId = process.env.CHANNEL_ID ?? '';

/** Channel the rank embed points people at for Master/Apex Predator proof. */
export const rankCheckChannelId = process.env.RANK_CHECK_CHANNEL_ID ?? '';

/**
 * Where /season posts the rank picker when the command is run without the
 * `channel` option. Falls back to the channel the command was used in if this
 * one doesn't exist on the server.
 */
export const rankChannelId = process.env.RANK_CHANNEL_ID ?? '547456557768507392';

/**
 * Master switch for the self-assign rank picker. Off for now: /season only
 * creates the roles, no embed is posted, and reactions hand out nothing.
 * Flip back to true (or set RANK_PICKER=on) to re-enable it.
 */
export const rankPickerEnabled = process.env.RANK_PICKER === 'on';
