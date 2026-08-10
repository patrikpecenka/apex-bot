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

    // One rank at a time: swap the other tiers from this same season for the
    // picked one in a single roles.set() call, so it's one API round-trip
    // instead of a remove-then-add pair (which is what made the old rank
    // visibly linger).
    const others = Object.values(entry.roles).filter((id) => id !== roleId);
    const hadOthers = others.some((id) => member.roles.cache.has(id));
    const hadRole = member.roles.cache.has(roleId);

    if (hadOthers || !hadRole) {
      const nextRoles = new Set(member.roles.cache.keys());
      for (const id of others) nextRoles.delete(id);
      nextRoles.add(roleId);
      await member.roles.set([...nextRoles], `Picked rank for season ${entry.season}`);
    }

    // Clear their now-stale reactions so the message matches their actual role.
    // Each removal fires a remove event, but those roles are already gone.
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    await Promise.all(
      [...message.reactions.cache.values()]
        .filter((other) => other.emoji.id !== emojiId && other.emoji.id && entry.roles[other.emoji.id])
        .map((other) => other.users.remove(user.id).catch(() => {})),
    );
  } catch (error) {
    console.error('Reaction role handling failed:', error);
  }
}
