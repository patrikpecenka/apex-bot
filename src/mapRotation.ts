import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
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

export type MapRotationData = {
  battle_royale: MapPeriod;
  ranked: MapPeriod;
  wildcard: MapPeriod;
};

export async function fetchMapRotation(): Promise<MapRotationData> {
  if (!apexApiKey) {
    throw new Error(
      'Missing APEX_API_KEY. Get a free key from https://api.mozambiquehe.re/getkey and set it in the env.',
    );
  }

  const res = await fetch(`https://api.mozambiquehe.re/maprotation?version=2&auth=${apexApiKey}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { Error?: string } | null;
    throw new Error(body?.Error ?? `Apex status API returned ${res.status}`);
  }
  return (await res.json()) as MapRotationData;
}

type RotationMode = 'battle_royale' | 'ranked' | 'wildcard';

const modeLabels: Record<RotationMode, string> = {
  battle_royale: 'BR Pubs',
  ranked: 'BR Ranked',
  wildcard: 'Wildcard',
};

const modes = Object.keys(modeLabels) as RotationMode[];

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), 'assets');

// PebbleHost's container has no system fonts installed, so text would fail
// to render (or fall back to nothing) without bundling and registering one.
GlobalFonts.registerFromPath(join(assetsDir, 'fonts', 'BebasNeue-Regular.ttf'), 'Bebas Neue');

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
const imageCache = new Map<string, Promise<Image>>();

/** Prefers our bundled art (consistent style, no network dependency); falls
 * back to the API's own splash art URL for maps we don't have locally. */
function getMapImage(mapName: string, assetUrl?: string): Promise<Image> | null {
  const localFile = mapImageFiles[normalizeMapName(mapName)];
  const source = localFile ? join(assetsDir, localFile) : assetUrl || null;
  if (!source) return null;

  let promise = imageCache.get(source);
  if (!promise) {
    promise = loadImage(source);
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
  ctx.fillStyle = '#8fa0b3';
  ctx.font = '16px "Bebas Neue"';
  ctx.fillText('UP NEXT', pad, y + 20);

  ctx.fillStyle = '#ffffff';
  ctx.font = '36px "Bebas Neue"';
  ctx.fillText(next.map, pad, y + 58);

  ctx.fillStyle = '#aab2bd';
  ctx.font = '20px "Bebas Neue"';
  ctx.fillText(`${formatClock(next.start)} - ${formatClock(next.end)}`, pad, y + STRIP_H - pad + 4);
}

async function renderModeCard(label: string, period: MapPeriod, nowMs: number): Promise<Buffer> {
  const canvas = createCanvas(CARD_W, CARD_H);
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

  ctx.fillStyle = '#c9c9c9';
  ctx.font = '26px "Bebas Neue"';
  ctx.fillText(
    `From ${formatClock(period.current.start)} to ${formatClock(period.current.end)}`,
    textX,
    heroY + HERO_H / 2 + 42,
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

export async function buildMapRotationMessage(data: MapRotationData, nowMs: number): Promise<RenderedMapRotation> {
  const embeds: EmbedBuilder[] = [];
  const files: AttachmentBuilder[] = [];

  for (const mode of modes) {
    const image = await renderModeCard(modeLabels[mode], data[mode], nowMs);

    const filename = `map-rotation-${mode}.png`;
    files.push(new AttachmentBuilder(image, { name: filename }));
    embeds.push(new EmbedBuilder().setColor(mapRotationEmbedColor).setImage(`attachment://${filename}`));
  }

  return { embeds, files };
}
