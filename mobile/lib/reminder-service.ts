import type { Session } from '@supabase/supabase-js';
import { ApiError, type ReminderResult, type SharedHabitResult } from './api';
import { isTimestamp, reminderEligible, sampleClock, uuidPattern, validReminder, type ClockSample } from './reminder-rules';

export type ReminderRequest = {
  key: string;
  status: ReminderResult['status'] | 'unconfirmed' | 'rejected' | 'cooldown';
  retryAt?: string;
  reminderId?: string;
  result?: ReminderResult;
};
export type ReminderView = { loaded: boolean; busy: boolean; blocked: boolean; requests: ReminderRequest[]; message: string | null };
const empty = (): ReminderView => ({ loaded: false, busy: false, blocked: false, requests: [], message: null });
export const unresolved = (request: ReminderRequest) => ['unconfirmed', 'unknown', 'reserved'].includes(request.status) || (request.status === 'cooldown' && !request.retryAt);
export function cooldownUntil(requests: ReminderRequest[]): string | undefined {
  return requests.map(row => row.retryAt).filter((time): time is string => !!time)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}
export type ReminderDependencies = {
  load(sender: string, habit: string): Promise<unknown>;
  save(sender: string, habit: string, requests: ReminderRequest[]): Promise<void>;
  newKey(): string;
  readSharedHabit(session: Session, habit: string): Promise<SharedHabitResult>;
  requestReminder(session: Session, habit: string, key: string): Promise<ReminderResult>;
  clock?(): ClockSample;
};

/** Application-scoped write-ahead journal, containing only IDs and safe outcomes.
 * No mount, auth event, foreground event, or hydration ever dispatches a reminder.
 * Each sender/habit has a lock that survives screen/account changes.
 */
