import type { Session } from '@supabase/supabase-js';
import { ApiError, type HabitResult, type HabitUpdate } from './api';
import { habitChanges, habitDraft } from './habit-edit-input';
import type { HabitDraft } from './habit-input';
import type { SessionStore } from './session-store';
import { reconcileReminders, type ReminderMutations } from './reminder-mutations';

type Unavailable = 'missing' | 'archived' | null;
type ArchiveState = { phase: 'confirming' | 'pending' | 'failed'; ambiguous: boolean; error: string | null };
type EditState = {
  habit: HabitResult | null; draft: HabitDraft | null; loading: boolean; saving: boolean;
  saved: boolean; error: string | null; ambiguous: boolean; unavailable: Unavailable;
  archive: ArchiveState | null;
};
type API = {
  readHabit(session: Session, id: string): Promise<HabitResult>;
  updateHabit(session: Session, id: string, changes: HabitUpdate): Promise<HabitResult>;
  archiveHabit(session: Session, id: string): Promise<HabitResult>;
};
const initialState = (): EditState => ({ habit: null, draft: null, loading: false, saving: false, saved: false, error: null, ambiguous: false, unavailable: null, archive: null });
function unavailable(error: unknown): Unavailable {
  if (!(error instanceof ApiError)) return null;
  return error.code === 'habit_not_found' ? 'missing' : error.code === 'habit_archived' ? 'archived' : null;
}

