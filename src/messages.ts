/**
 * Reads the hand-editable message definitions in `content/messages.json` and
 * turns them into something `channel.send()` accepts.
 *
 * The file is meant to be edited directly on the server - so it is re-read on
 * every use (never cached), validated with errors that name the offending key,
 * and every failure is reported to the caller rather than thrown at the bot.
 *
 * Set MESSAGES_FILE to keep the live copy outside the repo, so `git pull` on
 * the server can't collide with hand edits.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AttachmentBuilder,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type Client,
} from 'discord.js';

export const messagesPath =
  process.env.MESSAGES_FILE ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'messages.json');

/** Banners and other images live next to the JSON, so MESSAGES_FILE moves both. */
export const assetsDir = join(dirname(messagesPath), 'assets');

type FieldSpec = {
  name: string;
  value: string;
  inline?: boolean;
};

type EmbedSpec = {
  color?: string | number;
  title?: string;
  url?: string;
  description?: string;
  fields?: FieldSpec[];
  image?: string;
  thumbnail?: string;
  footer?: string;
};

/** One block inside a card. Exactly one of these keys does the work. */
type BlockSpec = {
  /** Markdown. `## Heading` and `-# small text` both work here. */
  text?: string;
  /** Filename in content/assets, or an https:// URL. */
  image?: string;
  /** Several images side by side. */
  images?: string[];
  /** A visible horizontal line. "small" | "large" controls the padding. */
  divider?: 'small' | 'large' | boolean;
  /** Blank space with no line. */
  space?: 'small' | 'large';
};

/**
 * A card is one rounded panel with a coloured bar down its left edge - the
 * layout the Fortnite server uses. `banner` + `text` is shorthand for the usual
 * image / divider / text stack; `blocks` is there when you want finer control.
 */
type CardSpec = {
  color?: string | number;
  banner?: string;
  text?: string;
  blocks?: BlockSpec[];
};

export type MessageDefinition = {
  /** Default target. The command's `channel` option wins over this. */
  channelId?: string;
  /** Plain text. On its own it posts a normal message (link previews work). */
  content?: string;
  embeds?: EmbedSpec[];
  /** Components V2 cards. Cannot be combined with content or embeds. */
  cards?: CardSpec[];
};

type MessagesFile = Record<string, MessageDefinition>;

/** Discord's hard limits. Hitting one here beats a vague 400 from the API. */
const limits = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  /** Components V2 counts every text block in the message against one budget. */
  cardText: 4000,
  /** Containers plus everything nested inside them. */
  components: 40,
};

function parse(raw: string): MessagesFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${messagesPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${messagesPath} must be a JSON object of "key": { ... } entries.`);
  }
  return parsed as MessagesFile;
}

export async function loadMessages(): Promise<MessagesFile> {
  return parse(await readFile(messagesPath, 'utf8'));
}

/**
 * Key list for building the slash command, which has to happen synchronously at
 * import time. A broken file yields no keys instead of taking the bot down with
 * it - `/create` then reports the parse error when someone runs it.
 */
export function messageKeysSync(): string[] {
  try {
    return Object.keys(parse(readFileSync(messagesPath, 'utf8')));
  } catch (error) {
    console.error('Could not read message definitions:', error);
    return [];
  }
}

export async function getMessageDefinition(key: string): Promise<MessageDefinition> {
  const messages = await loadMessages();
  const definition = messages[key];
  if (!definition) {
    const known = Object.keys(messages);
    throw new Error(
      `No "${key}" entry in ${messagesPath}.` +
        (known.length > 0 ? ` Available: ${known.join(', ')}.` : ''),
    );
  }
  return definition;
}

/** Blank strings are how a hand-edited file says "not set". */
function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function parseColor(color: string | number | undefined, key: string): number | undefined {
  if (color === undefined || color === '') return undefined;
  if (typeof color === 'number') return color;
  const hex = color.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    throw new Error(`"${key}": color must be a hex value like "#FF6B00", got "${color}".`);
  }
  return Number.parseInt(hex, 16);
}

function checkLength(text: string, max: number, what: string, key: string): string {
  if (text.length > max) {
    throw new Error(`"${key}": ${what} is ${text.length} characters, Discord's limit is ${max}.`);
  }
  return text;
}

/**
 * `{{user:ID}}` renders a member's name as plain text - no mention, so nobody
 * gets pinged and there is nothing to click through to. That is how inactive
 * staff are listed. Use `<@ID>` for a real (clickable) mention instead.
 */
