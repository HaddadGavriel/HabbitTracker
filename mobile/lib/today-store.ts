import type { Session } from '@supabase/supabase-js';
import { ApiError, type ExcuseResult, type OccurrenceResult, type TodayResult } from './api';
import { explanationInput } from './excuse-input';
import type { SessionStore } from './session-store';
import { reconcileReminders, type ReminderMutations } from './reminder-mutations';

type CompletionState = { pending: boolean; error: string | null; refreshRequired: boolean };
type Operation = CompletionState & { context: symbol; clearErrorOnRefresh?: boolean };
type Change = { kind: 'completion'; value: boolean } | { kind: 'progress'; value: number };
type ExcuseAPI = {
  readExcuse(session: Session, id: string): Promise<ExcuseResult>;
  submitExcuse(session: Session, id: string, explanation: string): Promise<ExcuseResult>;
};
type ExcuseLock = { pending: boolean; needsRead: boolean; exists: boolean };
type WriteGuards = { operations: Map<string, Operation>; locks: Map<string, ExcuseLock>; activeStores: Set<TodayStore> };
type OwnerExcuse = { draft: string; open: boolean; details: boolean; result: ExcuseResult | null; error: string | null; message: string | null };
const emptyExcuse = (): OwnerExcuse => ({ draft: '', open: false, details: false, result: null, error: null, message: null });
type TodayState = {
  // Keep the server's date/timezone and occurrences together, including on failure.
  today: TodayResult | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  completions: Record<string, CompletionState>;
  progressDrafts: Record<string, string>;
  excuses: Record<string, OwnerExcuse>;
};
const emptyState = (): TodayState => ({ today: null, loading: false, refreshing: false, error: null, completions: {}, progressDrafts: {}, excuses: {} });

/** JSON numbers must remain exact; never round a user's absolute assignment. */
export function parseProgress(value: string): number {
  const text = value.trim();
  if (!/^[0-9]+$/.test(text)) throw new Error('Progress must be a nonnegative whole number.');
  const progress = Number(text);
  if (!Number.isSafeInteger(progress)) {
    throw new Error('Progress must be 9,007,199,254,740,991 or less so the app can save it exactly.');
  }
  return progress;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Unable to verify your session. Retry, or open Settings to sign out and sign in again.';
    if (error.code === 'request_timeout') return 'Loading Today timed out. Please retry.';
    if (error.code === 'network_error') return 'Unable to load Today. Check your connection and retry.';
  }
  return 'Unable to load Today. Please retry.';
}

function atLeastAsRecent(timestamp: string, previous: string): boolean {
  const time = Date.parse(timestamp), priorTime = Date.parse(previous);
  if (time !== priorTime) return time > priorTime;
  // PostgreSQL timestamps have microseconds; Date.parse keeps only milliseconds.
  const remainder = (value: string) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? '')
    .padEnd(6, '0').slice(3, 6);
  return remainder(timestamp) >= remainder(previous);
}

