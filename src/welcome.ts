/**
 * DMs a new member the "welcome-dm" message from content/messages.json.
 *
 * The text lives in the same hand-editable file as the welcome and rules cards
 * and is rendered by the same code, so changing what new people are told needs
 * no redeploy - and `/create welcome-dm` posts the very same content into a
 * channel if you want to preview it.
 *
 * Needs the privileged GuildMembers intent, which is why it is off unless
 * WELCOME_DM=on: asking for an intent that isn't enabled in the Developer
 * Portal makes login fail outright.
 */

import { Events, type Client, type GuildMember } from 'discord.js';
import { isHomeGuild } from './config.ts';
import { getMessageDefinition, renderMessage } from './messages.ts';

const messageKey = 'welcome-dm';

/** Warn once per problem, not once per member joining. */
let warnedMissing = false;

async function sendWelcome(member: GuildMember): Promise<void> {
  if (member.user.bot) return;

  let payload;
  try {
    const definition = await getMessageDefinition(messageKey);
    payload = (await renderMessage(member.client, messageKey, definition)).payload;
  } catch (error) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.error(`Welcome DM is on but the "${messageKey}" message can't be built:`, error);
    }
    return;
  }

  try {
    await member.send(payload);
  } catch {
    // Closed DMs are the normal case, not a fault. Nothing to fall back to:
    // pinging them in a channel instead would be worse than staying quiet.
    console.log(`Couldn't DM ${member.user.tag} — their DMs are closed.`);
  }
}

export function registerWelcomeDm(client: Client): void {
  client.on(Events.GuildMemberAdd, (member) => {
    // Organizers' servers are theirs - the welcome belongs to the home server.
    if (!isHomeGuild(member.guild.id)) return;
    void sendWelcome(member).catch((error: unknown) => {
      console.error('Welcome DM failed:', error);
    });
  });
}
