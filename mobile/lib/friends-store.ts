import type { Session } from '@supabase/supabase-js';
import { ApiError, type FriendRequestLists, type PublicProfile, type RelationshipResult } from './api';
import type { SessionStore } from './session-store';
import { usernameInput } from './username-input';

type ActionKind = 'send' | 'accept' | 'reject' | 'remove';
type Action = { kind: ActionKind; userId: string };
type Operation = Action & { context: number; pending: boolean; refreshRequired: boolean; clearErrorOnRefresh?: boolean };
type SessionSource = Pick<SessionStore, 'snapshot' | 'subscribe'>;
type FriendsAPI = {
  listFriends(session: Session): Promise<RelationshipResult[]>;
  listFriendRequests(session: Session): Promise<FriendRequestLists>;
  searchProfile(session: Session, username: string): Promise<PublicProfile>;
  sendFriendRequest(session: Session, userId: string): Promise<RelationshipResult>;
  acceptFriendRequest(session: Session, id: string): Promise<RelationshipResult>;
  rejectFriendRequest(session: Session, id: string): Promise<void>;
  removeFriend(session: Session, userId: string): Promise<void>;
};
export type FriendsState = {
  friends: RelationshipResult[]; incoming: RelationshipResult[]; outgoing: RelationshipResult[];
  hasLoaded: boolean; loading: boolean; refreshing: boolean; error: string | null;
  query: string; searchLoading: boolean; searchComplete: boolean;
  searchResult: PublicProfile | null; searchError: string | null;
  pendingAction: Action | null; actionError: string | null; notice: string | null;
  refreshRequired: boolean; removeConfirmation: RelationshipResult | null;
};
const emptyState = (): FriendsState => ({
  friends: [], incoming: [], outgoing: [], hasLoaded: false, loading: false, refreshing: false, error: null,
  query: '', searchLoading: false, searchComplete: false, searchResult: null, searchError: null,
  pendingAction: null, actionError: null, notice: null, refreshRequired: false, removeConfirmation: null,
});
const sessionMessage = 'Unable to verify your session. Retry, or return Home to sign out and sign in again.';
const profileMessage = 'Your profile is unavailable. Return Home to sign out and sign in again to complete onboarding.';
function readError(error: unknown, search = false) {
  if (error instanceof ApiError) {
    if (error.status === 401) return sessionMessage;
    if (!search && error.code === 'profile_not_found') return profileMessage;
    if (error.code === 'request_timeout') return `${search ? 'Username search' : 'Loading friendships'} timed out. Please retry.`;
    if (error.code === 'network_error') return `Unable to ${search ? 'search' : 'load friendships'}. Check your connection and retry.`;
  }
  return `Unable to ${search ? 'search for this username' : 'load friendships'}. Please retry.`;
}

/** Focus-scoped snapshots using the existing session and request-revision guards. */
export class FriendsStore {
  private static stores = new WeakMap<SessionSource, FriendsStore>();
  // Expo can remount this route on navigation or account changes. Keep the write
  // guards with the existing session provider; stop() still clears all UI data.
  static forSession(sessions: SessionSource, api: FriendsAPI): FriendsStore {
    let store = this.stores.get(sessions);
    if (!store) {
      store = new FriendsStore(sessions, api);
      this.stores.set(sessions, store);
    }
    return store;
  }
  private state = emptyState();
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  private active = false;
  private context = 0;
  private readRevision = 0;
  private searchRevision = 0;
  private unsubscribe?: () => void;
  // Retain only write guards across navigation/account changes. An old request
  // must settle, then a new read must reconcile it before that account can write.
  private operations = new Map<string, Operation>();