async function resolvePlaceholders(client: Client, text: string): Promise<string> {
  const ids = [...text.matchAll(/\{\{user:(\d+)\}\}/g)].map((match) => match[1]!);
  if (ids.length === 0) return text;

  const names = new Map<string, string>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      try {
        const user = await client.users.fetch(id);
        names.set(id, user.displayName || user.username);
      } catch {
        names.set(id, `neznámý uživatel (${id})`);
      }
    }),
  );

  return text.replace(/\{\{user:(\d+)\}\}/g, (_, id: string) => names.get(id) ?? id);
}

async function buildEmbed(client: Client, spec: EmbedSpec, key: string): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder();
  const color = parseColor(spec.color, key);
  if (color !== undefined) embed.setColor(color);

  const title = trimmed(spec.title);
  if (title) embed.setTitle(checkLength(title, limits.title, 'title', key));

  const url = trimmed(spec.url);
  if (url) embed.setURL(url);

  const description = trimmed(spec.description);
  if (description) {
    embed.setDescription(
      checkLength(
        await resolvePlaceholders(client, description),
        limits.description,
        'description',
        key,
      ),
    );
  }

  for (const [index, field] of (spec.fields ?? []).entries()) {
    const value = trimmed(field?.value);
    if (!value) {
      throw new Error(`"${key}": field #${index + 1} needs a "value".`);
    }
    // Discord rejects an empty field name, but a headerless field is a
    // legitimate thing to want - a zero-width space renders as nothing.
    const name = trimmed(field?.name) ?? '​';
    embed.addFields({
      name: checkLength(name, limits.fieldName, `field #${index + 1} name`, key),
      value: checkLength(
        await resolvePlaceholders(client, value),
        limits.fieldValue,
        `field #${index + 1} value`,
        key,
      ),
      inline: field.inline ?? false,
    });
  }

  const image = trimmed(spec.image);
  if (image) embed.setImage(image);

  const thumbnail = trimmed(spec.thumbnail);
  if (thumbnail) embed.setThumbnail(thumbnail);

  const footer = trimmed(spec.footer);
  if (footer) {
    embed.setFooter({ text: checkLength(footer, limits.footer, 'footer', key) });
  }

  return embed;
}

/** Collected while rendering, surfaced in the /create reply rather than thrown. */
type RenderContext = {
  key: string;
  files: AttachmentBuilder[];
  warnings: string[];
  /** Every container and every block inside one counts toward Discord's budget. */
  components: number;
};

/**
 * Turns an image reference into something Discord will show. An https:// URL is
 * used as-is; anything else is a file in content/assets, uploaded alongside the
 * message. A missing file is a warning, not an error - the rest of the card
 * still posts, which matters while the artwork is still being made.
 */
function resolveMedia(reference: string, context: RenderContext): string | null {
  if (/^https?:\/\//i.test(reference)) return reference;

  const filename = basename(reference);
  const path = join(assetsDir, filename);

  if (!existsSync(path)) {
    context.warnings.push(`image "${filename}" not found in ${assetsDir} — skipped`);
    return null;
  }

  // Discord keys attachments by name, so upload each one only once.
  if (!context.files.some((file) => file.name === filename)) {
    context.files.push(new AttachmentBuilder(path, { name: filename }));
  }
  return `attachment://${filename}`;
}

function spacingSize(value: 'small' | 'large' | boolean | undefined): SeparatorSpacingSize {
  return value === 'large' ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small;
}

function mediaGallery(references: string[], context: RenderContext): MediaGalleryBuilder | null {
  const urls = references
    .map((reference) => resolveMedia(reference, context))
    .filter((url): url is string => url !== null);
  if (urls.length === 0) return null;

  return new MediaGalleryBuilder().addItems(
    urls.map((url) => new MediaGalleryItemBuilder().setURL(url)),
  );
}

async function addBlock(
  client: Client,
  container: ContainerBuilder,
  block: BlockSpec,
  context: RenderContext,
  where: string,
): Promise<number> {
  const text = trimmed(block.text);
  if (text) {
    const resolved = await resolvePlaceholders(client, text);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(resolved));
    context.components += 1;
    return resolved.length;
  }

  const references = block.images ?? (block.image ? [block.image] : []);
  if (references.length > 0) {
    const gallery = mediaGallery(references, context);
    if (gallery) {
      container.addMediaGalleryComponents(gallery);
      context.components += 1;
    }
    return 0;
  }

  if (block.divider !== undefined && block.divider !== false) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(spacingSize(block.divider)),
    );
    context.components += 1;
    return 0;
  }

  if (block.space !== undefined) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(false).setSpacing(spacingSize(block.space)),
    );
    context.components += 1;
    return 0;
  }

  throw new Error(
    `"${context.key}": ${where} has none of "text", "image", "images", "divider" or "space".`,
  );
}

