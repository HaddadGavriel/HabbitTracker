import type { HabitResult, HabitUpdate } from './api';
import { habitInput, type HabitDraft } from './habit-input';

export function habitDraft(habit: HabitResult): HabitDraft {
  return {
    name: habit.name,
    description: habit.description ?? '',
    type: habit.type,
    target: habit.type === 'target' ? String(habit.target) : '',
    unit: habit.unit ?? '',
    schedule: habit.schedule,
    weekdays: [...habit.weekdays],
    reminderTimes: habit.reminder_times.join(', '),
  };
}

const sameValues = <T,>(left: T[], right: T[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** Validate the resulting configuration, then send only intentional changes. */
export function habitChanges(original: HabitResult, draft: HabitDraft): HabitUpdate | null {
  const targetUnchanged = original.type === 'target' && draft.target.trim() === String(original.target);
  const input = habitInput({
    ...draft,
    type: original.type,
    // A server target can exceed JS precision. Unchanged targets must neither be
    // resubmitted as rounded numbers nor prevent editing unrelated fields.
    target: targetUnchanged ? '1' : draft.target,
  });
  const changes: HabitUpdate = {};
  if (input.name !== original.name) changes.name = input.name;
  // Both null and "" appear blank. An untouched blank must preserve its baseline.
  if (draft.description !== (original.description ?? '')) changes.description = input.description ?? null;
  if (input.schedule !== original.schedule) {
    changes.schedule = input.schedule;
    changes.weekdays = input.weekdays;
  } else if (!sameValues(input.weekdays, original.weekdays)) {
    changes.weekdays = input.weekdays;
  }
  if (!sameValues(input.reminder_times, original.reminder_times)) changes.reminder_times = input.reminder_times;
  if (original.type === 'target' && input.type === 'target') {
    if (!targetUnchanged && input.target !== original.target) changes.target = input.target;
    const unit = input.unit ?? null;
    if (unit !== original.unit) changes.unit = unit;
  }
  return Object.keys(changes).length ? changes : null;
}
