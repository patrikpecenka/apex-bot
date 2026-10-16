import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import type { Image, SKRSContext2D } from '@napi-rs/canvas';
import { fork } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apexApiKey } from './config.ts';

type MapWindow = {
  start: number;
  end: number;
  map: string;
  DurationInMinutes: number;
  /** Official splash art URL — used when we don't have a bundled asset for this map. */
  asset?: string;
};

type MapPeriod = {
  current: MapWindow;
  next: MapWindow;
};

// Not every mode is guaranteed present on a given response — e.g. wildcard
// isn't always active.
export type MapRotationData = {
  battle_royale?: MapPeriod;
  ranked?: MapPeriod;
  wildcard?: MapPeriod;
};

// The host's egress to Cloudflare drops out for seconds at a time. These are
// the codes that means "the network blinked", as opposed to the API actually
// rejecting us — worth another go, and not worth a stack trace in the log.
const transientNetworkCodes = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** True for a network blip we expect to recover on its own. */
export function isTransientNetworkError(error: unknown): boolean {
  // `fetch` wraps the real reason in `cause`; a timeout surfaces as TimeoutError.
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  const code = (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code ?? (error as { code?: unknown })?.code;
  return typeof code === 'string' && transientNetworkCodes.has(code);
}

/** One-line description, for log lines that don't warrant a full stack. */
export function describeError(error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause;
  if (cause instanceof Error) return `${error instanceof Error ? error.message : String(error)} (${cause.message})`;
  return error instanceof Error ? error.message : String(error);
}

async function requestMapRotation(): Promise<MapRotationData> {
  const res = await fetch(`https://api.mozambiquehe.re/maprotation?version=2&auth=${apexApiKey}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { Error?: string } | null;
    throw new Error(body?.Error ?? `Apex API vrátilo ${res.status}`);
  }
  return (await res.json()) as MapRotationData;
}

export async function fetchMapRotation(): Promise<MapRotationData> {
  if (!apexApiKey) {
    throw new Error(
      'Chybí APEX_API_KEY. Klíč zdarma je na https://api.mozambiquehe.re/getkey – nastav ho v env.',
    );
  }

  // Retry the blips in-tick: waiting the full 60s for the next tick means a
  // visibly stale countdown ring, and these outages last seconds. Worst case
  // stays under the refresh interval, and the in-flight guard covers overrun.
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestMapRotation();
    } catch (error) {
      // A 4xx/5xx from the API itself won't fix itself by asking again.
      if (attempt >= attempts || !isTransientNetworkError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
}

type RotationMode = 'battle_royale' | 'ranked' | 'wildcard';

const modeLabels: Record<RotationMode, string> = {
  battle_royale: 'BR Pubs',
  ranked: 'BR Ranked',
  wildcard: 'Wildcard',
};

const modes = Object.keys(modeLabels) as RotationMode[];

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), 'assets');

// Loaded only in the renderer child. A native crash must not exit the bot.
let canvasModule: typeof import('@napi-rs/canvas') | null = null;

async function loadCanvas(): Promise<void> {
  if (canvasModule) return;
  canvasModule = await import('@napi-rs/canvas');
  try {
    canvasModule.GlobalFonts.registerFromPath(join(assetsDir, 'fonts', 'BebasNeue-Regular.ttf'), 'Bebas Neue');
  } catch (error) {
    console.error('Failed to register the map rotation font; cards will render without it:', error);
  }
}

const mapImageFiles: Record<string, string> = {
  kingscanyon: 'Kings_Canyon.png',
  worldsedge: 'Worlds_Edge.png',
  stormpoint: 'Storm_Point.png',
  brokenmoon: 'Broken_Moon.png',
  edistrict: 'E-District.png',
  skulltown: 'Arena_Skulltown.png',
};

function normalizeMapName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Decoded images are reused across panels/renders within the process — the
// same map often appears more than once across separate mode cards.
const imageCache = new Map<string, Promise<Image | null>>();

/** Prefers our bundled art (consistent style, no network dependency); falls
 * back to the API's own splash art URL for maps we don't have locally. */
function getMapImage(mapName: string, assetUrl?: string): Promise<Image | null> | null {
  const localFile = mapImageFiles[normalizeMapName(mapName)];
  const source = localFile ? join(assetsDir, localFile) : assetUrl || null;
  if (!source) return null;

  let promise = imageCache.get(source);
  if (!promise) {
    promise = canvasModule!.loadImage(source).catch((error: unknown) => {
      console.warn(`Map image unavailable for ${mapName}:`, error);
      return null;
    });
    imageCache.set(source, promise);
  }
  return promise;
}

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Prague',
});

function formatClock(unixSecs: number): string {
  return timeFormatter.format(new Date(unixSecs * 1000));
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Draws `img` into the x/y/w/h box, cropped to cover it (like CSS background-size: cover). */
function drawCover(ctx: SKRSContext2D, img: Image, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

const CARD_W = 760;
const CARD_H = 430;
const HEADER_H = 56;
const HERO_H = 280;
const STRIP_H = CARD_H - HEADER_H - HERO_H;

function drawRing(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  radius: number,
  startSecs: number,
  endSecs: number,
  nowMs: number,
): void {
  const nowSecs = nowMs / 1000;
  const total = endSecs - startSecs;
  const remaining = Math.max(0, endSecs - nowSecs);
  const fraction = total > 0 ? Math.min(1, remaining / total) : 0;

  ctx.lineWidth = 12;
  ctx.lineCap = 'round';

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#2ecc71';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = '40px "Bebas Neue"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatDuration(remaining), cx, cy);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

async function drawNextStrip(ctx: SKRSContext2D, y: number, next: MapWindow): Promise<void> {
  const img = await getMapImage(next.map, next.asset);
  if (img) {
    drawCover(ctx, img, 0, y, CARD_W, STRIP_H);
  } else {
    ctx.fillStyle = '#12151d';
    ctx.fillRect(0, y, CARD_W, STRIP_H);
  }

  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(0, y, CARD_W, STRIP_H);

  const pad = 20;
  const midY = y + STRIP_H / 2;

  ctx.fillStyle = '#8fa0b3';
  ctx.font = '22px "Bebas Neue"';
  ctx.textBaseline = 'middle';
  ctx.fillText('UP NEXT', pad, midY);
  const labelWidth = ctx.measureText('UP NEXT').width;
  ctx.textBaseline = 'alphabetic';

  const groupX = pad + labelWidth + 22;
  ctx.fillStyle = '#ffffff';
  ctx.font = '32px "Bebas Neue"';
  ctx.fillText(next.map, groupX, midY - 4);

  ctx.fillStyle = '#d5dbe3';
  ctx.font = '28px "Bebas Neue"';
  ctx.fillText(`${formatClock(next.start)}–${formatClock(next.end)}`, groupX, midY + 28);
}

async function renderModeCard(label: string, period: MapPeriod, nowMs: number): Promise<Buffer> {
  const canvas = canvasModule!.createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  ctx.fillStyle = '#151922';
  ctx.fillRect(0, 0, CARD_W, HEADER_H);
  ctx.fillStyle = '#ffffff';
  ctx.font = '36px "Bebas Neue"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, CARD_W / 2, HEADER_H / 2 + 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const heroY = HEADER_H;
  const heroImg = await getMapImage(period.current.map, period.current.asset);
  if (heroImg) {
    drawCover(ctx, heroImg, 0, heroY, CARD_W, HERO_H);
  } else {
    ctx.fillStyle = '#1c2230';
    ctx.fillRect(0, heroY, CARD_W, HERO_H);
  }

  const wash = ctx.createLinearGradient(0, heroY, 0, heroY + HERO_H);
  wash.addColorStop(0, 'rgba(0, 0, 0, 0.35)');
  wash.addColorStop(1, 'rgba(0, 0, 0, 0.75)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, heroY, CARD_W, HERO_H);

  const textX = 36;
  ctx.fillStyle = '#ffffff';
  ctx.font = '80px "Bebas Neue"';
  ctx.fillText(period.current.map, textX, heroY + HERO_H / 2 + 8);

  ctx.fillStyle = '#d5dbe3';
  ctx.font = '36px "Bebas Neue"';
  ctx.fillText(
    `From ${formatClock(period.current.start)} to ${formatClock(period.current.end)}`,
    textX,
    heroY + HERO_H / 2 + 48,
  );

  drawRing(ctx, CARD_W - 115, heroY + HERO_H / 2, 74, period.current.start, period.current.end, nowMs);

  await drawNextStrip(ctx, heroY + HERO_H, period.next);

  return canvas.encode('png');
}

export const mapRotationEmbedColor = 0x1abc9c;

export type RenderedMapRotation = {
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
};

export async function buildMapRotationMessageUnsafe(data: MapRotationData, nowMs: number): Promise<RenderedMapRotation> {
  await loadCanvas();
  const embeds: EmbedBuilder[] = [];
  const files: AttachmentBuilder[] = [];

  for (const mode of modes) {
    // Not every mode is always present — e.g. wildcard isn't always active.
    const period = data[mode];
    if (!period?.current || !period.next) continue;

    const image = await renderModeCard(modeLabels[mode], period, nowMs);

    const filename = `map-rotation-${mode}.png`;
    files.push(new AttachmentBuilder(image, { name: filename }));
    embeds.push(new EmbedBuilder().setColor(mapRotationEmbedColor).setImage(`attachment://${filename}`));
  }

  if (embeds.length === 0) {
    throw new Error('Apex API nevrátilo použitelná data o rotaci map.');
  }

  return { embeds, files };
}


// Skip the image that crashed native rendering; try images again when the rotation changes.
let rendererDisabledFor: string | null = null;

function renderKey(data: MapRotationData): string {
  return JSON.stringify(modes.map((mode) => {
    const period = data?.[mode];
    return [period?.current?.map, period?.current?.asset, period?.current?.start, period?.current?.end,
      period?.next?.map, period?.next?.asset, period?.next?.start, period?.next?.end];
  }));
}

type RendererReply = {
  embeds: ReturnType<EmbedBuilder['toJSON']>[];
  files: { name: string; image: string }[];
};

function renderInChild(data: MapRotationData, nowMs: number): Promise<RendererReply> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./mapRotationWorker.ts', import.meta.url)), [], {
      execArgv: ['--experimental-strip-types'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      rendererDisabledFor = renderKey(data);
      child.kill('SIGKILL');
      finish(new Error('map renderer timed out after 30 seconds'));
    }, 30_000);
    function finish(error?: Error, reply?: RendererReply): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      if (error) reject(error);
      else resolve(reply!);
    }
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (signal || code !== 0) rendererDisabledFor = renderKey(data);
      finish(new Error(`map renderer exited: ${signal ?? code}`));
    });
    child.once('message', (message: RendererReply | { error: string } | null) => {
      if (!message) finish(new Error('map renderer sent no result'));
      else if ('error' in message) finish(new Error(message.error));
      else finish(undefined, message);
    });
    child.send({ data, nowMs }, (error) => { if (error) finish(error); });
  });
}

function textFallback(data: MapRotationData): RenderedMapRotation {
  const lines = modes.flatMap((mode) => {
    const period = data?.[mode];
    if (!period?.current || !period.next) return [];
    const name = (value: unknown) => typeof value === 'string' && value.trim() ? value.slice(0, 100) : 'Unknown map';
    return [`**${modeLabels[mode]}:** ${name(period.current.map)} → ${name(period.next.map)}`];
  });
  return {
    embeds: [new EmbedBuilder().setColor(mapRotationEmbedColor)
      .setTitle('Map rotation')
      .setDescription(lines.join('\n') || 'Map rotation data is temporarily unavailable.')],
    files: [],
  };
}

export async function buildMapRotationMessage(data: MapRotationData, nowMs: number): Promise<RenderedMapRotation> {
  if (rendererDisabledFor === renderKey(data)) return textFallback(data);
  try {
    const rendered = await renderInChild(data, nowMs);
    return {
      embeds: rendered.embeds.map((embed) => new EmbedBuilder(embed)),
      files: rendered.files.map(({ name, image }) => new AttachmentBuilder(Buffer.from(image, 'base64'), { name })),
    };
  } catch (error) {
    console.error('Map rotation image render failed; using text:', error);
    return textFallback(data);
  }
}
