import type { Session } from '@supabase/supabase-js';
import { ApiError, type HistoryOccurrence, type HistoryResult, type StreakResult } from './api';
import type { SessionStore } from './session-store';

type SessionSource = Pick<SessionStore, 'snapshot' | 'subscribe'>;
type API = {
  readHabitHistory(session: Session, id: string, cursor?: string | null): Promise<HistoryResult>;
  readHabitStreak(session: Session, id: string): Promise<StreakResult>;
};
export type HistoryState = {
  occurrences: HistoryOccurrence[];
  nextCursor: string | null;
  hasLoaded: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  loadingMore: boolean;
  pageError: string | null;
  streak: StreakResult | null;
  streakLoading: boolean;
  streakError: string | null;
};
const emptyState = (): HistoryState => ({
  occurrences: [], nextCursor: null, hasLoaded: false, loading: false, refreshing: false,
  error: null, loadingMore: false, pageError: null, streak: null, streakLoading: false, streakError: null,
});

function errorMessage(error: unknown, subject: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Unable to verify your session. Retry, or open Settings to sign out and sign in again.';
    if (error.code === 'habit_not_found') return 'This habit was not found or is no longer available to your account.';
    if (error.code === 'request_timeout') return `Loading ${subject} timed out. Please retry.`;
    if (error.code === 'network_error') return `Unable to load ${subject}. Check your connection and retry.`;
  }
  return `Unable to load ${subject}. Please retry.`;
}

// Compare stored dates directly; device timezone changes must never move a historical date.
function newestFirst(rows: HistoryOccurrence[]): HistoryOccurrence[] {
  const unique = new Map<string, HistoryOccurrence>();
  for (const row of rows) if (!unique.has(row.id)) unique.set(row.id, row);
  return [...unique.values()].sort((a, b) => a.local_date === b.local_date
    ? (a.id === b.id ? 0 : a.id > b.id ? -1 : 1)
    : a.local_date > b.local_date ? -1 : 1);
}

/** Owner reads are scoped to this screen, habit, account, and pagination generation. */
export class HistoryStore {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  private active = false;
  private unsubscribe?: () => void;
  private revision = 0;
  private historyRevision = 0;
  private streakRevision = 0;
  private refreshPending: object | null = null;

  constructor(private sessions: SessionSource, private api: API, private habitId: string) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: HistoryState) { this.state = state; this.listeners.forEach(listener => listener()); }
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
    this.refreshPending = null;
    this.publish(emptyState());
  }
  private acceptSession = () => {
    const current = this.sessions.snapshot();
    const session = current.status === 'ready' ? current.session : null;
    if (session === this.session) return;
    const sameUser = !!session && session.user.id === this.session?.user.id;
    this.session = session;
    this.revision++;
    this.refreshPending = null;
    if (!sameUser) this.publish(emptyState());
    if (session) void this.reload();
  };

  private validatePage(page: HistoryResult, session: Session) {
    if (page.habit_id !== this.habitId || page.occurrences.some(row => row.habit_id !== this.habitId || row.owner_id !== session.user.id)) {
      throw new Error('History identity mismatch');
    }
  }

  private reload = async () => {
    await Promise.all([this.loadFirstPage(), this.loadStreak()]);
  };

  private loadFirstPage = async () => {
    const session = this.currentSession();
    if (!session) return;
    const operation = {};
    this.refreshPending = operation;
    const revision = this.revision;
    const historyRevision = ++this.historyRevision;
    const isCurrent = () => revision === this.revision && historyRevision === this.historyRevision && this.currentSession() === session;
    // Invalidate the old cursor immediately, even if refreshing the first page fails.
    this.publish({ ...this.state, nextCursor: null, loading: !this.state.hasLoaded, refreshing: this.state.hasLoaded,
      loadingMore: false, error: null, pageError: null });
    try {
      const page = await this.api.readHabitHistory(session, this.habitId);
      if (!isCurrent()) return;
      this.validatePage(page, session);
      this.publish({ ...this.state, occurrences: newestFirst(page.occurrences), nextCursor: page.next_cursor,
        hasLoaded: true, loading: false, refreshing: false, error: null });
    } catch (error) {
      if (isCurrent()) this.publish({ ...this.state, loading: false, refreshing: false, error: errorMessage(error, 'habit history') });
    } finally {
      if (this.refreshPending === operation) this.refreshPending = null;
    }
  };

  refreshServerState = async () => {
    if (this.refreshPending) return;
    await this.reload();
  };

  retryHistory = async () => {
    if (this.refreshPending) return;
    await this.loadFirstPage();
  };

  loadMore = async () => {
    const session = this.currentSession();
    const cursor = this.state.nextCursor;
    if (!session || !cursor || !this.state.hasLoaded || this.refreshPending || this.state.loadingMore || this.state.error) return;
    const revision = this.revision;
    const historyRevision = this.historyRevision;
    const isCurrent = () => revision === this.revision && historyRevision === this.historyRevision && this.currentSession() === session;
    this.publish({ ...this.state, loadingMore: true, pageError: null });
    try {
      const page = await this.api.readHabitHistory(session, this.habitId, cursor);
      if (!isCurrent()) return;
      this.validatePage(page, session);
      if (page.next_cursor === cursor) throw new Error('History cursor did not advance');
      this.publish({ ...this.state, occurrences: newestFirst([...this.state.occurrences, ...page.occurrences]),
        nextCursor: page.next_cursor, loadingMore: false, pageError: null });
    } catch (error) {
      if (isCurrent()) this.publish({ ...this.state, loadingMore: false, pageError: errorMessage(error, 'older history') });
    }
  };

  private loadStreak = async () => {
    const session = this.currentSession();
    if (!session) return;
    const revision = this.revision;
    const streakRevision = ++this.streakRevision;
    const isCurrent = () => revision === this.revision && streakRevision === this.streakRevision && this.currentSession() === session;
    this.publish({ ...this.state, streakLoading: true, streakError: null });
    try {
      const streak = await this.api.readHabitStreak(session, this.habitId);
      if (!isCurrent()) return;
      if (streak.habit_id !== this.habitId || !Number.isSafeInteger(streak.current_streak) || streak.current_streak < 0
        || typeof streak.provisional !== 'boolean') {
        throw new Error('Invalid streak response');
      }
      this.publish({ ...this.state, streak, streakLoading: false, streakError: null });
    } catch (error) {
      if (isCurrent()) this.publish({ ...this.state, streakLoading: false, streakError: errorMessage(error, 'the current streak') });
    }
  };

  retryStreak = async () => {
    if (this.state.streakLoading) return;
    await this.loadStreak();
  };
}
