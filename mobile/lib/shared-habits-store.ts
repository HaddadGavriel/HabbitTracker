import type { Session } from '@supabase/supabase-js';
import { ApiError, type SharedHabitResult } from './api';
import { sampleClock, type ClockSample } from './reminder-rules';
import type { SessionStore } from './session-store';

type SessionSource = Pick<SessionStore, 'snapshot' | 'subscribe'>;
type API = {
  listSharedHabits(session: Session): Promise<SharedHabitResult[]>;
  readSharedHabit(session: Session, id: string): Promise<SharedHabitResult>;
};
export type SharedHabitsState = {
  observedAt: ClockSample | null;
  habits: SharedHabitResult[];
  habit: SharedHabitResult | null;
  hasLoaded: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  inaccessible: boolean;
};
const emptyState = (): SharedHabitsState => ({
  observedAt: null, habits: [], habit: null, hasLoaded: false, loading: false, refreshing: false, error: null, inaccessible: false,
});

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Unable to verify your session. Retry, or open Settings to sign out and sign in again.';
    if (error.code === 'profile_not_found') return 'Your profile is no longer available. Return Home to check your account.';
    if (error.status === 403 || error.status === 404 || error.code === 'habit_not_found') {
      return 'This shared habit is no longer available. Sharing or friendship may have ended, or the owner may have archived the habit.';
    }
    if (error.code === 'request_timeout') return 'Loading shared habits timed out. Please retry to check current access.';
    if (error.code === 'network_error') return 'Unable to load shared habits. Check your connection and retry to check current access.';
  }
  return 'Unable to load shared habits. Please retry to check current access.';
}

/** No shared data survives blur, an account/token change, or an unverified read.
 * Detail always fetches its own authorization; list rows never seed a detail cache.
 */
export class SharedHabitsStore {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private active = false;
  private session: Session | null = null;
  private accessToken: string | null = null;
  private revision = 0;
  private unsubscribe?: () => void;

  constructor(private sessions: SessionSource, private api: API, private habitId?: string) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: SharedHabitsState) { this.state = state; this.listeners.forEach(listener => listener()); }
  private currentSession() {
    const current = this.sessions.snapshot();
    return this.active && current.status === 'ready' && current.session === this.session
      && current.session?.access_token === this.accessToken ? current.session : null;
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
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session = null;
    this.accessToken = null;
    this.publish(emptyState());
  }
  private acceptSession = () => {
    const current = this.sessions.snapshot();
    const session = current.status === 'ready' ? current.session : null;
    if (session === this.session && (session?.access_token ?? null) === this.accessToken) return;
    this.session = session;
    this.accessToken = session?.access_token ?? null;
    this.revision++;
    this.publish(emptyState());
    if (session) void this.reload();
  };

  private validate(habit: SharedHabitResult, session: Session) {
    if (!habit || typeof habit.id !== 'string' || !habit.owner || typeof habit.owner.user_id !== 'string'
      || habit.owner.user_id === session.user.id || (this.habitId && habit.id !== this.habitId)
      || !Number.isSafeInteger(habit.current_streak) || habit.current_streak < 0
      || typeof habit.provisional !== 'boolean' || typeof habit.due_today !== 'boolean'
      || habit.due_today !== (habit.occurrence !== null)) {
      throw new Error('Invalid shared habit response');
    }
  }

  private reload = async () => {
    const session = this.currentSession();
    if (!session) return;
    const revision = ++this.revision;
    const previouslyLoaded = this.state.hasLoaded;
    // A previous response is not evidence of current permission. Hide it while
    // checking and keep it removed on every error, including ambiguous failures.
    this.publish({ ...emptyState(), hasLoaded: previouslyLoaded, loading: !previouslyLoaded, refreshing: previouslyLoaded });
    const isCurrent = () => revision === this.revision && this.currentSession() === session;
    const observedAt = sampleClock();
    try {
      const rows = this.habitId ? [await this.api.readSharedHabit(session, this.habitId)] : await this.api.listSharedHabits(session);
      if (!isCurrent()) return;
      if (!Array.isArray(rows)) throw new Error('Invalid shared habit list');
      rows.forEach(row => this.validate(row, session));
      if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate shared habit');
      this.publish({ ...emptyState(), observedAt, hasLoaded: true, habits: this.habitId ? [] : rows, habit: this.habitId ? rows[0] : null });
    } catch (error) {
      if (!isCurrent()) return;
      this.publish({ ...emptyState(), error: errorMessage(error),
        inaccessible: error instanceof ApiError && (error.status === 403 || error.status === 404 || error.code === 'habit_not_found') });
    }
  };

  refresh = async () => {
    if (this.state.loading || this.state.refreshing) return;
    await this.reload();
  };
}
