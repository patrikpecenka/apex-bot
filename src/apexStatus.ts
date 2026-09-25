/**
 * "Is it down, or is it just me?" — the Apex/EA server status behind `/status`.
 *
 * Same API and the same failure handling as the map rotation: a key check up
 * front, a short retry for the network blips the host is prone to, and errors
 * that carry a readable message rather than a stack.
 */

import { EmbedBuilder } from 'discord.js';
import { apexApiKey } from './config.ts';
import { isTransientNetworkError } from './mapRotation.ts';

/** Region -> state. The API repeats this shape for every service it checks. */
type ServiceStatus = Record<string, { Status?: string; ResponseTime?: number }>;

export type ServerStatusData = Record<string, ServiceStatus>;

/**
 * Services worth showing, in the order people care about, with names that mean
 * something to a player. Anything the API adds later is skipped rather than
 * dumped in raw - except `selfCoreTest`, which is the API testing itself.
 */
const services: { key: string; label: string }[] = [
  { key: 'ApexOauth_Crossplay', label: 'Apex crossplay' },
  { key: 'EA_novafusion', label: 'EA Novafusion' },
  { key: 'EA_accounts', label: 'EA účty' },
  { key: 'Origin_login', label: 'Přihlášení EA' },
  { key: 'otherPlatforms', label: 'Konzole' },
];

const stateIcons: Record<string, string> = {
  UP: '🟢',
  SLOW: '🟠',
  OVERLOADED: '🟠',
  DOWN: '🔴',
};

const colors = { up: 0x2ecc71, slow: 0xf9a01b, down: 0xed4245 } as const;

// The command is public and will get spammed the moment anything wobbles; the
// API allows 5 requests a second and the data doesn't move faster than this.
const cacheMs = 60_000;
let cached: { at: number; data: ServerStatusData } | null = null;

async function requestStatus(): Promise<ServerStatusData> {
  const res = await fetch(`https://api.mozambiquehe.re/servers?auth=${apexApiKey}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { Error?: string } | null;
    throw new Error(body?.Error ?? `Apex API vrátilo ${res.status}`);
  }
  return (await res.json()) as ServerStatusData;
}

export async function fetchServerStatus(): Promise<ServerStatusData> {
  if (!apexApiKey) {
    throw new Error(
      'Chybí APEX_API_KEY. Klíč zdarma je na https://api.mozambiquehe.re/getkey — nastav ho v env.',
    );
  }

  if (cached && Date.now() - cached.at < cacheMs) return cached.data;

  const attempts = 2;
  for (let attempt = 1; ; attempt++) {
    try {
      const data = await requestStatus();
      cached = { at: Date.now(), data };
      return data;
    } catch (error) {
      if (attempt >= attempts || !isTransientNetworkError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/** True when the cache would answer the next call without a request. */
export function statusIsCached(): boolean {
  return cached !== null && Date.now() - cached.at < cacheMs;
}

function normalize(status: string | undefined): string {
  return (status ?? 'UNKNOWN').toUpperCase();
}

export function buildServerStatusEmbed(data: ServerStatusData): EmbedBuilder {
  let anyDown = false;
  let anySlow = false;

  const embed = new EmbedBuilder().setTitle('Stav serverů Apex Legends');

  for (const { key, label } of services) {
    const service = data[key];
    if (!service) continue;

    const regions = Object.entries(service);
    if (regions.length === 0) continue;

    const problems = regions.filter(([, region]) => normalize(region.Status) !== 'UP');
    for (const [, region] of problems) {
      if (normalize(region.Status) === 'DOWN') anyDown = true;
      else anySlow = true;
    }

    // All good is one line; only the regions with something wrong get listed,
    // otherwise this is seven lines of green per service.
    const value =
      problems.length === 0
        ? `${stateIcons.UP} Všechny regiony běží`
        : problems
            .map(
              ([name, region]) =>
                `${stateIcons[normalize(region.Status)] ?? '⚪'} ${name} — ${normalize(region.Status)}`,
            )
            .join('\n');

    embed.addFields({ name: label, value });
  }

  if (!embed.data.fields?.length) {
    throw new Error('Apex API nevrátilo použitelná data o serverech.');
  }

  embed
    .setColor(anyDown ? colors.down : anySlow ? colors.slow : colors.up)
    .setDescription(
      anyDown
        ? 'Něco je mimo — není to jen u tebe.'
        : anySlow
          ? 'Některé regiony jsou pomalé nebo přetížené.'
          : 'Všechno vypadá v pořádku.',
    )
    .setTimestamp(new Date());

  return embed;
}
