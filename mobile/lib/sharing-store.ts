import type { Session } from '@supabase/supabase-js';
import { ApiError, type HabitResult, type PublicProfile, type RelationshipResult } from './api';
import type { SessionStore } from './session-store';

type SessionSource = Pick<SessionStore, 'snapshot' | 'subscribe'>;
type SharingAPI = {
  readHabit(session: Session, id: string): Promise<HabitResult>;
  listFriends(session: Session): Promise<RelationshipResult[]>;
  listHabitShares(session: Session, id: string): Promise<PublicProfile[]>;
  grantHabitShare(session: Session, id: string, friendId: string): Promise<PublicProfile>;
  revokeHabitShare(session: Session, id: string, friendId: string): Promise<void>;
};
type Action = { kind: 'grant' | 'revoke'; userId: string };
type Operation = Action & { pending: boolean; outcome: 'success' | 'uncertain' | 'failed' };
export type SharingState = {
  habit: HabitResult | null; friends: RelationshipResult[]; grants: PublicProfile[];
  hasLoaded: boolean; loading: boolean; refreshing: boolean; unavailable: boolean;
  error: string | null; actionError: string | null; notice: string | null;
  pendingAction: Action | null; refreshRequired: boolean;
};
const emptyState = (): SharingState => ({
  habit: null, friends: [], grants: [], hasLoaded: false, loading: false, refreshing: false,
  unavailable: false, error: null, actionError: null, notice: null, pendingAction: null, refreshRequired: false,
});
const sessionMessage = 'Unable to verify your session. Retry, or return Home to sign out and sign in again.';
const profileMessage = 'Your profile is unavailable. Return Home to sign out and sign in again to complete onboarding.';
const missingMessage = 'This habit was not found or is no longer available to your account.';
function readError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return sessionMessage;
    if (error.code === 'profile_not_found') return profileMessage;
    if (error.code === 'habit_not_found' || error.status === 403) return missingMessage;
    if (error.code === 'inconsistent_sharing') return 'Friendships changed while loading permissions. Refresh to load current server state.';
    if (error.code === 'request_timeout') return 'Loading sharing timed out. Please retry.';
  }
  return 'Unable to load sharing. Check your connection and retry.';
}

