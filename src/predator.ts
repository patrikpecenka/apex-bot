/**
 * Apex Predator / Master cutoffs, as a message that keeps itself current.
 *
 * Same shape as the map rotation: one tracked message per guild, refreshed on
 * the shared loop, self-healing when someone deletes it by hand. The numbers
 * move slowly, so this ticks every ten minutes rather than every minute.
 */

import { EmbedBuilder, type BaseMessageOptions } from 'discord.js';
import { apexApiKey } from './config.ts';
import { createJsonStore } from './jsonStore.ts';
import { isTransientNetworkError } from './mapRotation.ts';
import { registerLiveMessage } from './liveMessages.ts';

type PredatorPlatform = {
  /** RP needed for the last Predator spot. */
  val?: number;
  foundRank?: number;
  totalMastersAndPreds?: number;
  updateTimestamp?: number;
};

/**
 * Ranked cutoffs live under `RP`, with `AP` holding the (long dead) arenas
 * numbers. Older responses put the platforms at the top level instead, so both
 * are accepted - the alternative is the card silently emptying out one day.
 */
type PredatorData = {
  RP?: Record<string, PredatorPlatform>;
} & Partial<Record<string, PredatorPlatform>>;

export type PredatorMessage = { channelId: string; messageId: string };

export const predatorStore = createJsonStore<PredatorMessage>('predatorMessages.json');

/** API key -> readable label, in the order the server cares about. */
const platformLabels: { key: string; label: string }[] = [
  { key: 'PC', label: 'PC' },
  { key: 'PS4', label: 'PlayStation' },
  { key: 'X1', label: 'Xbox' },
  { key: 'SWITCH', label: 'Switch' },
];

const embedColor = 0xf9ff03; // The Apex Predator role colour.

async function requestPredator(): Promise<PredatorData> {
  const res = await fetch(`https://api.mozambiquehe.re/predator?auth=${apexApiKey}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { Error?: string } | null;
    throw new Error(body?.Error ?? `Apex API vrátilo ${res.status}`);
  }
  return (await res.json()) as PredatorData;
}

export async function fetchPredator(): Promise<PredatorData> {
  if (!apexApiKey) {
    throw new Error(
      'Chybí APEX_API_KEY. Klíč zdarma je na https://api.mozambiquehe.re/getkey — nastav ho v env.',
    );
  }

  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestPredator();
    } catch (error) {
      if (attempt >= attempts || !isTransientNetworkError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
}

const numberFormat = new Intl.NumberFormat('cs-CZ');

export function buildPredatorMessage(data: PredatorData, nowMs: number): BaseMessageOptions {
  const ranked = data.RP ?? (data as Record<string, PredatorPlatform>);

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('Hranice pro Apex Predator')
    .setDescription(`Aktualizováno <t:${Math.floor(nowMs / 1000)}:R>`);

  for (const { key, label } of platformLabels) {
    const platform = ranked[key];
    if (!platform || typeof platform.val !== 'number') continue;

    const lines = [`**${numberFormat.format(platform.val)}** RP`];
    if (typeof platform.totalMastersAndPreds === 'number') {
      lines.push(`${numberFormat.format(platform.totalMastersAndPreds)} Masterů + Predátorů`);
    }

    embed.addFields({ name: label, value: lines.join('\n'), inline: true });
  }

  if (!embed.data.fields?.length) {
    throw new Error('Apex API nevrátilo použitelná data o predátorech.');
  }

  return { embeds: [embed], allowedMentions: { parse: [] } };
}

registerLiveMessage({
  name: 'Predator cutoff refresh',
  intervalMs: 10 * 60_000,
  store: predatorStore,
  render: async () => buildPredatorMessage(await fetchPredator(), Date.now()),
});
