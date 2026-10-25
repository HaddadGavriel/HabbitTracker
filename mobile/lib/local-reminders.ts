import { requireOptionalNativeModule } from 'expo-modules-core';

export type LocalReminderStatus = {
  status: 'cancelled' | 'stale_lease' | 'permission_blocked' | 'scheduled_os_limited' | 'inexact' | 'repair_required' | 'unsupported' | 'unsupported_timezone' | 'idle' | 'catchup_pending' | 'awaiting_plan' | 'clock_unverified';
  idleQuotaApplies?: boolean;
  clockUncertaintyMs?: number;
};
export type LocalReminderNative = {
  addListener(event: 'onLaunch', listener: () => void): { remove(): void };
  clock(): Promise<number>;
  launchMetadata(): Promise<unknown>;
  acquire(owner: string): Promise<string>;
  replace(lease: string, plan: string, started: number): Promise<LocalReminderStatus>;
  reconcile(lease: string, plan: string, started: number): Promise<LocalReminderStatus>;
  suppress(lease: string, habit: string, localDate: string | null): Promise<LocalReminderStatus>;
  cancelAll(): Promise<LocalReminderStatus>;
  cancel(lease: string): Promise<LocalReminderStatus>;
  status(): Promise<LocalReminderStatus>;
};
/** Android recurrence service. Product calls use future-only reconciliation;
 * a lease fences late work after account replacement/cancellation. No remote sends. */
export const localReminders = requireOptionalNativeModule<LocalReminderNative>('LocalReminders');


/** Only a constant destination is accepted; account claims never authorize content. */
export function localReminderDestination(value: unknown, owner: string): '/today' | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  return data.type === 'local_habit_reminder' && data.target === 'today'
    && typeof data.owner_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.owner_id)
    && data.owner_id.toLowerCase() === owner.toLowerCase() ? '/today' : null;
}
