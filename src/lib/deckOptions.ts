import {
  normalizeSchedulerConfig,
  type SchedulerConfig,
  type SchedulerConfigInput,
} from './spacedRepetition';
import type { Deck, DeckOptions } from '../types';

/**
 * Per-deck scheduler options (đợt 3A).
 *
 * A deck may carry `options` overriding a small subset of the user's global
 * scheduler config. Resolution rule: a field that is PRESENT on the deck
 * (anything other than `undefined`) wins; an absent field inherits the
 * global value. `0` is a real override, not "absent" — the underlying
 * normalizeSchedulerConfig already treats 0 as valid for the daily limits
 * and the leech threshold (0 = no new cards / no reviews / every lapse is a
 * leech), so the merge below only skips `undefined`, never falsy values.
 *
 * The merged result always goes through normalizeSchedulerConfig, exactly
 * like the global config does everywhere else, so clamping and defaults
 * behave identically with or without deck options. A deck without options
 * therefore resolves to precisely the normalized global config.
 */

type DeckOptionsSource = Pick<Deck, 'options'> | null | undefined;

const OVERRIDE_KEYS = [
  'newCardsPerDay',
  'reviewsPerDay',
  'desiredRetention',
  'leechThreshold',
] as const satisfies readonly (keyof DeckOptions)[];

export function resolveDeckSchedulerConfig(
  globalConfig?: SchedulerConfigInput,
  deck?: DeckOptionsSource,
): SchedulerConfig {
  const merged: SchedulerConfigInput = { ...(globalConfig ?? {}) };
  const options = deck?.options;
  if (options) {
    for (const key of OVERRIDE_KEYS) {
      const value = options[key];
      // Only `undefined` means "inherit". Copying an explicit undefined over
      // the global value would silently drop it (normalize falls back to the
      // built-in default, not to the global config), so skip it instead.
      if (value !== undefined) merged[key] = value;
    }
  }
  return normalizeSchedulerConfig(merged);
}

export function resolveDeckDailyLimits(
  globalConfig?: SchedulerConfigInput,
  deck?: DeckOptionsSource,
): { newCardsPerDay: number; reviewsPerDay: number } {
  const effective = resolveDeckSchedulerConfig(globalConfig, deck);
  return {
    newCardsPerDay: effective.newCardsPerDay,
    reviewsPerDay: effective.reviewsPerDay,
  };
}
