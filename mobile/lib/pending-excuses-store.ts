import type { Session } from '@supabase/supabase-js';
import { ApiError, type ExcuseResult } from './api';
import { excuseReadError, validateExcuse } from './excuse-detail-store';
import type { SessionStore } from './session-store';

type SessionSource = Pick<SessionStore, 'snapshot' | 'subscribe'>;
type Decision = 'approve' | 'reject';
type API = {
  listPendingExcuses(session: Session): Promise<ExcuseResult[]>;
  readExcuse(session: Session, occurrenceId: string): Promise<ExcuseResult>;
  decideExcuse(session: Session, excuseId: string, decision: Decision): Promise<ExcuseResult>;
};
export type DecisionConfirmation = { excuse: ExcuseResult; decision: Decision };
type Operation = { occurrenceId: string; excuseId: string; pending: boolean; context: number; finalKnown: boolean };
type State = {
  excuses: ExcuseResult[]; resolved: ExcuseResult | null; hasLoaded: boolean; loading: boolean;
  error: string | null; notice: string | null; confirmation: DecisionConfirmation | null;
  deciding: boolean; refreshRequired: boolean;
};
const emptyState = (): State => ({ excuses: [], resolved: null, hasLoaded: false, loading: false,
  error: null, notice: null, confirmation: null, deciding: false, refreshRequired: false });