  constructor(private sessions: SessionSource, private api: FriendsAPI) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: FriendsState) { this.state = state; this.listeners.forEach(listener => listener()); }
  private currentSession() {
    const current = this.sessions.snapshot();
    return this.active && current.status === 'ready' && current.session?.user.id === this.session?.user.id ? current.session : null;
  }
  private guards() {
    const owner = this.currentSession()?.user.id;
    const operation = owner ? this.operations.get(owner) : undefined;
    return { pendingAction: operation?.pending ? { kind: operation.kind, userId: operation.userId } : null,
      refreshRequired: !!operation?.refreshRequired };
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
    this.searchRevision++;
    this.unsubscribe?.();
    this.session = null;
    this.publish(emptyState());
  }
  private acceptSession = () => {
    const current = this.sessions.snapshot();
    const session = current.status === 'ready' ? current.session : null;
    if (session === this.session) return;
    const sameUser = !!session && session.user.id === this.session?.user.id;
    const restartSearch = sameUser && this.state.searchLoading;
    this.session = session;
    this.readRevision++;
    this.searchRevision++;
    if (!sameUser) {
      this.context++;
      this.publish({ ...emptyState(), ...this.guards() });
    } else {
      this.publish({ ...this.state, searchLoading: false, removeConfirmation: null, ...this.guards() });
    }
    if (session) {
      void this.reload();
      if (restartSearch) void this.search();
    }
  };

  relationshipFor = (userId: string): 'friend' | 'incoming' | 'outgoing' | null =>
    this.state.friends.some(row => row.profile.user_id === userId) ? 'friend'
      : this.state.incoming.some(row => row.profile.user_id === userId) ? 'incoming'
        : this.state.outgoing.some(row => row.profile.user_id === userId) ? 'outgoing' : null;
  canMutate = () => !!this.currentSession() && this.state.hasLoaded && !this.state.loading && !this.state.refreshing
    && !this.state.error && !this.state.pendingAction && !this.state.refreshRequired;

  reload = async () => {
    const session = this.currentSession();
    if (!session) return;
    const revision = ++this.readRevision;
    const operationAtStart = this.operations.get(session.user.id);
    this.publish({ ...this.state, loading: !this.state.hasLoaded, refreshing: this.state.hasLoaded,
      error: null, removeConfirmation: null, ...this.guards() });
    const isCurrent = () => this.active && revision === this.readRevision && this.currentSession() === session;
    try {
      const [friends, requests] = await Promise.all([this.api.listFriends(session), this.api.listFriendRequests(session)]);
      if (!isCurrent()) return;
      // A mid-write read may already observe the commit (or a later decision).
      // Publish only the fresh read after settlement, so the write acknowledgement
      // cannot regress that snapshot or duplicate a person across the lists.
      if (this.operations.get(session.user.id)?.pending) {
        this.publish({ ...this.state, loading: false, refreshing: false, ...this.guards() });
        return;
      }
      if (friends.some(row => row.state !== 'accepted')
        || requests.incoming.some(row => row.state !== 'pending' || row.direction !== 'incoming')
        || requests.outgoing.some(row => row.state !== 'pending' || row.direction !== 'outgoing')
        || [...friends, ...requests.incoming, ...requests.outgoing].some(row => row.profile.user_id === session.user.id)) {
        throw new ApiError('Unexpected friendship response', 200, 'invalid_response');
      }
      const operation = this.operations.get(session.user.id);
      // Reads begun while a write was pending cannot establish its outcome.
      const reconciled = !!operation && !operation.pending && operation === operationAtStart;
      if (reconciled) this.operations.delete(session.user.id);
      let { searchResult, searchComplete, searchError } = this.state;
      if (searchResult) {
        const current = [...friends, ...requests.incoming, ...requests.outgoing]
          .find(row => row.profile.user_id === searchResult!.user_id)?.profile;
        if (current && current.username !== searchResult.username) {
          searchResult = null;
          searchComplete = false;
          searchError = 'This profile’s username changed. Search again using their current username.';
        } else if (current) searchResult = current;
      }
      this.publish({ ...this.state, friends, incoming: requests.incoming, outgoing: requests.outgoing,
        hasLoaded: true, loading: false, refreshing: false, error: null,
        searchResult, searchComplete, searchError, ...this.guards(),
        actionError: reconciled && operation.clearErrorOnRefresh ? null : this.state.actionError,
        notice: reconciled && operation.clearErrorOnRefresh && this.state.actionError
          ? 'Current friendship state refreshed. Review the lists before trying again.' : this.state.notice });
    } catch (error) {
      if (!isCurrent()) return;
      const missingProfile = error instanceof ApiError && error.code === 'profile_not_found';
      if (missingProfile) {
        this.context++;
        this.searchRevision++;
      }
      this.publish({ ...this.state, ...(missingProfile ? { friends: [], incoming: [], outgoing: [], hasLoaded: false,
        searchResult: null, searchComplete: false, searchLoading: false } : {}),
      loading: false, refreshing: false, error: readError(error), ...this.guards() });
    }
  };
  refresh = async () => {
    if (this.state.loading || this.state.refreshing) return;
    await this.reload();
  };

  setQuery = (query: string) => {
    if (!this.currentSession() || query === this.state.query) return;
    // Invalidate at edit time, before another search is submitted.
    this.searchRevision++;
    this.publish({ ...this.state, query, searchResult: null, searchLoading: false, searchComplete: false, searchError: null });
  };
  search = async () => {
    const session = this.currentSession();
    if (!session || this.state.searchLoading) return;
    const revision = ++this.searchRevision;
    let username: string;
    try { username = usernameInput(this.state.query); }
    catch {
      this.publish({ ...this.state, searchResult: null, searchComplete: false,
        searchError: 'Username must be 3–30 ASCII letters, digits, or underscores.' });
      return;
    }
    this.publish({ ...this.state, searchLoading: true, searchComplete: false, searchResult: null, searchError: null });
    const isCurrent = () => this.active && revision === this.searchRevision && this.currentSession() === session;
    try {
      const result = await this.api.searchProfile(session, username);
      if (!isCurrent()) return;
      if (result.username !== username || result.user_id === session.user.id) throw new ApiError('Unexpected search response', 200, 'invalid_response');
      this.publish({ ...this.state, searchLoading: false, searchComplete: true, searchResult: result, searchError: null });
    } catch (error) {
      if (!isCurrent()) return;
      // Search intentionally uses the same 404 for self, absence, and incomplete
      // onboarding. Only the list endpoint can identify a missing own profile.
      const absent = error instanceof ApiError && error.code === 'profile_not_found';
      this.publish({ ...this.state, searchLoading: false, searchComplete: absent, searchResult: null,
        searchError: absent ? null : readError(error, true) });
    }
  };

  send = async (profile: PublicProfile) => {
    if (!this.canMutate() || this.state.searchResult !== profile || this.relationshipFor(profile.user_id)) return;
    await this.change('send', profile);
  };
  accept = async (row: RelationshipResult) => {
    if (!this.canMutate() || !this.state.incoming.includes(row)) return;
    await this.change('accept', row.profile, row);
  };
  reject = async (row: RelationshipResult) => {
    if (!this.canMutate() || !this.state.incoming.includes(row)) return;
    await this.change('reject', row.profile, row);
  };
  requestRemove = (row: RelationshipResult) => {
    if (!this.canMutate() || !this.state.friends.includes(row)) return;
    // Each confirmation has its own identity, including cancel/reopen of one row.
    this.publish({ ...this.state, removeConfirmation: { ...row }, actionError: null, notice: null });
  };
  cancelRemove = (row: RelationshipResult) => {
    if (this.state.removeConfirmation === row) this.publish({ ...this.state, removeConfirmation: null });
  };
  confirmRemove = async (row: RelationshipResult) => {
    if (!this.canMutate() || this.state.removeConfirmation !== row
      || !this.state.friends.some(item => item.id === row.id && item.profile === row.profile)) return;
    await this.change('remove', row.profile, row);
  };

  private change = async (kind: ActionKind, profile: PublicProfile, row?: RelationshipResult) => {
    const session = this.currentSession();
    if (!session || this.operations.get(session.user.id)?.pending || this.operations.get(session.user.id)?.refreshRequired) return;
    const operation: Operation = { kind, userId: profile.user_id, context: this.context, pending: true, refreshRequired: false };
    const searchAtStart = this.searchRevision;
    this.operations.set(session.user.id, operation);
    this.readRevision++;
    this.publish({ ...this.state, removeConfirmation: null, actionError: null, notice: null, ...this.guards() });
    const isCurrent = () => this.context === operation.context && this.currentSession()?.user.id === session.user.id;
    let reconcile = false;
    try {
      const result = kind === 'send' ? await this.api.sendFriendRequest(session, profile.user_id)
        : kind === 'accept' ? await this.api.acceptFriendRequest(session, row!.id)
          : kind === 'reject' ? await this.api.rejectFriendRequest(session, row!.id)
            : await this.api.removeFriend(session, profile.user_id);
      if (!isCurrent()) return;
      if ((kind === 'send' || kind === 'accept') && (!result || result.profile.user_id !== profile.user_id
        || (kind === 'send' ? result.state !== 'pending' || result.direction !== 'outgoing'
          : result.id !== row!.id || result.state !== 'accepted' || result.direction !== 'incoming'))) {
        throw new ApiError('Unexpected friendship response', 200, 'invalid_response');
      }
      const changes = kind === 'send' ? { outgoing: [...this.state.outgoing.filter(item => item.profile.user_id !== profile.user_id), result as RelationshipResult] }
        : kind === 'accept' ? { incoming: this.state.incoming.filter(item => item.id !== row!.id),
          friends: [...this.state.friends.filter(item => item.profile.user_id !== profile.user_id), result as RelationshipResult] }
          : kind === 'reject' ? { incoming: this.state.incoming.filter(item => item.id !== row!.id) }
            : { friends: this.state.friends.filter(item => item.profile.user_id !== profile.user_id) };
      this.publish({ ...this.state, ...changes, notice: kind === 'send' ? 'Friend request sent.' : kind === 'accept'
        ? 'Friend request accepted.' : kind === 'reject' ? 'Friend request rejected.' : 'Friend removed. Habit sharing in both directions was removed.' });
      reconcile = true;
    } catch (error) {
      if (!isCurrent()) return;
      const code = error instanceof ApiError ? error.code : null;
      const definite = error instanceof ApiError && (code === 'configuration_error'
        || (error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 408
          && code !== 'request_timeout' && code !== 'network_error'));
      operation.clearErrorOnRefresh = !definite || code === 'profile_not_found';
      const conflicts: Record<string, string> = {
        outgoing_request_exists: 'An outgoing request is already pending. Check your outgoing requests.',
        incoming_request_exists: 'This person already sent you a request. Check your incoming requests.',
        friendship_exists: 'You are already friends. Check your friends list.',
        friend_request_not_found: 'This request is no longer pending. It may have already been processed.',
        friendship_not_found: 'This friendship is no longer available. It may have already been removed.',
        recipient_not_found: 'This profile is no longer available. Search for a current username.',
      };
      reconcile = !definite || !!conflicts[code ?? ''] || code === 'profile_not_found';
      const message = !definite ? 'We could not confirm this change. It may have succeeded. Refresh current server state before another action.'
        : conflicts[code ?? ''] ?? (code === 'profile_not_found' ? profileMessage
          : error instanceof ApiError && error.status === 401 ? sessionMessage : 'Unable to change this friendship. Please try again.');
      const recipientMissing = code === 'recipient_not_found' && this.searchRevision === searchAtStart;
      const ownProfileMissing = code === 'profile_not_found';
      if (recipientMissing || ownProfileMissing) this.searchRevision++;
      this.publish({ ...this.state, actionError: message,
        ...(ownProfileMissing ? { friends: [], incoming: [], outgoing: [], hasLoaded: false, error: profileMessage,
          searchResult: null, searchComplete: false, searchLoading: false, searchError: null } : {}),
        ...(recipientMissing ? { searchResult: null, searchComplete: false, searchLoading: false, searchError: message } : {}) });
    } finally {
      // Ignore results from another account/context, but retain the guard until a
      // read dispatched after settlement observes the server for the same owner.
      const current = isCurrent();
      if (reconcile || !current) this.operations.set(session.user.id, { ...operation, pending: false, refreshRequired: true });
      else this.operations.delete(session.user.id);
      if (this.currentSession()?.user.id === session.user.id) {
        this.readRevision++;
        this.publish({ ...this.state, loading: false, refreshing: false, ...this.guards() });
        if (reconcile || !current) await this.reload();
      }
    }
  };
}
