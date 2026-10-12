import type { Session } from '@supabase/supabase-js';
import { ApiError, type TodayResult } from './api';
import type { SessionStore } from './session-store';

type TodayState = {
  // Keep the server's date/timezone and occurrences together, including on failure.
  today: TodayResult | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
};
const emptyState = (): TodayState => ({ today: null, loading: false, refreshing: false, error: null });

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Unable to verify your session. Retry, or return Home to sign out and sign in again.';
    if (error.code === 'request_timeout') return 'Loading Today timed out. Please retry.';
    if (error.code === 'network_error') return 'Unable to load Today. Check your connection and retry.';
  }
  return 'Unable to load Today. Please retry.';
}

/** Screen-scoped server snapshots; no client scheduling or state transitions. */
export class TodayStore {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  private revision = 0;
  private active = false;
  private unsubscribe?: () => void;

  constructor(
    private sessions: Pick<SessionStore, 'snapshot' | 'subscribe'>,
    private readToday: (session: Session) => Promise<TodayResult>,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: TodayState) { this.state = state; this.listeners.forEach(listener => listener()); }
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

  // Focus, foreground and token refreshes supersede reads started in an older context.
  reload = async () => {
    const session = this.currentSession();
    if (!session) return;
    const revision = ++this.revision;
    this.publish({ ...this.state, loading: !this.state.today, refreshing: !!this.state.today, error: null });
    const isCurrent = () => this.active && revision === this.revision && this.currentSession() === session;
    try {
      const today = await this.readToday(session);
      if (!isCurrent()) return;
      if (today.occurrences.some(occurrence => occurrence.owner_id !== session.user.id)) throw new Error('Occurrence owner mismatch');
      this.publish({ today, loading: false, refreshing: false, error: null });
    } catch (error) {
      if (!isCurrent()) return;
      this.publish({ ...this.state, loading: false, refreshing: false, error: errorMessage(error) });
    }
  };

  // Repeated pull-to-refresh/retry gestures do not start duplicate reads.
  refresh = async () => {
    if (this.state.loading || this.state.refreshing) return;
    await this.reload();
  };
}
