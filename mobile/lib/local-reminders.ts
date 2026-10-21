import { requireOptionalNativeModule } from 'expo-modules-core';

export type LocalReminderStatus = {
  status: 'cancelled' | 'stale_lease' | 'permission_blocked' | 'scheduled_os_limited' | 'inexact' | 'repair_required' | 'unsupported' | 'idle' | 'catchup_pending' | 'awaiting_plan' | 'clock_unverified';
  idleQuotaApplies?: boolean;
  clockUncertaintyMs?: number;
};
type Native = {
  addListener(event: 'onLaunch', listener: () => void): { remove(): void };
  clock(): Promise<number>;
  launchMetadata(): Promise<unknown>;
  acquire(owner: string): Promise<string>;
  replace(lease: string, plan: string, started: number): Promise<LocalReminderStatus>;
  cancel(lease: string): Promise<LocalReminderStatus>;
  status(): Promise<LocalReminderStatus>;
};
/** Foundation API only. Next PR wires session, preferences and product mutations.
 * A lease fences late work after account replacement/cancellation. No remote sends.
 */
export const localReminders = requireOptionalNativeModule<Native>('LocalReminders');


/** Only a constant destination is accepted; account claims never authorize content. */
export function localReminderDestination(value: unknown, owner: string): '/today' | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  return data.type === 'local_habit_reminder' && data.target === 'today'
    && typeof data.owner_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.owner_id)
    && data.owner_id.toLowerCase() === owner.toLowerCase() ? '/today' : null;
}
