import type { Session } from '@supabase/supabase-js';
import type { LocalReminderPlan } from './api';
import type { LocalReminderStatus, LocalReminderNative } from './local-reminders';
import type { SessionState } from './session-store';

export type LocalReminderState = {
  status: 'off' | 'checking' | 'scheduled' | 'denied' | 'error' | 'unsupported';
  enabled: boolean; busy: boolean; permission: 'unknown' | 'granted' | 'denied';
  message: string; lastSuccess: string | null; nativeStatus: LocalReminderStatus['status'] | null;
};
export type LocalReminderDependencies = {
  native: LocalReminderNative | null;
  readPlan(session: Session): Promise<LocalReminderPlan>;
  permission(request: boolean): Promise<boolean>;
  loadEnabled(): Promise<string | null>;
  saveEnabled(owner: string | null): Promise<void>;
};
export type ReminderSuppression = { habitId: string; localDate?: string };

/** Native writes have one queue. Network reads have one coalescing pump, outside
 * that queue so logout never waits for an old account's HTTP response. Every
 * installation is fenced again inside the native queue. Public methods contain
 * failures: a confirmed server mutation must never become a failed habit save. */
export class LocalReminderService {
  private session: Session | null = null;
  private authPending = true;
  private epoch = 0;
  private accountEpoch = 0;
  private acceptedSessions = new WeakSet<Session>();
  private revision = 0;
  private loaded = false;
  private recoveryCheck = true;
  private enabledOwner: string | null = null;
  private lease: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private work: Promise<void> | null = null;
  private pending = false;
  private listeners = new Set<() => void>();
  private state: LocalReminderState = { status: 'off', enabled: false, busy: false,
    permission: 'unknown', message: 'Enable habit reminders on this device.', lastSuccess: null, nativeStatus: null };
  constructor(private deps: LocalReminderDependencies) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<LocalReminderState>) {
    this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener());
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next;
  }
  private async init() {
    if (!this.loaded) {
      try { this.enabledOwner = await this.deps.loadEnabled(); this.loaded = true; }
      catch (error) { await this.cancel(); throw error; }
    }
  }
  private failed() {
    this.publish({ status: 'error', busy: false,
      message: 'Reminder scheduling or cleanup could not be confirmed. Your saved habits are unchanged. Retry / resync reminders; check system notification settings if this continues.' });
  }
  private async cancel() {
    this.lease = null;
    const result = await this.deps.native?.cancelAll();
    if (result && result.status !== 'cancelled') throw new Error('Unconfirmed local cleanup');
  }
  setSession = async (state: SessionState): Promise<void> => {
    if (state.status === 'startup') return;
    // During initial profile hydration, keep a matching persisted opt-in. Do
    // not interpret the temporary loading screen as logout on every restart.
    if (state.status === 'loading' && state.session && !this.session) {
      this.authPending = true;
      const owner = state.session.user.id, epoch = ++this.epoch; this.revision++;
      try {
        await this.exclusive(async () => {
          await this.init();
          if (epoch !== this.epoch) return;
          if (this.enabledOwner !== owner) {
            this.enabledOwner = null; await this.cancel(); await this.deps.saveEnabled(null);
          }
        });
      } catch { if (epoch === this.epoch) this.failed(); }
      return;
    }
    const session = state.status === 'ready' ? state.session : null;
    this.authPending = false;
    if (session && session === this.session && this.loaded) return;
    const old = this.session;
    if (old?.user.id !== session?.user.id) { this.accountEpoch++; this.acceptedSessions = new WeakSet(); }
    if (session) this.acceptedSessions.add(session);
    this.session = session;
    const epoch = ++this.epoch; this.revision++;
    this.publish({ busy: false, ...(!session ? { enabled: false } : {}),
      lastSuccess: old?.user.id === session?.user.id ? this.state.lastSuccess : null });
    try {
      await this.exclusive(async () => {
        if (epoch !== this.epoch) return;
        if (session) await this.init();
        if (epoch !== this.epoch) return;
        if (session && this.recoveryCheck && this.enabledOwner === session.user.id && this.deps.native) {
          // Native cancellation is durable even when the preference removal
          // failed. A stale AsyncStorage opt-in cannot resurrect that tombstone.
          const persisted = await this.deps.native.status();
          if (epoch !== this.epoch) return;
          if (persisted.status === 'cancelled') {
            this.enabledOwner = null; await this.deps.saveEnabled(null);
          }
          this.recoveryCheck = false;
        }
        if (!session || (this.enabledOwner && this.enabledOwner !== session.user.id)
          || (old && old.user.id !== session.user.id)) {
          // Cancel even if preference persistence fails; never leave an old
          // account's alarms active merely because AsyncStorage is unavailable.
          this.enabledOwner = null;
          this.loaded = true;
          try { await this.cancel(); } finally { await this.deps.saveEnabled(null); }
        }
        if (epoch !== this.epoch) return;
        this.publish({ enabled: !!session && this.enabledOwner === session.user.id,
          status: 'off', message: session ? 'Enable habit reminders on this device.' : 'Sign in to enable habit reminders.' });
      });
      if (epoch === this.epoch && session) await this.refresh();
    } catch { if (epoch === this.epoch) this.failed(); }
  };
  enable = async (): Promise<void> => {
    const session = this.session, epoch = ++this.epoch; this.revision++;
    if (!session) return;
    try {
      await this.exclusive(async () => {
        await this.init(); if (epoch !== this.epoch) return;
        this.enabledOwner = session.user.id;
        this.recoveryCheck = false;
        await this.deps.saveEnabled(this.enabledOwner);
        if (epoch === this.epoch) this.publish({ enabled: true });
      });
      if (epoch !== this.epoch) return;
      if (!this.deps.native) { await this.refresh(); return; }
      const allowed = await this.deps.permission(true);
      if (epoch !== this.epoch) return;
      if (!allowed) { await this.blocked(epoch); return; }
      await this.refresh();
    } catch { if (epoch === this.epoch) this.failed(); }
  };
  disable = async (): Promise<void> => {
    const epoch = ++this.epoch; this.revision++; this.pending = false;
    this.publish({ enabled: false, status: 'off', message: 'Disabling habit reminders…' });
    try {
      await this.exclusive(async () => {
        // No read is needed to revoke: cancel also covers a persisted native
        // owner after process death, even when preference storage cannot load.
        this.enabledOwner = null; this.loaded = true;
        try { await this.cancel(); } finally { await this.deps.saveEnabled(null); }
      });
      if (epoch === this.epoch) this.publish({ status: 'off', busy: false, nativeStatus: 'cancelled', message: 'Habit reminders are off on this device.' });
    } catch { if (epoch === this.epoch) this.failed(); }
  };
  /** Call and confirm cleanup before a future account-deletion flow removes auth. */
  beforeAccountDeletion = async (): Promise<void> => {
    await this.disable();
    if (this.state.status === 'error') throw new Error('Retry local reminder cleanup before deleting the account.');
  };
  private async blocked(epoch: number) {
    await this.exclusive(async () => { if (epoch === this.epoch) await this.cancel(); });
    if (epoch === this.epoch) this.publish({ status: 'denied', busy: false, permission: 'denied', nativeStatus: 'permission_blocked',
      message: 'Habit reminders are blocked. Allow notifications and the Habit reminders channel in system settings, then retry / resync. Habit tracking still works.' });
  }
  changed = async (session: Session, suppression?: ReminderSuppression): Promise<void> => {
    if (!this.acceptedSessions.has(session) || session.user.id !== this.session?.user.id) return;
    const accountEpoch = this.accountEpoch; this.revision++;
    const current = () => accountEpoch === this.accountEpoch && session.user.id === this.session?.user.id;
    try {
      if (suppression) await this.exclusive(async () => {
        await this.init();
        if (!current() || this.enabledOwner !== session.user.id || !this.deps.native) return;
        this.lease ??= await this.deps.native.acquire(session.user.id);
        if (!current()) return;
        const result = await this.deps.native.suppress(this.lease, suppression.habitId, suppression.localDate ?? null);
        if (result.status === 'repair_required' || result.status === 'stale_lease') throw new Error('Suppression not confirmed');
      });
      if (current()) await this.refresh();
    } catch { if (current()) this.failed(); }
  };
  refresh = (): Promise<void> => {
    // Foreground/connectivity events may arrive before Auth/profile hydration.
    // Only a definitive signed-out state authorizes startup cleanup.
    if (this.authPending) return Promise.resolve();
    this.pending = true; this.revision++;
    if (!this.work) {
      this.work = this.drain().finally(() => { this.work = null; });
    }
    return this.work;
  };
  private async drain() {
    while (this.pending) {
      this.pending = false;
      const session = this.session, epoch = this.epoch, revision = this.revision;
      const current = () => epoch === this.epoch && revision === this.revision && session === this.session;
      try {
        await this.exclusive(() => this.init());
        if (!current()) continue;
        if (!session || this.enabledOwner !== session.user.id) {
          // Retry also repairs an earlier failed disable or signed-out cleanup.
          await this.exclusive(async () => { if (current()) await this.cancel(); });
          if (current()) this.publish({ status: 'off', enabled: false, busy: false, message: 'Habit reminders are off on this device.' });
          continue;
        }
        const native = this.deps.native;
        if (!native) { this.publish({ status: 'unsupported', busy: false, message: 'Local habit reminders require an Android development or release build. Habit tracking still works.' }); continue; }
        this.publish({ status: 'checking', busy: true, enabled: true, message: 'Refreshing habit reminders…' });
        const allowed = await this.deps.permission(false);
        if (!current()) continue;
        if (!allowed) { await this.blocked(epoch); continue; }
        this.publish({ permission: 'granted' });
        const lease = await this.exclusive(async () => {
          if (!current()) return null;
          this.lease ??= await native.acquire(session.user.id); return this.lease;
        });
        if (!current() || !lease) continue;
        const started = await native.clock();
        const plan = await this.deps.readPlan(session);
        if (!current()) continue;
        if (plan.owner_id !== session.user.id) throw new Error('Reminder plan account mismatch');
        await this.exclusive(async () => {
          if (!current()) return;
          const result = await native.reconcile(lease, JSON.stringify(plan), started);
          if (!current()) return;
          if (result.status === 'permission_blocked') { await this.cancel(); this.publish({ status: 'denied', permission: 'denied', busy: false,
            nativeStatus: result.status, message: 'Habit reminders are blocked. Open system notification settings, allow the Habit reminders channel, then retry / resync.' }); return; }
          this.publish({ nativeStatus: result.status });
          if (!['scheduled_os_limited', 'inexact', 'idle'].includes(result.status)) throw new Error('Scheduling needs repair');
          this.publish({ status: 'scheduled', busy: false, lastSuccess: plan.server_time,
            message: result.status === 'idle' ? 'Reminders synced. No eligible upcoming reminders.'
              : result.status === 'inexact' ? 'Reminders scheduled with inexact alarms. Android may delay them. Allow Alarms & reminders in system settings for more precise timing.'
              : 'Reminders scheduled on this device. Android battery and idle restrictions can delay delivery.' });
        });
      } catch { if (current()) this.failed(); }
    }
  }
}