/** Keep only unsettled write guards across route remounts, never private rows. */
export class PendingExcusesStore {
  private static stores = new WeakMap<SessionSource, PendingExcusesStore>();
  static forSession(sessions: SessionSource, api: API) {
    let store = this.stores.get(sessions);
    if (!store) { store = new PendingExcusesStore(sessions, api); this.stores.set(sessions, store); }
    return store;
  }
  private state = emptyState();
  private listeners = new Set<() => void>();
  private active = false;
  private session: Session | null = null;
  private accessToken: string | null = null;
  private revision = 0;
  private context = 0;
  private unsubscribe?: () => void;
  private operations = new Map<string, Operation>();
  constructor(private sessions: SessionSource, private api: API) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: State) { this.state = state; this.listeners.forEach(listener => listener()); }
  private currentSession() {
    const current = this.sessions.snapshot();
    return this.active && current.status === 'ready' && current.session === this.session
      && current.session?.access_token === this.accessToken ? current.session : null;
  }
  private guards() {
    const id = this.currentSession()?.user.id;
    const operation = id ? this.operations.get(id) : undefined;
    return { deciding: !!operation?.pending, refreshRequired: !!operation && !operation.pending };
  }
  start() {
    if (this.active) return;
    this.active = true;
    this.unsubscribe = this.sessions.subscribe(this.acceptSession);
    this.acceptSession();
  }
  stop() {
    this.active = false;
    this.context++;
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
    this.context++;
    this.revision++;
    this.publish({ ...emptyState(), ...this.guards() });
    if (session) void this.refresh();
  };
  canDecide = () => !!this.currentSession() && this.state.hasLoaded && !this.state.loading
    && !this.state.error && !this.state.deciding && !this.state.refreshRequired;

  refresh = async () => {
    const session = this.currentSession();
    if (!session || this.state.loading) return;
    const operation = this.operations.get(session.user.id);
    // A read sent before a write settles cannot resolve an ambiguous outcome.
    if (operation?.pending) return;
    const revision = ++this.revision;
    const notice = this.state.notice;
    this.publish({ ...emptyState(), loading: true, notice, ...this.guards() });
    const current = () => revision === this.revision && this.currentSession() === session;
    try {
      let resolved: ExcuseResult | null = null;
      let inaccessible = false;
      let outcomeNotice = notice;
      if (operation) {
        try {
          const result = await this.api.readExcuse(session, operation.occurrenceId);
          if (!current()) return;
          validateExcuse(result, operation.occurrenceId);
          if (result.id !== operation.excuseId || result.owner_id === session.user.id) throw new Error('Invalid decision reconciliation');
          if (operation.finalKnown && result.status === 'pending') throw new Error('Stale decision reconciliation');
          if (result.status !== 'pending') {
            operation.finalKnown = true;
            resolved = result;
            // Describe the stored outcome without attributing a competing or
            // ambiguous decision to this request.
            outcomeNotice = `The current server decision is ${result.status}. It is final.`;
          } else outcomeNotice = 'The excuse is still pending. Review it before confirming a decision again.';
        } catch (error) {
          if (!current()) return;
          if (!(error instanceof ApiError) || ![403, 404].includes(error.status ?? 0)
            || error.code === 'profile_not_found') throw error;
          inaccessible = true;
          outcomeNotice = 'This excuse is no longer accessible. Sharing or friendship may have ended, or the habit may be archived.';
        }
      }
      const excuses = await this.api.listPendingExcuses(session);
      if (!current()) return;
      if (!Array.isArray(excuses)) throw new Error('Invalid pending list');
      excuses.forEach(excuse => {
        validateExcuse(excuse);
        if (excuse.owner_id === session.user.id || excuse.status !== 'pending') throw new Error('Invalid pending excuse');
      });
      if (new Set(excuses.map(excuse => excuse.id)).size !== excuses.length) throw new Error('Duplicate pending excuse');
      // Separate reads can observe a competing decision or permission change.
      // Never restore controls from a list contradicting the detail read.
      if (operation && (resolved || inaccessible) && excuses.some(excuse =>
        excuse.id === operation.excuseId || excuse.occurrence_id === operation.occurrenceId)) {
        throw new Error('Inconsistent pending decision list');
      }
      if (operation && this.operations.get(session.user.id) === operation) this.operations.delete(session.user.id);
      this.publish({ ...emptyState(), excuses, resolved, hasLoaded: true, notice: outcomeNotice, ...this.guards() });
    } catch (error) {
      if (current()) this.publish({ ...emptyState(), error: excuseReadError(error), notice, ...this.guards() });
    }
  };
  requestDecision = (excuse: ExcuseResult, decision: Decision) => {
    if (!this.canDecide() || !this.state.excuses.includes(excuse) || !['approve', 'reject'].includes(decision)) return;
    this.publish({ ...this.state, confirmation: { excuse, decision }, notice: null });
  };
  cancelDecision = (confirmation: DecisionConfirmation) => {
    if (this.state.confirmation === confirmation) this.publish({ ...this.state, confirmation: null });
  };
  confirmDecision = async (confirmation: DecisionConfirmation) => {
    const session = this.currentSession();
    if (!session || !this.canDecide() || this.state.confirmation !== confirmation
      || !this.state.excuses.includes(confirmation.excuse) || confirmation.excuse.owner_id === session.user.id) return;
    const { excuse, decision } = confirmation;
    const operation: Operation = { occurrenceId: excuse.occurrence_id, excuseId: excuse.id, pending: true, context: this.context, finalKnown: false };
    this.operations.set(session.user.id, operation);
    this.revision++;
    this.publish({ ...emptyState(), ...this.guards() });
    const current = () => this.context === operation.context && this.currentSession() === session;
    try {
      const result = await this.api.decideExcuse(session, excuse.id, decision);
      validateExcuse(result, excuse.occurrence_id);
      if (result.id !== excuse.id || result.owner_id !== excuse.owner_id || result.habit_id !== excuse.habit_id
        || result.status !== (decision === 'approve' ? 'approved' : 'rejected')
        || result.decision_source !== 'friend' || result.decided_by !== session.user.id) throw new Error('Invalid decision acknowledgement');
      operation.finalKnown = true;
      if (!current()) return;
      this.publish({ ...this.state, notice: `Your ${decision === 'approve' ? 'approval' : 'rejection'} was saved. The decision is final.` });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      if (code === 'excuse_already_decided') operation.finalKnown = true;
      if (!current()) return;
      if (!current()) return;
      this.publish({ ...this.state, notice: code === 'excuse_already_decided'
        ? 'Another friend already decided. Checking the final server decision.'
        : error instanceof ApiError && [403, 404].includes(error.status ?? 0)
          ? 'This excuse is no longer available. Checking current access.'
          : 'We could not confirm your decision. It may have succeeded. Checking the server before another action.' });
    } finally {
      operation.pending = false;
      // Old account/navigation responses never publish an acknowledgement. Their
      // guard remains until a new authorized read reconciles the stored decision.
      if (this.currentSession()?.user.id === session.user.id) {
        this.revision++;
        this.publish({ ...emptyState(), notice: this.state.notice, ...this.guards() });
        await this.refresh();
      }
    }
  };
}
