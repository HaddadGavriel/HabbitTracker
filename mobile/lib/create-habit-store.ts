import type { Session } from '@supabase/supabase-js';
import { ApiError, type HabitCreate, type HabitResult } from './api';
import { emptyHabitDraft, habitInput, type HabitDraft } from './habit-input';
import type { SessionStore } from './session-store';

type CreationState = { draft: HabitDraft; busy: boolean; created: boolean; error: string | null; ambiguous: boolean };
const initialState = (): CreationState => ({ draft: emptyHabitDraft(), busy: false, created: false, error: null, ambiguous: false });

function creationError(error: unknown): Pick<CreationState, 'error' | 'ambiguous'> {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return { ambiguous: false, error: 'Your session could not be verified. Return Home to sign out and sign in again.' };
    if (error.code === 'configuration_error') return { ambiguous: false, error: 'The app API address is missing. Check the app configuration.' };
    if (error.status !== null && error.status >= 400 && error.status < 500 && error.code !== 'request_timeout') {
      return { ambiguous: false, error: error.message };
    }
  }
  return { ambiguous: true, error: 'We could not confirm whether your habit was saved. It may have succeeded. Check My habits before submitting again to avoid a duplicate.' };
}

/** Keeps the draft local to this screen and account; never retries a mutation. */
export class CreateHabitStore {
  private state = initialState();
  private listeners = new Set<() => void>();
  private active = false;
  private userId: string | null = null;
  private revision = 0;
  private unsubscribe?: () => void;
  constructor(
    private sessions: Pick<SessionStore, 'snapshot' | 'subscribe'>,
    private createHabit: (session: Session, input: HabitCreate) => Promise<HabitResult>,
    private onCreated: () => void,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: CreationState) { this.state = state; this.listeners.forEach(listener => listener()); }
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
    this.userId = null;
    this.publish(initialState());
  }
  private acceptSession = () => {
    const current = this.sessions.snapshot();
    const userId = current.status === 'ready' ? current.session?.user.id ?? null : null;
    if (userId === this.userId) return;
    this.userId = userId;
    this.revision++;
    this.publish(initialState());
  };
  update = (patch: Partial<HabitDraft>) => {
    if (!this.active || !this.userId || this.state.busy || this.state.created) return;
    this.publish({ ...this.state, draft: { ...this.state.draft, ...patch }, error: this.state.ambiguous ? this.state.error : null });
  };
  submit = async () => {
    if (!this.active || this.state.busy || this.state.created) return;
    const current = this.sessions.snapshot();
    const session = current.session;
    if (current.status !== 'ready' || !session || session.user.id !== this.userId) return;
    let input: HabitCreate;
    try { input = habitInput(this.state.draft); }
    catch (error) {
      this.publish({ ...this.state, error: error instanceof Error ? error.message : 'Check the habit fields.' });
      return;
    }
    const revision = this.revision;
    const isCurrent = () => this.active && revision === this.revision
      && this.sessions.snapshot().status === 'ready' && this.sessions.snapshot().session?.user.id === session.user.id;
    // Set the guard synchronously, before calling the API or yielding to React.
    this.publish({ ...this.state, busy: true, error: null, ambiguous: false });
    try {
      const result = await this.createHabit(session, input);
      if (!isCurrent()) return;
      if (result.owner_id !== session.user.id) throw new ApiError('Habit owner mismatch', 201, 'invalid_response');
    } catch (error) {
      if (isCurrent()) this.publish({ ...this.state, busy: false, ...creationError(error) });
      return;
    }
    this.publish({ ...this.state, busy: false, created: true, error: null, ambiguous: false });
    if (isCurrent()) this.onCreated();
  };
}
