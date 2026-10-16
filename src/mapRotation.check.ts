import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ??= 'check';
process.env.DATABASE_URL = '';
const { buildMapRotationMessage } = await import('./mapRotation.ts');

const now = Date.now();
const start = Math.floor(now / 1000) - 60;
const end = start + 3600;
const window = (map: string, from: number, to: number) => ({ map, start: from, end: to, DurationInMinutes: 60 });
const period = (map: string) => ({ current: window(map, start, end), next: window('Worlds Edge', end, end + 3600) });

for (const map of ['Kings Canyon', 'Map without an image']) {
  const result = await buildMapRotationMessage({ battle_royale: period(map) }, now);
  assert.equal(result.files.length, 1);
  const png = result.files[0]!.attachment;
  assert.ok(Buffer.isBuffer(png));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
}

const missingFile = { ...period('Map with a broken image'), current: { ...window('Map with a broken image', start, end), asset: '/definitely-missing-map-image.png' } };
assert.equal((await buildMapRotationMessage({ battle_royale: missingFile }, now)).files.length, 1);

const malformed = { battle_royale: period(null as unknown as string) };
const fallback = await buildMapRotationMessage(malformed, now);
assert.equal(fallback.files.length, 0);
assert.match(fallback.embeds[0]!.toJSON().description ?? '', /Unknown map/);
assert.equal((await buildMapRotationMessage({ battle_royale: period('Kings Canyon') }, now)).files.length, 1);

const empty = await buildMapRotationMessage({}, now);
assert.equal(empty.files.length, 0);
assert.match(empty.embeds[0]!.toJSON().description ?? '', /temporarily unavailable/);

console.log('map rotation checks passed');