async function buildCard(
  client: Client,
  card: CardSpec,
  index: number,
  context: RenderContext,
): Promise<{ container: ContainerBuilder; textLength: number }> {
  const container = new ContainerBuilder();
  context.components += 1;
  const color = parseColor(card.color, context.key);
  if (color !== undefined) container.setAccentColor(color);

  // `banner` + `text` expands to the stack the Fortnite cards use: artwork,
  // a hairline, then the copy.
  const blocks: BlockSpec[] = card.blocks ?? [];
  if (blocks.length === 0) {
    if (card.banner) blocks.push({ image: card.banner }, { divider: 'small' });
    if (card.text) blocks.push({ text: card.text });
  }

  if (blocks.length === 0) {
    throw new Error(`"${context.key}": card #${index + 1} is empty.`);
  }

  let textLength = 0;
  for (const [blockIndex, block] of blocks.entries()) {
    textLength += await addBlock(
      client,
      container,
      block,
      context,
      `card #${index + 1} block #${blockIndex + 1}`,
    );
  }

  return { container, textLength };
}

/** Exactly what `channel.send()` / `message.edit()` take, nothing extra. */
export type MessagePayload = {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ContainerBuilder[];
  files?: AttachmentBuilder[];
  flags?: MessageFlags.IsComponentsV2;
  /** Belt and braces: embeds and cards never ping, but a content line could. */
  allowedMentions: { parse: never[] };
};

export type RenderedMessage = {
  payload: MessagePayload;
  /** Non-fatal problems worth telling whoever ran the command about. */
  warnings: string[];
};

export async function renderMessage(
  client: Client,
  key: string,
  definition: MessageDefinition,
): Promise<RenderedMessage> {
  const context: RenderContext = { key, files: [], warnings: [], components: 0 };
  const cards = definition.cards ?? [];

  if (cards.length > 0) {
    // Components V2 owns the whole message: Discord rejects content or embeds
    // alongside it, so say that plainly instead of letting the API 400.
    if (trimmed(definition.content) || (definition.embeds ?? []).length > 0) {
      throw new Error(
        `"${key}": "cards" can't be combined with "content" or "embeds" — Discord treats them as different message types. Split them into two entries.`,
      );
    }
    const containers: ContainerBuilder[] = [];
    let textLength = 0;
    for (const [index, card] of cards.entries()) {
      const built = await buildCard(client, card, index, context);
      containers.push(built.container);
      textLength += built.textLength;
    }

    // The cap is on total components, not on cards - a message can hold well
    // over ten cards as long as their blocks stay within budget.
    if (context.components > limits.components) {
      throw new Error(
        `"${key}": ${cards.length} cards add up to ${context.components} components, Discord's limit per message is ${limits.components}. Move some into a second entry.`,
      );
    }

    if (textLength > limits.cardText) {
      throw new Error(
        `"${key}": the cards hold ${textLength} characters of text, Discord's limit across one message is ${limits.cardText}. Split it into a second message.`,
      );
    }

    return {
      payload: {
        components: containers,
        files: context.files,
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      },
      warnings: context.warnings,
    };
  }

  const specs = definition.embeds ?? [];
  if (specs.length > 10) {
    throw new Error(`"${key}": ${specs.length} embeds, Discord allows at most 10 per message.`);
  }

  const embeds: EmbedBuilder[] = [];
  for (const spec of specs) embeds.push(await buildEmbed(client, spec, key));

  const content = trimmed(definition.content)
    ? await resolvePlaceholders(client, definition.content!.trim())
    : '';

  if (embeds.length === 0 && !content) {
    throw new Error(`"${key}": nothing to post - it has no "content", "embeds" or "cards".`);
  }

  return {
    payload: { content, embeds, allowedMentions: { parse: [] } },
    warnings: context.warnings,
  };
}
