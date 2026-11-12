import assert from 'node:assert/strict';
import type { Message } from 'discord.js';
import { formatLogLine } from './messageLogger.ts';

const fake = {
  createdAt: new Date('2026-11-12T10:00:00.000Z'),
  channel: { name: 'general' },
  channelId: '111',
  member: { displayName: 'Patrik' },
  author: { id: '222', username: 'patrik', displayName: 'P' },
  content: 'hi\nthere',
} as unknown as Message<true>;

assert.equal(
  formatLogLine(fake),
  '2026-11-12T10:00:00.000Z | #general (111) | Patrik @patrik (222) | "hi\\nthere"\n',
);
console.log('messageLogger ok');