export class ReminderService {
  private session: Session | null = null;
  private epoch = 0;
  private state: Record<string, ReminderView> = {};
  private listeners = new Set<() => void>();
  private deletedOwners = new Set<string>();
  private writes = new Map<Promise<void>, string>();
  private async saveJournal(sender: string, habit: string, requests: ReminderRequest[]) {
    const work = this.deps.save(sender, habit, requests);
    this.writes.set(work, sender);
    try { await work; } finally { this.writes.delete(work); }
  }
  clearForAccountDeletion = async (owner: string) => {
    this.deletedOwners.add(owner);
    if (this.session?.user.id === owner) this.setSession(null);
    for (const slot of this.journals.keys()) if (JSON.parse(slot)[0] === owner) this.journals.delete(slot);
    for (const slot of this.loads.keys()) if (JSON.parse(slot)[0] === owner) this.loads.delete(slot);
    await Promise.allSettled([...this.writes].filter(([, sender]) => sender === owner).map(([work]) => work));
  };
  private journals = new Map<string, ReminderRequest[]>();
  private loads = new Map<string, Promise<ReminderRequest[]>>();
  private locks = new Set<string>();
  constructor(private deps: ReminderDependencies) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setSession = (session: Session | null) => {
    if (session === this.session) return;
    this.session = session;
    this.epoch++;
    this.state = {};
    this.listeners.forEach(listener => listener());
  };
  private publish(habit: string, view: ReminderView) {
    this.state = { ...this.state, [habit]: view };
    this.listeners.forEach(listener => listener());
  }
  private slot(sender: string, habit: string) { return JSON.stringify([sender, habit]); }
  private async journal(sender: string, habit: string): Promise<ReminderRequest[]> {
    const slot = this.slot(sender, habit);
    const cached = this.journals.get(slot);
    if (cached) return cached;
    const pending = this.loads.get(slot);
    if (pending) return pending;
    const work = this.readJournal(sender, habit, slot);
    this.loads.set(slot, work);
    try { return await work; } finally { this.loads.delete(slot); }
  }
  private async readJournal(sender: string, habit: string, slot: string): Promise<ReminderRequest[]> {
    const value = await this.deps.load(sender, habit);
    if (value !== null && (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object'
      || typeof row.key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(row.key)
      || !['unconfirmed', 'rejected', 'cooldown', 'provider_accepted', 'partially_accepted', 'failed', 'unknown', 'no_devices', 'reserved'].includes(row.status)
      || (row.retryAt !== undefined && !isTimestamp(row.retryAt))
      || (row.reminderId !== undefined && (typeof row.reminderId !== 'string' || !uuidPattern.test(row.reminderId)))
      || (row.result !== undefined && (!validReminder(row.result, habit) || row.result.status !== row.status || row.result.retry_at !== row.retryAt))
      || (!['unconfirmed', 'rejected', 'cooldown'].includes(row.status) && !row.result))
      || new Set(value.map(row => row.key)).size !== value.length)) throw new Error('Invalid reminder journal');
    const rows = (value ?? []) as ReminderRequest[];
    if (!this.deletedOwners.has(sender)) this.journals.set(slot, rows);
    return rows;
  }
  load = async (habit: string, sender: string, refreshedAccess = false) => {
    if (this.deletedOwners.has(sender) || this.session?.user.id !== sender || (this.state[habit]?.loaded && !refreshedAccess) || this.state[habit]?.busy) return;
    const epoch = this.epoch;
    this.publish(habit, { ...empty(), busy: true });
    try {
      const requests = await this.journal(sender, habit);
      if (epoch === this.epoch) this.publish(habit, { ...empty(), loaded: true, busy: this.locks.has(this.slot(sender, habit)), requests });
    } catch {
      if (epoch === this.epoch) this.publish(habit, { ...empty(), message: 'Unable to read saved reminder requests. Retry storage before sending.' });
    }
  };

  /** key means inspect/complete that SAME logical request; absent key is an explicit new request. */
  send = async (habit: string, sender: string, key?: string, acknowledgedUnknownKey?: string) => {
    const session = this.session, epoch = this.epoch, slot = this.slot(sender, habit);
    if (!session || session.user.id !== sender || this.locks.has(slot) || !this.state[habit]?.loaded || this.state[habit]?.blocked) return;
    const current = () => this.epoch === epoch && this.session === session;
    this.locks.add(slot);
    let requests = this.journals.get(slot)!;
    let message: string | null = null, blocked = false;
    this.publish(habit, { ...empty(), loaded: true, busy: true, requests });
    try {
      // Permission is always current at a user action. Replays bypass eligibility,
      // just as on the backend; completing a habit must not strand an old key.
      const started = (this.deps.clock ?? sampleClock)();
      const shared = await this.deps.readSharedHabit(session, habit);
      if (!current()) return;
      if (shared.id !== habit || shared.owner.user_id === sender) throw new Error('Unexpected shared habit');
      let request = key ? requests.find(row => row.key === key) : undefined;
      if (key && (!request || !unresolved(request))) return;
      if (!key) {
        const previous = [...requests].reverse().find(unresolved);
        const retryAt = cooldownUntil(requests);
        if (previous && unresolved(previous) && !previous.retryAt) {
          message = 'Check the saved request first. Its outcome and cooldown are not confirmed.'; return;
        }
        // Use the fresh database timestamp itself, never a fast phone clock, to
        // lift a cooldown. The displayed timer is advisory; refresh verifies it.
        if (retryAt && (!isTimestamp(shared.server_time) || Date.parse(shared.server_time) < Date.parse(retryAt))) {
          message = `Wait until ${retryAt}, then refresh before requesting a new reminder.`; return;
        }
        if (!reminderEligible(shared, started, (this.deps.clock ?? sampleClock)())) {
          message = 'This habit is no longer eligible for a reminder. Refresh its current progress and access.'; return;
        }
        if (previous && unresolved(previous) && acknowledgedUnknownKey !== previous.key) {
          message = 'The earlier outcome is unknown. A new reminder could duplicate a notification already accepted. Confirm a new request explicitly.'; return;
        }
        request = { key: this.deps.newKey(), status: 'unconfirmed' };
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(request.key) || requests.some(row => row.key === request!.key)) throw new Error('Invalid new key');
        // Retain earlier unresolved requests too, including after an explicitly
        // acknowledged new request, so each remains independently checkable.
        requests = [...requests, request];
        this.journals.set(slot, requests);
      }
      // Also write on a check: if a previous write failed ambiguously, the exact
      // same in-memory key must become durable before it can leave this process.
      if (this.deletedOwners.has(sender)) return;
      try { await this.saveJournal(sender, habit, requests); }
      catch { message = 'The request key could not be saved. Nothing was dispatched by this attempt. Retry saving and checking this same request.'; return; }
      if (!current() || !request) return;
      let updated: ReminderRequest;
      try {
        const result = await this.deps.requestReminder(session, habit, request.key);
        if (!validReminder(result, habit) || (request.reminderId && request.reminderId !== result.id)) throw new Error('Unconfirmed response');
        updated = { key: request.key, status: result.status, retryAt: result.retry_at, reminderId: result.id,
          result: { id: result.id, habit_id: result.habit_id, occurrence_id: result.occurrence_id, status: result.status,
            reserved_at: result.reserved_at, finished_at: result.finished_at, retry_at: result.retry_at,
            device_count: result.device_count, accepted_count: result.accepted_count, failed_count: result.failed_count, unknown_count: result.unknown_count } };
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
          blocked = true; message = 'Access could not be verified. Refresh the shared habit or sign in again. The saved request is retained.';
          return;
        }
        if (error instanceof ApiError && error.code === 'reminder_cooldown') {
          updated = { ...request, status: 'cooldown', retryAt: error.retry_at };
          message = error.retry_at ? `Cooldown until ${error.retry_at}. A later reminder needs a new explicit request.` : 'Cooldown is active. Check current server state before trying again.';
        } else if (error instanceof ApiError && (error.status === 409 || error.status === 422)) {
          updated = { ...request, status: 'rejected' };
          message = 'The server rejected this request. Refresh eligibility before explicitly requesting another reminder.';
        } else {
          updated = { ...request, reminderId: error instanceof ApiError ? error.reminder_id ?? request.reminderId : request.reminderId };
          message = 'The outcome could not be confirmed. Check the same saved request; do not replace its key.';
        }
      }
      if (this.deletedOwners.has(sender)) return;
      requests = requests.map(row => row.key === request!.key ? updated : row);
      this.journals.set(slot, requests);
      try { await this.saveJournal(sender, habit, requests); }
      catch { message = 'The result could not be saved. The original request key is retained; check that same request after restarting.'; }
    } catch (error) {
      blocked = true;
      message = error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0)
        ? 'This shared habit is no longer available to this session. Refresh access; saved keys are retained.'
        : 'Unable to verify current access. Refresh the shared habit before trying again. Saved keys are retained.';
    } finally {
      this.locks.delete(slot);
      if (current()) this.publish(habit, { loaded: true, busy: false, blocked, requests: blocked ? [] : requests, message });
      // A refreshed token/remount may have loaded while this older operation was
      // running. Expose only a recovery prompt, never old-session outcome data.
      else if (this.session?.user.id === sender) {
        this.publish(habit, { ...empty(), message: 'Reload saved reminder requests to check the previous attempt.' });
      }
    }
  };
}
