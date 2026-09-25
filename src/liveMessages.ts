/**
 * The bot's background clock.
 *
 * Two things register here:
 *   - live messages: one payload rendered per tick and edited into every
 *     message a store is tracking (map rotation, predator cutoff)
 *   - plain tasks: anything else that has to happen on an interval, like
 *     expiring LFG posts or sweeping abandoned voice rooms
 *
 * Both get the same treatment: a single shared interval, an in-flight guard so
 * a stalled tick can't pile up behind itself, and errors that are logged rather
 * than thrown - a background job must never be able to take the bot down.
 */

import type { BaseMessageOptions, Client } from 'discord.js';
import { describeError, isTransientNetworkError } from './mapRotation.ts';
import { databasePaused, pauseOnLoginFailure } from './db.ts';

/** How often the loop looks for due work. Task intervals round up to this. */
const tickMs = 15_000;

type Task = {
  name: string;
  intervalMs: number;
  run: (client: Client) => Promise<void>;
  /** Talks to the website's database: skipped while a rejected login has it paused. */
  database?: boolean;
  running: boolean;
  lastRun: number;
};

const tasks: Task[] = [];

/** A recurring background job. Runs once at startup, then every intervalMs. */
export function registerTask(options: {
  name: string;
  intervalMs: number;
  run: (client: Client) => Promise<void>;
  database?: boolean;
}): void {
  tasks.push({ ...options, running: false, lastRun: 0 });
}

/** The subset of a JsonStore a live message needs - handy for tests and fakes. */
type TrackedMessages<T> = {
  all(): Promise<Record<string, T>>;
  remove(key: string): Promise<void>;
};

/**
 * Keeps every message a store is tracking up to date with one freshly rendered
 * payload. A message that has been deleted by hand drops out of the store, so
 * the feature heals itself instead of logging the same 404 forever.
 */
export function registerLiveMessage<T extends { channelId: string; messageId: string }>(options: {
  name: string;
  intervalMs: number;
  store: TrackedMessages<T>;
  render: () => Promise<BaseMessageOptions>;
}): void {
  registerTask({
    name: options.name,
    intervalMs: options.intervalMs,
    run: async (client) => {
      const entries = Object.entries(await options.store.all());
      // Nothing is tracked - don't spend an API call rendering for nobody.
      if (entries.length === 0) return;

      const rendered = await options.render();

      for (const [key, { channelId, messageId }] of entries) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        const message = channel?.isTextBased()
          ? await channel.messages.fetch(messageId).catch(() => null)
          : null;
        if (!message) {
          await options.store.remove(key);
          continue;
        }

        await message.edit(rendered).catch(() => {});
      }
    },
  });
}

async function runTask(task: Task, client: Client): Promise<void> {
  // A stalled run can outlast the interval; skip rather than pile up.
  if (task.running || (task.database && databasePaused())) return;
  task.running = true;
  task.lastRun = Date.now();

  try {
    await task.run(client);
  } catch (error) {
    if (task.database && pauseOnLoginFailure(error)) return;
    // A network blip is routine here and self-corrects; a full stack trace
    // every time would bury the failures that actually need looking at.
    if (isTransientNetworkError(error)) {
      console.warn(`${task.name} skipped (network): ${describeError(error)} — retrying next tick.`);
    } else {
      console.error(`${task.name} failed:`, error);
    }
  } finally {
    task.running = false;
  }
}

/** Starts the loop. Safe to call once the client is ready. */
export function startLiveMessages(client: Client): void {
  setInterval(() => {
    const now = Date.now();
    for (const task of tasks) {
      if (now - task.lastRun >= task.intervalMs) void runTask(task, client);
    }
  }, tickMs);

  for (const task of tasks) void runTask(task, client);
}
