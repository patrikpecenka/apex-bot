import {
  Events,
  type Client,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import { getRankMessage } from './rankMessageStore.ts';

/**
 * Turns reactions on the live rank message into role assignments.
 *
 * Only the message recorded in the store responds, so older seasons' embeds go
 * inert on their own once a new season is created.
 */
export function registerReactionRoles(client: Client): void {
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handle(reaction, user, 'add');
  });

  client.on(Events.MessageReactionRemove, (reaction, user) => {
    void handle(reaction, user, 'remove');
  });
}

async function handle(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  action: 'add' | 'remove',
): Promise<void> {
  try {
    if (user.bot) return;

    // After a restart the message isn't cached, so events arrive partial.
    if (reaction.partial) await reaction.fetch();

    const guild = reaction.message.guild;
    if (!guild) return;

    const entry = await getRankMessage(guild.id);
    if (!entry || entry.messageId !== reaction.message.id) return;

    const emojiId = reaction.emoji.id;
    const roleId = emojiId ? entry.roles[emojiId] : undefined;

    // The picker accepts exactly the five rank emoji. Anything else a user
    // sticks on it — unicode or another custom emoji — gets wiped, so the
    // message can never accumulate junk reactions.
    if (!roleId) {
      if (action === 'add') {
        await reaction.remove().catch(() => {});
      }
      return;
    }

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    if (action === 'remove') {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, `Unpicked rank for season ${entry.season}`);
      }
      return;
    }

    // One rank at a time: drop the other tiers from this same season first.
    const others = Object.values(entry.roles).filter((id) => id !== roleId);
    const toRemove = others.filter((id) => member.roles.cache.has(id));
    if (toRemove.length > 0) {
      await member.roles.remove(toRemove, `Switching rank for season ${entry.season}`);
    }

    if (!member.roles.cache.has(roleId)) {
      await member.roles.add(roleId, `Picked rank for season ${entry.season}`);
    }

    // Clear their now-stale reactions so the message matches their actual role.
    // Each removal fires a remove event, but those roles are already gone.
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    for (const [, other] of message.reactions.cache) {
      if (other.emoji.id === emojiId) continue;
      if (!other.emoji.id || !entry.roles[other.emoji.id]) continue;
      await other.users.remove(user.id).catch(() => {});
    }
  } catch (error) {
    console.error('Reaction role handling failed:', error);
  }
}
