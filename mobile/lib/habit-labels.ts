import type { HabitResult } from './api';

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function habitSchedule(habit: HabitResult): string {
  return habit.schedule === 'daily' ? 'Every day' : habit.weekdays.map(day => weekdays[day - 1]).join(', ');
}

export function habitType(habit: HabitResult): string {
  return habit.type === 'binary' ? 'Binary (yes/no)' : `Target: ${habit.target}${habit.unit ? ` ${habit.unit}` : ''}`;
}
