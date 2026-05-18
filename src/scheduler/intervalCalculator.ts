import type { SchedulerStep } from '../models/fsrs';

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

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
  return clamp((1 + elapsedDays / (9 * stability)) ** -1, 0, 1);
};

export const intervalForRetention = (
  stability: number,
  desiredRetention: number,
  intervalModifier = 1,
  maximumInterval = 36500,
) => {
  const retention = clamp(desiredRetention, 0.7, 0.98);
  const rawInterval = 9 * Math.max(0.1, stability) * (1 / retention - 1) * intervalModifier;
  return clamp(Math.round(rawInterval), 1, maximumInterval);
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
