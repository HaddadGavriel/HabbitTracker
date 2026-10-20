import type { ReminderResult, SharedHabitResult } from './api';

import { isTimestamp, uuidPattern } from './api';
export { isTimestamp, uuidPattern };
export type ClockSample = { wall: number; monotonic: number };
export const sampleClock = (): ClockSample => ({ wall: Date.now(), monotonic: typeof performance === 'undefined' ? Date.now() : performance.now() });

/** Start timing BEFORE the read, overestimating age by its full network latency.
 * Neither changing the phone's timezone nor winding its clock back extends access.
 */
export function serverNow(serverTime: string, started: ClockSample, now = sampleClock()): number | null {
  const wall = now.wall - started.wall, monotonic = now.monotonic - started.monotonic;
  if (!isTimestamp(serverTime) || !Number.isFinite(wall) || !Number.isFinite(monotonic) || wall < 0 || monotonic < 0) return null;
  return Date.parse(serverTime) + Math.max(wall, monotonic);
}
export function reminderEligible(habit: SharedHabitResult, started: ClockSample | null, now = sampleClock()): boolean {
  const occurrence = habit.occurrence;
  if (!started || !habit.due_today || !occurrence || occurrence.completed !== false || occurrence.state !== 'in_progress'
    || occurrence.local_date !== habit.local_date || !isTimestamp(occurrence.closes_at)) return false;
  const time = serverNow(habit.server_time, started, now);
  // A small margin also avoids an enabled control right on the original deadline.
  if (time === null || time + 1_000 >= Date.parse(occurrence.closes_at)) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: habit.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(time + 1_000);
    const part = (type: string) => parts.find(value => value.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}` === habit.local_date;
  } catch { return false; }
}
export const reminderLabels: Record<ReminderResult['status'], string> = {
  provider_accepted: 'Accepted by the notification provider for all selected devices. This does not confirm phone delivery.',
  partially_accepted: 'Accepted by the notification provider for some devices; others failed or have an unknown outcome. This does not confirm phone delivery.',
  failed: 'All selected devices failed or were rejected. No provider acceptance was confirmed.',
  unknown: 'The outcome is unknown. A notification may already have been accepted.',
  no_devices: 'The owner had no registered devices. No notification was submitted.',
  reserved: 'The request was reserved, but no final outcome is recorded. It may still be running or may never finish.',
};
export function validReminder(value: unknown, habitId: string): value is ReminderResult {
  if (!value || typeof value !== 'object') return false;
  const row = value as ReminderResult;
  return typeof row.id === 'string' && uuidPattern.test(row.id) && row.habit_id === habitId
    && typeof row.occurrence_id === 'string' && uuidPattern.test(row.occurrence_id)
    && Object.hasOwn(reminderLabels, row.status) && isTimestamp(row.reserved_at) && isTimestamp(row.retry_at)
    && Date.parse(row.retry_at) >= Date.parse(row.reserved_at)
    && (row.status === 'reserved' ? row.finished_at === null : isTimestamp(row.finished_at))
    && [row.device_count, row.accepted_count, row.failed_count, row.unknown_count].every(n => Number.isSafeInteger(n) && n >= 0);
}
