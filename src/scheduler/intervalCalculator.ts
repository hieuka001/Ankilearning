import { computeDecayFactor, forgettingCurve, FSRS6_DECAY } from 'ts-fsrs/models/fsrs-6';
import type { SchedulerStep } from '../models/fsrs';

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

// FSRS-6 forgetting curve (source: ts-fsrs/models/fsrs-6, the same model the
// scheduler engine runs): R(t, S) = (1 + FACTOR * t / S) ^ (-DECAY), where
// FACTOR is calibrated so that R(S, S) = 0.9 for the default weights.
export const FSRS_DECAY = FSRS6_DECAY;
export const FSRS_FACTOR = computeDecayFactor(FSRS6_DECAY).factor;

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

export const round = (value: number, precision = 2) => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

export const daysBetween = (from: Date, to: Date) =>
  Math.max(0, (to.getTime() - from.getTime()) / DAY_MS);

export const addStep = (date: Date, step: SchedulerStep) =>
  new Date(date.getTime() + step.amount * (step.unit === 'minute' ? MINUTE_MS : DAY_MS));

export const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * DAY_MS);

export const calculateRetrievability = (stability: number, elapsedDays: number) => {
  if (stability <= 0) return 1;
  return clamp(forgettingCurve(FSRS_DECAY, Math.max(0, elapsedDays), stability), 0, 1);
};

export const intervalForRetention = (
  stability: number,
  desiredRetention: number,
  intervalModifier = 1,
  maximumInterval = 36500,
) => {
  const retention = clamp(desiredRetention, 0.7, 0.98);
  // Inverse of the FSRS-6 forgetting curve: t = S / FACTOR * (R ^ (-1 / DECAY) - 1)
  const rawInterval = (Math.max(0.1, stability) / FSRS_FACTOR)
    * (retention ** (-1 / FSRS_DECAY) - 1)
    * intervalModifier;
  return clamp(Math.round(rawInterval), 1, maximumInterval);
};

// Inverse mapping used only to infer a stability for legacy cards that carry
// an Anki/SM-2 style scheduled interval but no FSRS stability yet.
export const stabilityForScheduledDays = (
  scheduledDays: number,
  desiredRetention: number,
  intervalModifier = 1,
) => {
  const retention = clamp(desiredRetention, 0.7, 0.98);
  const modifier = Math.max(0.1, intervalModifier);
  const stability = (Math.max(0, scheduledDays) * FSRS_FACTOR)
    / ((retention ** (-1 / FSRS_DECAY) - 1) * modifier);
  return Math.max(0.1, stability);
};

// Local study-day key (yyyy-MM-dd in the user's local timezone). This is the
// single day-boundary convention for scheduler/queue internals.
export const getStudyDayKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const stepToDays = (step: SchedulerStep) =>
  step.unit === 'day' ? step.amount : step.amount / (24 * 60);

export const formatScheduledDelay = (delay: SchedulerStep | { amount: number; unit: 'day' }) => {
  if (delay.unit === 'minute') {
    return delay.amount < 60 ? `${delay.amount} phút` : `${round(delay.amount / 60, 1)} giờ`;
  }

  if (delay.amount < 1) {
    const hours = Math.max(1, Math.round(delay.amount * 24));
    return `${hours} giờ`;
  }

  return `${round(delay.amount, 1).toString().replace(/\.0$/, '')} ngày`;
};
