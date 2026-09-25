/**
 * Custom id format for buttons and menus: `feature:action[:payload]`.
 *
 * Discord hands the id straight back on click, which is what lets a button
 * survive a restart - the bot works out what to do from the id plus whatever
 * the feature's store remembers, never from an in-memory collector.
 *
 * Kept separate from the registry so features can build ids without importing
 * the registry that imports them.
 */

import type { MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';

/** Discord's limit on a custom id. */
const maxLength = 100;

export type ComponentHandler = (
  // Modal submits route here too - their custom id follows the same format.
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  action: string,
  payload: string,
) => Promise<void>;

export function componentId(feature: string, action: string, payload?: string): string {
  const id = payload ? `${feature}:${action}:${payload}` : `${feature}:${action}`;
  if (id.length > maxLength) {
    throw new Error(`Custom id "${id}" is ${id.length} characters, Discord's limit is ${maxLength}.`);
  }
  return id;
}

export function parseComponentId(customId: string): {
  feature: string;
  action: string;
  payload: string;
} {
  const [feature = '', action = '', ...rest] = customId.split(':');
  return { feature, action, payload: rest.join(':') };
}
