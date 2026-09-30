/**
 * Part of `npm run check` - withTimeout gives up on work that never answers,
 * and passes through work that does.
 */

import assert from 'node:assert/strict';
// The module pulls in the bot's config, which wants a token; none is used here.
process.env.DISCORD_TOKEN ??= 'check';
const { withTimeout } = await import('./liveMessages.ts');

assert.equal(await withTimeout('quick', Promise.resolve(7), 1_000), 7);
assert.equal(await withTimeout('hung', new Promise(() => {}), 50), undefined);
await assert.rejects(withTimeout('broken', Promise.reject(new Error('boom')), 1_000), /boom/);

console.log('liveMessages checks passed');
