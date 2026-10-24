import type { Session } from '@supabase/supabase-js';
import { ApiError, type ExcuseResult } from './api';
import type { SessionStore } from './session-store';

type SessionSource = Pick<SessionStore, 'snapshot' | 'subscribe'>;
type API = { readExcuse(session: Session, occurrenceId: string): Promise<ExcuseResult> };
type State = { excuse: ExcuseResult | null; loading: boolean; error: string | null };
const emptyState = (): State => ({ excuse: null, loading: false, error: null });

export function validateExcuse(excuse: ExcuseResult, occurrenceId?: string) {
  if (!excuse || typeof excuse.id !== 'string' || typeof excuse.explanation !== 'string'
    || !excuse.occurrence || excuse.occurrence.id !== excuse.occurrence_id
    || excuse.occurrence.owner_id !== excuse.owner_id || excuse.occurrence.habit_id !== excuse.habit_id
    || (occurrenceId && excuse.occurrence_id !== occurrenceId)
    || excuse.occurrence.completed !== false
    || (excuse.status === 'pending'
      ? excuse.occurrence.state !== 'justification_pending' || excuse.decision_source !== null
        || excuse.decided_at !== null || excuse.decided_by !== null
      : !['approved', 'rejected'].includes(excuse.status)
        || excuse.occurrence.state !== (excuse.status === 'approved' ? 'excused' : 'missed')
        || !excuse.decided_at || (excuse.decision_source === 'automatic'
          ? excuse.status !== 'approved' || excuse.decided_by !== null
          : excuse.decision_source === 'deleted_friend' ? excuse.decided_by !== null : excuse.decision_source !== 'friend' || !excuse.decided_by))) {
    throw new ApiError('Unexpected excuse response', 200, 'invalid_response');
  }
}

export function excuseReadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Unable to verify your session. Retry, or open Settings to sign out and sign in again.';
    if (error.code === 'profile_not_found') return 'Your profile is no longer available. Return Home to check your account.';
    if (error.status === 403 || error.status === 404) return 'This excuse is unavailable. It may not exist, sharing or friendship may have ended, or the habit may be archived.';
    if (error.code === 'request_timeout') return 'Loading excuses timed out. Retry to check current access and decisions.';
    if (error.code === 'network_error') return 'Unable to load excuses. Check your connection and retry.';
  }
  return 'Unable to load excuses. Please retry to check current access and decisions.';
}

/** An explanation is private: each focused read independently verifies access. */
export class ExcuseDetailStore {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private active = false;
  private session: Session | null = null;
  private accessToken: string | null = null;
  private revision = 0;
  private unsubscribe?: () => void;
  constructor(private sessions: SessionSource, private api: API, private occurrenceId: string) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: State) { this.state = state; this.listeners.forEach(listener => listener()); }
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
    if (session) void this.refresh();
  };
  refresh = async () => {
    const session = this.currentSession();
    if (!session || this.state.loading) return;
    const revision = ++this.revision;
    this.publish({ ...emptyState(), loading: true });
    const current = () => revision === this.revision && this.currentSession() === session;
    try {
      const excuse = await this.api.readExcuse(session, this.occurrenceId);
      if (!current()) return;
      validateExcuse(excuse, this.occurrenceId);
      this.publish({ excuse, loading: false, error: null });
    } catch (error) {
      if (current()) this.publish({ ...emptyState(), error: excuseReadError(error) });
    }
  };
}
