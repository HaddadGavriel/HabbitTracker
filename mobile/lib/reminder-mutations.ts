import type { Session } from '@supabase/supabase-js';

export type ReminderSuppression = { habitId: string; localDate?: string };
export type ReminderMutations = {
  changed(session: Session, suppression?: ReminderSuppression): Promise<void>;
};

/** A confirmed server write stays successful even if notification scheduling fails.
 * The application service owns scheduling status/retry; stores never retry a save
 * because the OS, local persistence, or a subsequent plan refresh failed.
 */
export function reconcileReminders(reminders: ReminderMutations | undefined, session: Session, suppression?: ReminderSuppression) {
  try { void reminders?.changed(session, suppression).catch(() => {}); }
  catch { /* A synchronous adapter failure is also independent of the server save. */ }
}