/** One active editor; leaving the screen or account invalidates every pending operation. */
export class EditHabitStore {
  private state = initialState();
  private listeners = new Set<() => void>();
  private active = false;
  private userId: string | null = null;
  private revision = 0;
  private unsubscribe?: () => void;
  constructor(
    private sessions: Pick<SessionStore, 'snapshot' | 'subscribe'>,
    private api: API,
    private id: string,
    private onSaved: () => void,
    private reminders?: ReminderMutations,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: EditState) { this.state = state; this.listeners.forEach(listener => listener()); }
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
    if (userId) void this.reload();
  };
  private currentSession() {
    const current = this.sessions.snapshot();
    return this.active && current.status === 'ready' && current.session?.user.id === this.userId ? current.session : null;
  }
  private isCurrent(revision: number, session: Session) {
    return this.revision === revision && this.currentSession()?.user.id === session.user.id;
  }
  private checkIdentity(habit: HabitResult, session: Session) {
    if (habit.id !== this.id || habit.owner_id !== session.user.id) throw new ApiError('Unexpected habit response', 200, 'invalid_response');
  }
  private block(reason: Exclude<Unavailable, null>) {
    this.publish({ ...initialState(), unavailable: reason });
  }
  private archiveLocked() {
    return !!this.state.archive && (this.state.archive.phase !== 'failed' || this.state.archive.ambiguous);
  }
  hasUnsavedEdits = () => !!this.state.habit && !!this.state.draft
    && JSON.stringify(this.state.draft) !== JSON.stringify(habitDraft(this.state.habit));
  refreshServerState = async () => {
    if (this.state.loading) return;
    await this.reload();
  };
  reload = async () => {
    const session = this.currentSession();
    if (!session || this.state.saving || this.state.saved || (this.state.archive && this.state.archive.phase !== 'failed')) return;
    const revision = ++this.revision;
    // Replace unsaved edits only when the explicit reload succeeds.
    this.publish({ ...this.state, loading: true, error: null });
    try {
      const habit = await this.api.readHabit(session, this.id);
      if (!this.isCurrent(revision, session)) return;
      this.checkIdentity(habit, session);
      if (habit.archived_at !== null) { this.block('archived'); return; }
      this.publish({ ...initialState(), habit, draft: habitDraft(habit) });
    } catch (error) {
      if (!this.isCurrent(revision, session)) return;
      const reason = unavailable(error);
      if (reason) { this.block(reason); return; }
      this.publish({ ...this.state, loading: false, error: 'Unable to load this habit. Check your connection and retry.' });
    }
  };
  update = (patch: Partial<HabitDraft>) => {
    if (!this.currentSession() || !this.state.draft || this.state.loading || this.state.saving || this.state.saved || this.state.unavailable || this.archiveLocked()) return;
    this.publish({ ...this.state, draft: { ...this.state.draft, ...patch, type: this.state.draft.type }, error: this.state.ambiguous ? this.state.error : null });
  };
  save = async () => {
    const session = this.currentSession();
    const { habit, draft } = this.state;
    if (!session || !habit || !draft || this.state.loading || this.state.saving || this.state.saved || this.state.unavailable || this.archiveLocked()) return;
    let changes: HabitUpdate | null;
    try { changes = habitChanges(habit, draft); }
    catch (error) {
      this.publish({ ...this.state, error: error instanceof Error ? error.message : 'Check the habit fields.' });
      return;
    }
    if (!changes) { this.publish({ ...this.state, error: 'No changes to save.' }); return; }
    const revision = ++this.revision;
    this.publish({ ...this.state, saving: true, error: null, ambiguous: false, archive: null });
    try {
      const saved = await this.api.updateHabit(session, this.id, changes);
      this.checkIdentity(saved, session);
      if (saved.type !== habit.type) throw new ApiError('Unexpected habit type', 200, 'invalid_response');
      reconcileReminders(this.reminders, session, saved.archived_at !== null ? { habitId: this.id } : undefined);
      if (!this.isCurrent(revision, session)) return;
      if (saved.archived_at !== null) { this.block('archived'); return; }
    } catch (error) {
      if (!this.isCurrent(revision, session)) return;
      const reason = unavailable(error);
      if (reason) { this.block(reason); return; }
      const definite = error instanceof ApiError && (error.code === 'configuration_error'
        || (error.status !== null && error.status >= 400 && error.status < 500 && error.code !== 'request_timeout'));
      this.publish({ ...this.state, saving: false, ambiguous: !definite, error: definite ? error.message
        : 'We could not confirm whether your changes were saved. The save may have succeeded. Reload the saved configuration before deciding to save again.' });
      return;
    }
    this.publish({ ...this.state, saving: false, saved: true, error: null, ambiguous: false });
    if (this.isCurrent(revision, session)) this.onSaved();
  };
  requestArchive = () => {
    if (!this.currentSession() || !this.state.habit || !this.state.draft || this.state.loading
      || this.state.saving || this.state.saved || this.state.unavailable
      || (this.state.archive && this.state.archive.phase !== 'failed')) return;
    this.publish({ ...this.state, archive: { phase: 'confirming', ambiguous: this.state.archive?.ambiguous ?? false, error: null } });
  };
  cancelArchive = (confirmation = this.state.archive) => {
    if (this.state.archive !== confirmation || this.state.archive?.phase !== 'confirming') return;
    // Cancelling a retry must not erase an earlier uncertain outcome.
    this.publish({ ...this.state, archive: this.state.archive.ambiguous
      ? { phase: 'failed', ambiguous: true, error: 'The archive may have succeeded. Refresh the current server state before deciding to retry.' }
      : null });
  };
  confirmArchive = async (confirmation = this.state.archive) => {
    const session = this.currentSession();
    const { habit } = this.state;
    if (!session || !habit || this.state.archive !== confirmation || this.state.archive?.phase !== 'confirming'
      || this.state.loading || this.state.saving || this.state.saved || this.state.unavailable) return;
    const revision = ++this.revision;
    const uncertain = this.state.archive.ambiguous;
    this.publish({ ...this.state, archive: { phase: 'pending', ambiguous: uncertain, error: null }, error: this.state.ambiguous ? this.state.error : null });
    try {
      const archived = await this.api.archiveHabit(session, this.id);
      this.checkIdentity(archived, session);
      if (typeof archived.archived_at !== 'string' || !archived.archived_at || archived.type !== habit.type) {
        throw new ApiError('Unexpected archive response', 200, 'invalid_response');
      }
      reconcileReminders(this.reminders, session, { habitId: this.id });
      if (!this.isCurrent(revision, session)) return;
    } catch (error) {
      if (!this.isCurrent(revision, session)) return;
      const reason = unavailable(error);
      if (reason) { this.block(reason); return; }
      const definite = error instanceof ApiError && (error.code === 'configuration_error'
        || (error.status !== null && error.status >= 400 && error.status < 500 && error.code !== 'request_timeout'));
      const ambiguous = uncertain || !definite || (error instanceof ApiError && error.status === 408);
      this.publish({ ...this.state, archive: { phase: 'failed', ambiguous,
        error: !ambiguous ? `Unable to archive this habit. ${error.message}`
          : 'We could not confirm whether this habit was archived. It may have succeeded. Refresh the current server state before deciding to retry.' } });
      return;
    }
    this.publish({ ...initialState(), saved: true });
    if (this.isCurrent(revision, session)) this.onSaved();
  };
}