/** Screen-scoped server snapshots. The server owns states and all write eligibility. */
export class TodayStore {
  // Keep only write guards across screen remounts; never retain explanations or credentials.
  private static writeGuards = new WeakMap<object, WriteGuards>();
  private guardGroup: WriteGuards;
  private excuseLocks: Map<string, ExcuseLock>;
  private state = emptyState();
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  // Contexts must also differ across store instances sharing the write guards.
  private context = Symbol();
  private readRevision = 0;
  private active = false;
  private unsubscribe?: () => void;
  // Read refreshes must not release a write guard. Retain guards across navigation
  // and account changes until the request settles and a fresh read reconciles it.
  private operations: Map<string, Operation>;
  private clock: { server: number; started: number } | null = null;
  private deadlineTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private sessions: Pick<SessionStore, 'snapshot' | 'subscribe'>,
    private readToday: (session: Session) => Promise<TodayResult>,
    private writeCompletion: (session: Session, id: string, completed: boolean) => Promise<OccurrenceResult>,
    private writeProgress: (session: Session, id: string, progress: number) => Promise<OccurrenceResult>,
    private now: () => number = () => performance.now(),
    private excuseAPI?: ExcuseAPI,
    private reminders?: ReminderMutations,
  ) {
    this.guardGroup = TodayStore.writeGuards.get(sessions) ?? { operations: new Map(), locks: new Map(), activeStores: new Set() };
    this.operations = this.guardGroup.operations;
    this.excuseLocks = this.guardGroup.locks;
    TodayStore.writeGuards.set(sessions, this.guardGroup);
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: TodayState) {
    this.state = state;
    this.scheduleDeadline();
    this.listeners.forEach(listener => listener());
  }
  private currentSession() {
    const current = this.sessions.snapshot();
    return this.active && current.status === 'ready' && current.session?.user.id === this.session?.user.id ? current.session : null;
  }
  private key(owner: string, id: string) { return `${owner}:${id}`; }
  private completionStates(today = this.state.today): Record<string, CompletionState> {
    const states: Record<string, CompletionState> = {};
    for (const item of today?.occurrences ?? []) {
      const operation = this.operations.get(this.key(item.owner_id, item.id));
      if (operation && (operation.context === this.context || operation.pending || operation.refreshRequired)) {
        states[item.id] = { pending: operation.pending, error: operation.error, refreshRequired: operation.refreshRequired };
      }
    }
    return states;
  }
  private publishCompletionStates(owner: string, id: string) {
    for (const store of this.guardGroup.activeStores) {
      if (store.currentSession()?.user.id === owner && store.state.today?.occurrences.some(item => item.id === id)) {
        store.publish({ ...store.state, completions: store.completionStates() });
      }
    }
  }
  private serverNow() {
    // Monotonic elapsed time avoids the device's wall clock/timezone. Measuring
    // from read dispatch is conservative about time spent in transit.
    return this.clock ? this.clock.server + Math.max(0, this.now() - this.clock.started) : NaN;
  }
  private editable(item: OccurrenceResult): boolean {
    const today = this.state.today;
    return !this.excuseLocks.has(this.key(item.owner_id, item.id)) && !!this.currentSession() && !!today?.occurrences.includes(item) && item.local_date === today.local_date
      && item.owner_id === this.session?.user.id && this.serverNow() < Date.parse(item.closes_at)
      && ((item.state === 'in_progress' && !item.completed) || (item.state === 'completed' && item.completed));
  }
  completionAction = (item: OccurrenceResult): boolean | null => {
    if (!this.editable(item) || item.snapshot.type !== 'binary') return null;
    if (item.state === 'in_progress' && !item.completed) return true;
    if (item.state === 'completed' && item.completed) return false;
    return null;
  };
  canSubmitExcuse = (item: OccurrenceResult): boolean => !!this.excuseAPI && this.editable(item)
    && item.state === 'in_progress' && !item.completed && !this.state.loading && !this.state.refreshing && !this.state.error
    && !this.operations.get(this.key(item.owner_id, item.id))?.pending
    && !this.operations.get(this.key(item.owner_id, item.id))?.refreshRequired;
  excuseBusy = (item: OccurrenceResult) => !!this.excuseLocks.get(this.key(item.owner_id, item.id))?.pending;
  excuseNeedsRead = (item: OccurrenceResult) => !!this.excuseLocks.get(this.key(item.owner_id, item.id))?.needsRead;
  private setExcuse(id: string, changes: Partial<OwnerExcuse>) {
    this.publish({ ...this.state, excuses: { ...this.state.excuses, [id]: { ...(this.state.excuses[id] ?? emptyExcuse()), ...changes } } });
  }
  openExcuse = (item: OccurrenceResult) => {
    if (this.canSubmitExcuse(item)) this.setExcuse(item.id, { open: true, error: null });
  };
  setExplanation = (item: OccurrenceResult, draft: string) => {
    if (this.canSubmitExcuse(item)) this.setExcuse(item.id, { draft, error: null });
  };
  showExcuse = async (item: OccurrenceResult) => {
    if (!this.excuseAPI || !this.currentSession() || !this.state.today?.occurrences.includes(item)) return;
    this.setExcuse(item.id, { details: true });
    await this.reload();
  };

  private validateExcuse(result: ExcuseResult, item: OccurrenceResult) {
    const occurrence = result?.occurrence;
    const finalState = result?.status === 'approved' ? 'excused' : result?.status === 'rejected' ? 'missed' : 'justification_pending';
    if (!result || !result.id || result.occurrence_id !== item.id || result.habit_id !== item.habit_id || result.owner_id !== item.owner_id
      || !occurrence || occurrence.id !== item.id || occurrence.owner_id !== item.owner_id || occurrence.habit_id !== item.habit_id
      || occurrence.closes_at !== item.closes_at || occurrence.local_date !== item.local_date || occurrence.timezone !== item.timezone
      || occurrence.state !== finalState || occurrence.completed || typeof result.explanation !== 'string'
      || !['pending', 'approved', 'rejected'].includes(result.status) || !Number.isFinite(Date.parse(result.created_at))
      || !Number.isFinite(Date.parse(occurrence.updated_at))
      || (result.status === 'pending' ? result.decision_source !== null || result.decided_at !== null || result.decided_by !== null
        : !Number.isFinite(Date.parse(result.decided_at ?? '')) || !['automatic', 'friend', 'deleted_friend'].includes(result.decision_source ?? '')
          || (result.decision_source === 'automatic' ? result.status !== 'approved' || result.decided_by !== null : result.decision_source === 'deleted_friend' ? result.decided_by !== null : !result.decided_by))) {
      throw new ApiError('Unexpected excuse response', 200, 'invalid_response');
    }
  }

  submitExplanation = async (item: OccurrenceResult) => {
    const session = this.currentSession();
    if (!session || !this.excuseAPI || !this.canSubmitExcuse(item) || !this.state.excuses[item.id]?.open) return;
    let explanation: string;
    try { explanation = explanationInput(this.state.excuses[item.id].draft); }
    catch (error) { this.setExcuse(item.id, { error: error instanceof Error ? error.message : 'Invalid explanation.' }); return; }
    const key = this.key(session.user.id, item.id), context = this.context;
    const lock: ExcuseLock = { pending: true, needsRead: false, exists: false };
    this.excuseLocks.set(key, lock);
    this.setExcuse(item.id, { error: null, message: null });
    const isCurrent = () => context === this.context && this.currentSession()?.user.id === session.user.id
      && this.state.today?.occurrences.some(row => row.id === item.id);
    try {
      const result = await this.excuseAPI.submitExcuse(session, item.id, explanation);
      this.validateExcuse(result, item);
      reconcileReminders(this.reminders, session, { habitId: item.habit_id, localDate: item.local_date });
      this.excuseLocks.set(key, { pending: false, needsRead: true, exists: true });
      if (!isCurrent()) return;
      this.readRevision++;
      const today = this.state.today!;
      this.publish({ ...this.state, today: { ...today, occurrences: today.occurrences.map(row => row.id === item.id ? result.occurrence : row) } });
      this.setExcuse(item.id, { open: false, details: true, result, draft: '', message: result.status === 'pending'
        ? 'Excuse submitted. Awaiting an authorized friend’s decision.'
        : result.decision_source === 'automatic' ? 'Excuse automatically approved by the server.' : 'Excuse submitted. The server has recorded a final friend decision.' });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      const recoverable = error instanceof ApiError && (code === 'configuration_error' || code === 'invalid_excuse_explanation'
        || (error.status !== null && [401, 422, 429].includes(error.status) && !['request_timeout', 'network_error'].includes(code)));
      if (recoverable) this.excuseLocks.delete(key);
      else this.excuseLocks.set(key, { pending: false, needsRead: true, exists: code === 'excuse_exists' });
      if (!isCurrent()) return;
      this.setExcuse(item.id, { error: recoverable
        ? 'Unable to submit. Your explanation is saved here; check your connection, session, or explanation and retry.'
        : 'Submission was not confirmed. Checking the existing excuse and current occurrence before another submission.' });
      if (recoverable) return;
    } finally {
      // A screen may have blurred and returned while the request was in flight.
      // Wake its current controls without publishing the previous context's result.
      if (!isCurrent() && this.currentSession()?.user.id === session.user.id) {
        this.publish({ ...this.state });
        void this.reload();
      }
      for (const store of this.guardGroup.activeStores) {
        if (store !== this && store.currentSession()?.user.id === session.user.id) {
          store.publish({ ...store.state });
          void store.reload();
        }
      }
    }
    if (isCurrent()) await this.reload();
  };
  canSetProgress = (item: OccurrenceResult): boolean => this.editable(item) && item.snapshot.type === 'target';
  progressValue = (item: OccurrenceResult): string => this.state.progressDrafts[item.id]
    ?? (Number.isSafeInteger(item.progress) ? String(item.progress) : '');
  setProgressDraft = (item: OccurrenceResult, value: string) => {
    if (!this.canSetProgress(item)) return;
    const key = this.key(item.owner_id, item.id);
    const operation = this.operations.get(key);
    if (operation?.pending || operation?.refreshRequired) return;
    this.operations.delete(key);
    this.publish({ ...this.state, progressDrafts: { ...this.state.progressDrafts, [item.id]: value },
      completions: this.completionStates() });
  };
  private scheduleDeadline() {
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    const deadlines = (this.state.today?.occurrences ?? [])
      .filter(item => this.editable(item)).map(item => Date.parse(item.closes_at));
    if (!deadlines.length) return;
    const delay = Math.min(2_147_483_647, Math.max(1, Math.min(...deadlines) - this.serverNow()));
    // Only hide expired actions; never infer occurrence states locally.
    this.deadlineTimer = setTimeout(() => this.publish({ ...this.state }), delay);
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.guardGroup.activeStores.add(this);
    this.unsubscribe = this.sessions.subscribe(this.acceptSession);
    this.acceptSession();
  }
  stop() {
    this.active = false;
    this.guardGroup.activeStores.delete(this);
    this.context = Symbol();
    this.readRevision++;
    this.unsubscribe?.();
    this.session = null;
    this.clock = null;
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
      this.context = Symbol();
      this.clock = null;
      this.publish(emptyState());
    }
    if (session) void this.reload();
  };

  // Focus, foreground and token refreshes supersede reads started in an older context.
  reload = async () => {
    const session = this.currentSession();
    if (!session) return;
    const revision = ++this.readRevision;
    const started = this.now();
    const operationsAtStart = new Map(this.operations);
    const excuseLocksAtStart = new Map(this.excuseLocks);
    const excuseIds = new Set(Object.entries(this.state.excuses).filter(([, value]) => value.details).map(([id]) => id));
    for (const [key, lock] of excuseLocksAtStart) {
      if (key.startsWith(`${session.user.id}:`) && !lock.pending && lock.needsRead) excuseIds.add(key.slice(session.user.id.length + 1));
    }
    this.publish({ ...this.state, loading: !this.state.today, refreshing: !!this.state.today, error: null });
    const isCurrent = () => this.active && revision === this.readRevision && this.currentSession() === session;
    try {
      const [today, excuseReads] = await Promise.all([this.readToday(session), Promise.all([...excuseIds].map(async (id): Promise<{ id: string; result: ExcuseResult | null; error: unknown }> => {
        try { return { id, result: await this.excuseAPI!.readExcuse(session, id), error: null }; }
        catch (error) { return { id, result: null, error }; }
      }))]);
      if (!isCurrent()) return;
      if (today.occurrences.some(occurrence => occurrence.owner_id !== session.user.id)) throw new Error('Occurrence owner mismatch');
      const changedDate = this.state.today && (today.local_date !== this.state.today.local_date || today.timezone !== this.state.today.timezone);
      if (changedDate) this.context = Symbol();
      this.clock = { server: Date.parse(today.server_time), started };
      const excuses = changedDate ? {} : { ...this.state.excuses };
      for (const read of excuseReads) {
        const item = today.occurrences.find(row => row.id === read.id);
        if (!item) continue;
        const key = this.key(session.user.id, item.id), lock = this.excuseLocks.get(key);
        if (lock !== excuseLocksAtStart.get(key) || lock?.pending) continue;
        const previous = excuses[item.id] ?? emptyExcuse();
        if (read.result) {
          this.validateExcuse(read.result, item);
          if (!atLeastAsRecent(read.result.occurrence.updated_at, item.updated_at)) {
            // A friend may decide between the two reads. Re-read once instead
            // of pairing a final Today state with outdated pending details.
            try { read.result = await this.excuseAPI!.readExcuse(session, item.id); }
            catch (error) { read.result = null; read.error = error; }
            if (!isCurrent()) return;
          }
        }
        if (read.result) {
          this.validateExcuse(read.result, item);
          if (!atLeastAsRecent(read.result.occurrence.updated_at, item.updated_at)
            || (read.result.occurrence.updated_at === item.updated_at && read.result.occurrence.state !== item.state)) {
            this.excuseLocks.set(key, { pending: false, needsRead: true, exists: true });
            excuses[item.id] = { ...previous, result: null, error: 'The occurrence changed while loading its excuse. Refresh Today to read the current decision.' };
            continue;
          }
          this.excuseLocks.set(key, { pending: false, needsRead: false, exists: true });
          excuses[item.id] = { ...previous, open: false, details: true, result: read.result, error: null };
          if (atLeastAsRecent(read.result.occurrence.updated_at, item.updated_at)) Object.assign(item, read.result.occurrence);
        } else if (read.error instanceof ApiError && read.error.code === 'excuse_not_found' && !lock?.exists) {
          this.excuseLocks.delete(key);
          excuses[item.id] = { ...previous, result: null, details: false,
            error: lock ? 'No excuse was found. Current occurrence checked; you may submit if it is still eligible.' : 'No excuse is available for this occurrence.' };
        } else {
          excuses[item.id] = { ...previous, result: null, error: 'Unable to verify the excuse. Refresh Today to check again. Your draft is preserved.' };
        }
      }
      for (const item of today.occurrences) {
        const key = this.key(session.user.id, item.id);
        const operation = this.operations.get(key);
        // A read dispatched before a write settled cannot resolve its uncertain outcome.
        if (operation && !operation.pending && operationsAtStart.get(key) === operation) {
          if (operation.clearErrorOnRefresh || operation.context !== this.context) this.operations.delete(key);
          else this.operations.set(key, { ...operation, refreshRequired: false });
        }
      }
      const progressDrafts = changedDate ? {} : Object.fromEntries(today.occurrences
        .filter(item => this.state.progressDrafts[item.id] !== undefined)
        .map(item => [item.id, this.state.progressDrafts[item.id]]));
      this.publish({ today, loading: false, refreshing: false, error: null, completions: this.completionStates(today), progressDrafts, excuses });
      reconcileReminders(this.reminders, session);
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

  setCompletion = (item: OccurrenceResult, completed: boolean) => this.change(item, { kind: 'completion', value: completed });

  setProgress = async (item: OccurrenceResult) => {
    if (!this.canSetProgress(item)) return;
    const key = this.key(item.owner_id, item.id);
    const previous = this.operations.get(key);
    if (previous?.pending || previous?.refreshRequired) return;
    let progress: number;
    try {
      progress = parseProgress(this.progressValue(item));
    } catch (error) {
      this.operations.set(key, { context: this.context, pending: false, refreshRequired: false,
        error: error instanceof Error ? error.message : 'Enter a nonnegative whole number.' });
      this.publish({ ...this.state, completions: this.completionStates() });
      return;
    }
    await this.change(item, { kind: 'progress', value: progress });
  };

  private change = async (item: OccurrenceResult, change: Change) => {
    const session = this.currentSession();
    if (!session || (change.kind === 'completion' ? this.completionAction(item) !== change.value : !this.canSetProgress(item))) return;
    const key = this.key(session.user.id, item.id);
    const previous = this.operations.get(key);
    if (previous?.pending || previous?.refreshRequired) return;
    const operation: Operation = { context: this.context, pending: true, error: null, refreshRequired: false };
    this.operations.set(key, operation);
    this.publishCompletionStates(session.user.id, item.id);
    const isCurrent = () => this.context === operation.context && this.currentSession()?.user.id === session.user.id
      && this.state.today?.occurrences.some(row => row.id === item.id && row.local_date === item.local_date);
    const ignoreStale = () => {
      // Ignore old results. If the same row is visible again, release its spinner
      // but require a read before another write; never apply the old occurrence.
      this.operations.set(key, { ...operation, pending: false, refreshRequired: true, clearErrorOnRefresh: true,
        error: 'A previous update finished. Refresh Today before another change.' });
      this.publishCompletionStates(session.user.id, item.id);
    };
    let refresh = false;
    try {
      const result = await (change.kind === 'completion' ? this.writeCompletion(session, item.id, change.value)
        : this.writeProgress(session, item.id, change.value));
      const completed = change.kind === 'completion' ? change.value : item.snapshot.type === 'target' && change.value >= item.snapshot.target;
      if (result?.id !== item.id || result.owner_id !== session.user.id || result.habit_id !== item.habit_id
        || result.local_date !== item.local_date || result.timezone !== item.timezone || result.closes_at !== item.closes_at
        || result.snapshot?.type !== item.snapshot.type || result.snapshot.target !== item.snapshot.target || result.snapshot.unit !== item.snapshot.unit
        || (change.kind === 'progress' && result.progress !== change.value) || result.completed !== completed
        || result.state !== (completed ? 'completed' : 'in_progress') || !Number.isFinite(Date.parse(result.updated_at))) {
        throw new ApiError('Unexpected occurrence response', 200, 'invalid_response');
      }
      reconcileReminders(this.reminders, session, result.completed ? { habitId: item.habit_id, localDate: item.local_date } : undefined);
      if (!isCurrent()) { ignoreStale(); return; }
      // Invalidate reads dispatched before acknowledgement, including reads started
      // during the write. The following refresh gets a new revision.
      this.readRevision++;
      this.operations.delete(key);
      const today = this.state.today!;
      const progressDrafts = { ...this.state.progressDrafts };
      if (change.kind === 'progress') delete progressDrafts[item.id];
      this.publish({ ...this.state, today: { ...today, occurrences: today.occurrences.map(row =>
        row.id === item.id && atLeastAsRecent(result.updated_at, row.updated_at) ? result : row) },
        loading: false, refreshing: false, completions: this.completionStates(), progressDrafts });
      this.publishCompletionStates(session.user.id, item.id);
      refresh = true;
    } catch (error) {
      if (!isCurrent()) { ignoreStale(); return; }
      const definite = error instanceof ApiError && (error.code === 'configuration_error'
        || (error.status !== null && error.status >= 400 && error.status < 500
          && error.status !== 408 && error.code !== 'request_timeout' && error.code !== 'network_error'));
      const code = error instanceof ApiError ? error.code : null;
      refresh = definite && ['occurrence_closed', 'occurrence_locked', 'occurrence_not_found', 'wrong_occurrence_type'].includes(code ?? '');
      const message = !definite
        ? 'We could not confirm this change. It may have succeeded. Refresh Today before another action.'
        : code === 'occurrence_closed' ? 'This occurrence is closed. Its deadline has passed. Refresh Today to see its current state.'
        : code === 'occurrence_locked' ? 'This occurrence is locked by an excuse and cannot be changed. Refresh Today to see its current state.'
        : code === 'occurrence_not_found' ? 'This occurrence is no longer available. Refresh Today to check its current state.'
        : code === 'wrong_occurrence_type' ? 'This occurrence does not support this change. Refresh Today to check its current state.'
        : error instanceof ApiError && error.status === 401
          ? 'Unable to verify your session. Retry, or open Settings to sign out and sign in again.'
        : 'Unable to change this occurrence. Please try again.';
      this.operations.set(key, { ...operation, pending: false, error: message, refreshRequired: !definite || refresh, clearErrorOnRefresh: !definite });
      this.publishCompletionStates(session.user.id, item.id);
    }
    if (refresh && isCurrent()) await this.reload();
  };
}
