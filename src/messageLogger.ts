/**
 * Writes every message in a server to `data/logs/<guildId>.log` once its
 * owner has run `/allow-logger true`. One line per message:
 *
 *   2026-11-12T10:00:00.000Z | #general (123) | Display Name @username (456) | "text"
 *
 * The content is JSON-quoted so a multi-line message stays on one line.
 * Needs the privileged MessageContent intent, hence MESSAGE_LOGGER=on.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Events, type Client, type Message } from 'discord.js';
import { createJsonStore } from './jsonStore.ts';

const logDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'logs');

/** guildId -> logging on. A missing entry means off. */
export const loggerStore = createJsonStore<boolean>('messageLogger.json');

export function formatLogLine(message: Message<true>): string {
  const name = message.member?.displayName ?? message.author.displayName;
  return [
    message.createdAt.toISOString(),
    `#${message.channel.name} (${message.channelId})`,
    `${name} @${message.author.username} (${message.author.id})`,
    JSON.stringify(message.content),
  ].join(' | ') + '\n';
}

async function logMessage(message: Message): Promise<void> {
  if (!message.inGuild()) return;
  if (!(await loggerStore.get(message.guildId))) return;
  await mkdir(logDir, { recursive: true });
  await appendFile(join(logDir, `${message.guildId}.log`), formatLogLine(message));
}

export function registerMessageLogger(client: Client): void {
  client.on(Events.MessageCreate, (message) => {
    void logMessage(message).catch((error: unknown) => {
      console.error('Message log write failed:', error);
    });
  });
}
