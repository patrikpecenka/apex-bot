/**
 * The one JSON-file store the rest of the bot builds on.
 *
 * Every store here follows the same rules: runtime state (never content) lives
 * in the gitignored `data/` dir, the file is read once and kept in memory, and
 * a missing or corrupt file reads as empty rather than throwing - losing the
 * remembered ids costs a feature its memory, not the bot its uptime.
 *
 * Writes are serialised per store: two handlers reacting to the same event
 * would otherwise interleave read-modify-write and drop one of the changes.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export type JsonStore<T> = {
  /** Everything in the file - a copy, so callers can't mutate the cache. */
  all(): Promise<Record<string, T>>;
  get(key: string): Promise<T | null>;
  set(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
};

export function createJsonStore<T>(filename: string): JsonStore<T> {
  const storePath = join(dataDir, filename);

  let cache: Record<string, T> | null = null;
  // Tail of the write queue. Each save chains onto the previous one.
  let writing: Promise<void> = Promise.resolve();

  async function load(): Promise<Record<string, T>> {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await readFile(storePath, 'utf8')) as unknown;
      // A hand-edited file could hold anything; anything that isn't an object
      // of entries is treated as "no state yet".
      cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, T>)
        : {};
    } catch {
      cache = {};
    }
    return cache;
  }

  function save(): Promise<void> {
    const next = writing.then(async () => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(storePath, JSON.stringify(cache ?? {}, null, 2));
    });
    // The caller still sees a failed write (create.ts reports it), but the
    // queue tail must stay resolved or one bad write poisons every later one.
    writing = next.catch(() => {});
    return next;
  }

  return {
    async all() {
      return { ...(await load()) };
    },
    async get(key) {
      return (await load())[key] ?? null;
    },
    async set(key, value) {
      (await load())[key] = value;
      await save();
    },
    async remove(key) {
      delete (await load())[key];
      await save();
    },
  };
}
