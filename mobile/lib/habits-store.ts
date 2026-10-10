import type { Session } from '@supabase/supabase-js';
import { ApiError, type HabitResult } from './api';
import type { SessionStore } from './session-store';

type SessionSource = Pick<SessionStore, 'snapshot' | 'subscribe'>;
export type HabitsState = {
  habits: HabitResult[];
  hasLoaded: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
};
const emptyState = (): HabitsState => ({ habits: [], hasLoaded: false, loading: false, refreshing: false, error: null });

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Unable to verify your session. Retry, or return Home to sign out and sign in again.';
    if (error.code === 'request_timeout') return 'Loading habits timed out. Please retry.';
    if (error.code === 'network_error') return 'Unable to load your habits. Check your connection and retry.';
  }
  return 'Unable to load your habits. Please retry.';
}

/** Screen-scoped data; session changes invalidate reads before React renders again. */
export class HabitsStore {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  private revision = 0;
  private active = false;
  private unsubscribe?: () => void;

  constructor(private sessions: SessionSource, private listHabits: (session: Session) => Promise<HabitResult[]>) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: HabitsState) { this.state = state; this.listeners.forEach(listener => listener()); }

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
    this.session = null;
    this.publish(emptyState());
  }
  private acceptSession = () => {
    const current = this.sessions.snapshot();
    const session = current.status === 'ready' ? current.session : null;
    if (session === this.session) return;
    const sameUser = !!session && session.user.id === this.session?.user.id;
    this.session = session;
    this.revision++;
    if (!sameUser) this.publish(emptyState());
    if (session) void this.reload();
  };

  reload = async () => {
    const current = this.sessions.snapshot();
    const session = current.session;
    if (!this.active || current.status !== 'ready' || !session) return;
    const revision = ++this.revision;
    this.publish({ ...this.state, loading: !this.state.hasLoaded, refreshing: this.state.hasLoaded, error: null });
    const isCurrent = () => this.active && revision === this.revision
      && this.sessions.snapshot().status === 'ready' && this.sessions.snapshot().session === session;
    try {
      const habits = await this.listHabits(session);
      if (!isCurrent()) return;
      if (habits.some(habit => habit.owner_id !== session.user.id)) throw new Error('Habit owner mismatch');
      this.publish({ habits: habits.filter(habit => habit.archived_at === null), hasLoaded: true, loading: false, refreshing: false, error: null });
    } catch (error) {
      if (!isCurrent()) return;
      this.publish({ ...this.state, loading: false, refreshing: false, error: errorMessage(error) });
    }
  };
}
