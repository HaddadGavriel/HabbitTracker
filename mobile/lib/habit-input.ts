import type { HabitCreate, HabitWeekday } from './api';

export type HabitDraft = {
  name: string;
  description: string;
  type: 'binary' | 'target';
  target: string;
  unit: string;
  schedule: 'daily' | 'selected';
  weekdays: number[];
  reminderTimes: string;
};

export function emptyHabitDraft(): HabitDraft {
  return {
    name: '', description: '', type: 'binary', target: '', unit: '',
    schedule: 'daily', weekdays: [], reminderTimes: '',
  };
}

/** Validate the form without mutating it, so failed submissions retain every value. */
export function habitInput(draft: HabitDraft): HabitCreate {
  const name = draft.name.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 100) {
    throw new Error('Name must be 1–100 characters.');
  }
  if (Array.from(draft.description).length > 1000) {
    throw new Error('Description must be 1,000 characters or fewer.');
  }

  // Daily schedules discard previously selected days when the form is switched.
  const weekdays = draft.schedule === 'daily' ? [] : [...draft.weekdays];
  if (draft.schedule === 'selected' && weekdays.length === 0) {
    throw new Error('Select at least one weekday.');
  }
  if (new Set(weekdays).size !== weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error('Select distinct weekdays from Monday through Sunday.');
  }

  const reminderTimes = draft.reminderTimes.split(',').map(time => time.trim());
  if (reminderTimes.length === 1 && reminderTimes[0] === '') {
    throw new Error('Enter at least one reminder time in HH:MM format, such as 08:00.');
  }
  if (reminderTimes.some(time => !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time))) {
    throw new Error('Use 24-hour HH:MM reminder times separated by commas, such as 08:00, 21:30.');
  }
  if (new Set(reminderTimes).size !== reminderTimes.length) {
    throw new Error('Reminder times must be distinct. Remove duplicate times.');
  }

  const common = {
    name,
    ...(draft.description !== '' ? { description: draft.description } : {}),
    schedule: draft.schedule,
    weekdays: weekdays.sort((a, b) => a - b) as HabitWeekday[],
    reminder_times: reminderTimes.sort(),
  };
  // Hidden target fields never leak into a binary habit's payload.
  if (draft.type === 'binary') return { ...common, type: 'binary' };

  const targetText = draft.target.trim();
  const target = Number(targetText);
  if (!/^[0-9]+$/.test(targetText) || target <= 0 || !Number.isInteger(target)) {
    throw new Error('Target must be a positive whole number.');
  }
  // The backend supports larger integers, but JSON numbers must remain exact in JS.
  if (!Number.isSafeInteger(target)) {
    throw new Error('Target must be 9,007,199,254,740,991 or less so the app can save it exactly.');
  }
  const unit = draft.unit.trim();
  if (Array.from(unit).length > 30) {
    throw new Error('Unit must be 30 characters or fewer.');
  }
  return { ...common, type: 'target', target, ...(unit ? { unit } : {}) };
}