/** Only server snapshots establish grants. Unsettled writes survive route remounts. */
export class SharingStore {
  private static stores = new WeakMap<SessionSource, Map<string, SharingStore>>();
  static forSession(sessions: SessionSource, api: SharingAPI, id: string) {
    let stores = this.stores.get(sessions);
    if (!stores) { stores = new Map(); this.stores.set(sessions, stores); }
    let store = stores.get(id);
    if (!store) { store = new SharingStore(sessions, api, id); stores.set(id, store); }
    return store;
  }
  private state = emptyState();
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  private active = false;
  private context = 0;
  private readRevision = 0;
  private unsubscribe?: () => void;
  // No profile or permission data survives stop(); only write guards are retained.
  private operations = new Map<string, Operation>();
  constructor(private sessions: SessionSource, private api: SharingAPI, private id: string) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: SharingState) { this.state = state; this.listeners.forEach(listener => listener()); }
  private currentSession() {
    const current = this.sessions.snapshot();
    return this.active && current.status === 'ready' && current.session === this.session ? current.session : null;
  }
  private guards() {
    const owner = this.currentSession()?.user.id;
    const operation = owner ? this.operations.get(owner) : undefined;
    return { pendingAction: operation?.pending ? { kind: operation.kind, userId: operation.userId } : null,
      refreshRequired: !!operation && !operation.pending };
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
    this.readRevision++;
    this.unsubscribe?.();
    this.session = null;
    this.publish(emptyState());
  }
  private acceptSession = () => {
    const current = this.sessions.snapshot();
    const session = current.status === 'ready' ? current.session : null;
    if (session === this.session) return;
    this.session = session;
    this.context++;
    this.readRevision++;
    // Token replacement also invalidates old reads, writes, and captured rows.
    this.publish({ ...emptyState(), ...this.guards() });
    if (session) void this.reload();
  };
  isShared = (userId: string) => this.state.grants.some(profile => profile.user_id === userId);
  canMutate = () => !!this.currentSession() && this.state.hasLoaded && !this.state.unavailable
    && !this.state.loading && !this.state.refreshing && !this.state.error
    && !this.state.pendingAction && !this.state.refreshRequired;

  reload = async () => {
    const session = this.currentSession();
    if (!session) return;
    const revision = ++this.readRevision;
    const operationAtStart = this.operations.get(session.user.id);
    this.publish({ ...this.state, loading: !this.state.hasLoaded, refreshing: this.state.hasLoaded,
      error: null, notice: null, ...this.guards() });
    const isCurrent = () => revision === this.readRevision && this.currentSession() === session;
    try {
      const [habit, friends, grants] = await Promise.all([
        this.api.readHabit(session, this.id), this.api.listFriends(session), this.api.listHabitShares(session, this.id),
      ]);
      if (!isCurrent()) return;
      // Reads that began before write settlement cannot establish its outcome.
      if (this.operations.get(session.user.id)?.pending) {
        this.publish({ ...this.state, loading: false, refreshing: false, ...this.guards() });
        return;
      }
      if (habit.id !== this.id || habit.owner_id !== session.user.id
        || friends.some(row => row.state !== 'accepted' || row.profile.user_id === session.user.id)
        || grants.some(profile => profile.user_id === session.user.id)) {
        throw new ApiError('Unexpected sharing response', 200, 'invalid_response');
      }
      // These endpoints are separate transactions. Do not present a grant and an
      // absent friendship as a consistent, current permission snapshot.
      if (grants.some(profile => !friends.some(row => row.profile.user_id === profile.user_id))) {
        throw new ApiError('Friendships changed between reads', 200, 'inconsistent_sharing');
      }
      const operation = this.operations.get(session.user.id);
      const reconciled = !!operation && !operation.pending && operation === operationAtStart;
      let notice: string | null = null;
      if (reconciled) {
        this.operations.delete(session.user.id);
        if (operation.outcome !== 'failed') {
          const shared = grants.some(profile => profile.user_id === operation.userId);
          notice = shared ? 'Current server state confirms this friend has a sharing grant.'
            : 'Current server state confirms this friend has no sharing grant.';
        }
      }
      this.publish({ ...this.state, habit, friends: friends.map(row => ({ ...row, profile: { ...row.profile } })),
        grants: grants.map(profile => ({ ...profile })), hasLoaded: true, loading: false, refreshing: false,
        unavailable: false, error: null, notice, ...this.guards(),
        actionError: reconciled && operation.outcome !== 'failed' ? null : this.state.actionError });
    } catch (error) {
      if (!isCurrent()) return;
      const inaccessible = error instanceof ApiError && (error.code === 'habit_not_found' || error.status === 403);
      const clear = inaccessible || error instanceof ApiError && (error.status === 401 || error.code === 'profile_not_found');
      this.publish({ ...(clear ? emptyState() : this.state), loading: false, refreshing: false,
        unavailable: inaccessible, error: readError(error), notice: null, ...this.guards() });
    }
  };
  refresh = async () => {
    if (this.state.loading || this.state.refreshing) return;
    await this.reload();
  };
  grant = async (row: RelationshipResult) => {
    if (!this.canMutate() || !this.state.friends.includes(row) || this.isShared(row.profile.user_id)) return;
    await this.change('grant', row);
  };
  revoke = async (row: RelationshipResult) => {
    if (!this.canMutate() || !this.state.friends.includes(row) || !this.isShared(row.profile.user_id)) return;
    await this.change('revoke', row);
  };
  private change = async (kind: Action['kind'], row: RelationshipResult) => {
    const session = this.currentSession();
    if (!session || this.operations.has(session.user.id)) return;
    const context = this.context;
    const operation: Operation = { kind, userId: row.profile.user_id, pending: true, outcome: 'uncertain' };
    this.operations.set(session.user.id, operation);
    this.readRevision++;
    this.publish({ ...this.state, actionError: null, notice: null, ...this.guards() });
    const isCurrent = () => context === this.context && this.currentSession() === session;
    try {
      const result = kind === 'grant' ? await this.api.grantHabitShare(session, this.id, row.profile.user_id)
        : await this.api.revokeHabitShare(session, this.id, row.profile.user_id);
      if (!isCurrent()) return;
      if (kind === 'grant' && (!result || result.user_id !== row.profile.user_id)) {
        throw new ApiError('Unexpected grant response', 200, 'invalid_response');
      }
      operation.outcome = 'success';
    } catch (error) {
      if (!isCurrent()) return;
      const code = error instanceof ApiError ? error.code : null;
      const definite = error instanceof ApiError && (code === 'configuration_error'
        || error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 408
          && code !== 'request_timeout' && code !== 'network_error');
      operation.outcome = definite ? 'failed' : 'uncertain';
      const message = !definite ? 'We could not confirm this change. It may have succeeded. Refresh current server state before another action.'
        : code === 'friendship_required' ? 'The change was rejected because this person was no longer an accepted friend. Removing a friendship deletes its grants; becoming friends again does not restore them. Review the refreshed friends before sharing again.'
          : code === 'profile_not_found' ? profileMessage
            : code === 'habit_not_found' || error instanceof ApiError && error.status === 403 ? missingMessage
              : error instanceof ApiError && error.status === 401 ? sessionMessage : 'Unable to change sharing. Please try again after refreshing.';
      const inaccessible = code === 'habit_not_found' || error instanceof ApiError && error.status === 403;
      const clear = inaccessible || code === 'profile_not_found' || error instanceof ApiError && error.status === 401;
      this.publish({ ...(clear ? emptyState() : this.state), actionError: message,
        ...(clear ? { unavailable: inaccessible, error: message } : {}),
        ...(code === 'friendship_required' ? {
          friends: this.state.friends.filter(item => item.profile.user_id !== row.profile.user_id),
          grants: this.state.grants.filter(profile => profile.user_id !== row.profile.user_id),
        } : {}) });
    } finally {
      // Never repeat a PUT/DELETE. Even after a token/account/focus change, the
      // original owner must reconcile the settled write before another action.
      this.operations.set(session.user.id, { ...operation, pending: false });
      if (this.currentSession()?.user.id === session.user.id) {
        this.readRevision++;
        this.publish({ ...this.state, loading: false, refreshing: false, ...this.guards() });
        await this.reload();
      }
    }
  };
}
