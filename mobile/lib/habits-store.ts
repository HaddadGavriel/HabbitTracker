import type { Session } from '@supabase/supabase-js';
import { ApiError, type HabitResult, type HabitStatus } from './api';
import type { SessionStore } from './session-store';
import { reconcileReminders, type ReminderMutations } from './reminder-mutations';

type SessionSource = Pick<SessionStore, 'snapshot' | 'subscribe'>;
export type HabitFilter = Exclude<HabitStatus, 'all'>;
export type HabitsState = {
  habits: HabitResult[];
  status: HabitFilter;
  hasLoaded: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  restoreConfirmation: HabitResult | null;
  restoringId: string | null;
  restoreError: string | null;
  restoreUncertain: boolean;
};
const emptyState = (status: HabitFilter = 'active', restoringId: string | null = null): HabitsState => ({
  habits: [], status, hasLoaded: false, loading: false, refreshing: false, error: null,
  restoreConfirmation: null, restoringId, restoreError: null, restoreUncertain: false,
});

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Unable to verify your session. Retry, or open Settings to sign out and sign in again.';
    if (error.code === 'request_timeout') return 'Loading habits timed out. Please retry.';
    if (error.code === 'network_error') return 'Unable to load your habits. Check your connection and retry.';
  }
  return 'Unable to load your habits. Please retry.';
}

/** Screen-scoped data; account, filter, and navigation changes invalidate earlier work. */
export class HabitsStore {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  private revision = 0;
  private readRevision = 0;
  private active = false;
  private unsubscribe?: () => void;
  // Keep the request guard through token refreshes and screen/filter changes until it settles.
  private pendingRestores = new Map<string, { id: string; revision: number }>();

  constructor(
    private sessions: SessionSource,
    private listHabits: (session: Session, status: HabitFilter) => Promise<HabitResult[]>,
    private restoreHabit: (session: Session, id: string) => Promise<HabitResult>,
    private reminders?: ReminderMutations,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: HabitsState) { this.state = state; this.listeners.forEach(listener => listener()); }
  private currentSession() {
    const current = this.sessions.snapshot();
    return this.active && current.status === 'ready' && current.session?.user.id === this.session?.user.id ? current.session : null;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.unsubscribe = this.sessions.subscribe(this.acceptSession);
    this.acceptSession();
  }
  stop() {
    this.active = false;
    this.revision++;
    this.readRevision++;
    this.unsubscribe?.();
    this.session = null;
    this.publish(emptyState());
  }
  private acceptSession = () => {
    const current = this.sessions.snapshot();
    const session = current.status === 'ready' ? current.session : null;
    if (session === this.session) return;
    const sameUser = !!session && session.user.id === this.session?.user.id;
    this.session = session;
    this.readRevision++;
    if (!sameUser) {
      this.revision++;
      this.publish(emptyState('active', session ? this.pendingRestores.get(session.user.id)?.id ?? null : null));
    }
    if (session) void this.reload();
  };

  setStatus = (status: HabitFilter) => {
    if (!this.currentSession() || status === this.state.status) return;
    this.revision++;
    this.readRevision++;
    this.publish(emptyState(status, this.state.restoringId));
    void this.reload();
  };

  reload = async () => {
    const session = this.currentSession();
    if (!session || this.pendingRestores.get(session.user.id)?.revision === this.revision) return;
    const revision = ++this.readRevision;
    const status = this.state.status;
    this.publish({ ...this.state, loading: !this.state.hasLoaded, refreshing: this.state.hasLoaded, error: null, restoreConfirmation: null });
    const isCurrent = () => this.active && revision === this.readRevision && this.currentSession() === session;
    try {
      const habits = await this.listHabits(session, status);
      if (!isCurrent()) return;
      if (habits.some(habit => habit.owner_id !== session.user.id)) throw new Error('Habit owner mismatch');
      this.publish({ ...this.state,
        habits: habits.filter(habit => status === 'active' ? habit.archived_at === null : habit.archived_at !== null),
        hasLoaded: true, loading: false, refreshing: false, error: null,
        restoreError: this.state.restoreUncertain ? null : this.state.restoreError, restoreUncertain: false,
      });
    } catch (error) {
      if (!isCurrent()) return;
      this.publish({ ...this.state, loading: false, refreshing: false, error: errorMessage(error) });
    }
  };

  // UI refresh actions are single-flight; internal reloads may supersede stale reads.
  refreshServerState = async () => {
    if (this.state.loading || this.state.refreshing) return;
    await this.reload();
  };

  requestRestore = (habit: HabitResult) => {
    const session = this.currentSession();
    if (!session || this.state.status !== 'archived' || !this.state.habits.includes(habit)
      || habit.archived_at === null || this.state.loading || this.state.refreshing
      || this.pendingRestores.has(session.user.id) || this.state.restoreUncertain) return;
    this.publish({ ...this.state, restoreConfirmation: habit, restoreError: null });
  };
  cancelRestore = (habit: HabitResult) => {
    if (this.state.restoreConfirmation !== habit) return;
    this.publish({ ...this.state, restoreConfirmation: null });
  };
  confirmRestore = async (habit: HabitResult) => {
    const session = this.currentSession();
    if (!session || this.state.restoreConfirmation !== habit || this.state.status !== 'archived'
      || this.state.loading || this.state.refreshing || this.state.restoreUncertain
      || this.pendingRestores.has(session.user.id)) return;
    const operation = { id: habit.id, revision: this.revision };
    this.pendingRestores.set(session.user.id, operation);
    this.publish({ ...this.state, restoreConfirmation: null, restoringId: habit.id, restoreError: null });
    const isCurrent = () => this.revision === operation.revision && this.currentSession()?.user.id === session.user.id;
    let restored = false;
    try {
      const result = await this.restoreHabit(session, habit.id);
      if (result.id !== habit.id || result.owner_id !== session.user.id || result.archived_at !== null) {
        throw new ApiError('Unexpected restore response', 200, 'invalid_response');
      }
      reconcileReminders(this.reminders, session);
      if (!isCurrent()) return;
      restored = true;
      // The confirmed result remains reflected even if the following list refresh fails.
      this.publish({ ...this.state, habits: this.state.habits.filter(item => item.id !== habit.id) });
    } catch (error) {
      if (!isCurrent()) return;
      const definite = error instanceof ApiError && (error.code === 'configuration_error'
        || (error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 408 && error.code !== 'request_timeout'));
      const message = !definite
        ? 'We could not confirm whether this habit was restored. It may have succeeded. Refresh current server state before deciding to restore again.'
        : error instanceof ApiError && error.status === 401
          ? 'Unable to verify your session. Open Settings to sign out and sign in again, or retry restoring.'
          : error instanceof ApiError && error.code === 'habit_not_found'
            ? 'This habit is no longer available. Refresh your habits to check the current server state.'
            : 'Unable to restore this habit. Please try again.';
      this.publish({ ...this.state, restoreError: message, restoreUncertain: !definite });
    } finally {
      this.pendingRestores.delete(session.user.id);
      if (this.currentSession()?.user.id === session.user.id) this.publish({ ...this.state, restoringId: null });
    }
    if (restored && isCurrent()) await this.reload();
  };
}
