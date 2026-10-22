import type { Session } from '@supabase/supabase-js';

export type Registration = { userId: string; registrationId: string };
export type NotificationJournal = { enabledUser: string | null; registrations: Registration[] };
export type NotificationState = {
  status: 'signed_out' | 'off' | 'checking' | 'enabled' | 'denied' | 'error';
  busy: boolean; message: string; cleanupPending: boolean; clearFailed: boolean;
};
export type NotificationDependencies = {
  load(): Promise<NotificationJournal | null>;
  save(journal: NotificationJournal): Promise<void>;
  newId(): string;
  prepareChannels(): Promise<void>;
  permission(request: boolean): Promise<boolean>;
  getToken(): Promise<string>;
  register(session: Session, token: string, registrationId: string): Promise<void>;
  unregister(session: Session, registrationId: string): Promise<void>;
  clearPresented(): Promise<void>;
};

/** One application-scoped owner of all notification registration work.
 * The durable journal contains only owner/intent IDs, never tokens/credentials.
 * All writes are serialized; auth changes invalidate work synchronously, before
 * React rerenders. Cancellation tombstones fence even ambiguous HTTP outcomes.
 */
export class NotificationService {
  private session: Session | null = null;
  private epoch = 0;
  private journal: NotificationJournal = { enabledUser: null, registrations: [] };
  private loaded = false;
  private confirmed: { registrationId: string; token: string; userId: string } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private refreshWork: { epoch: number; promise: Promise<void> } | null = null;
  private listeners = new Set<() => void>();
  private state: NotificationState = { status: 'signed_out', busy: false, message: 'Sign in to enable notifications.', cleanupPending: false, clearFailed: false };
  constructor(private deps: NotificationDependencies) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<NotificationState>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach(listener => listener());
  }
  private async init() {
    if (this.loaded) return;
    this.journal = await this.deps.load() ?? { enabledUser: null, registrations: [] };
    this.loaded = true;
    this.publish({ cleanupPending: this.journal.registrations.length > 0 });
  }
  private async save() { await this.deps.save(this.journal); }
  private run(operation: () => Promise<void>) {
    const work = this.queue.then(async () => {
      try { await this.init(); await operation(); }
      catch {
        const denied = this.state.status === 'denied';
        this.publish({ status: denied ? 'denied' : 'error',
          message: denied ? this.state.message : 'Notification changes could not be confirmed. Retry when connected.',
          cleanupPending: !this.loaded || this.journal.registrations.length > 0 });
      }
      finally { this.publish({ busy: false }); }
    });
    this.queue = work;
    return work;
  }
  private async clear() {
    try { await this.deps.clearPresented(); this.publish({ clearFailed: false }); }
    catch { this.publish({ clearFailed: true }); }
  }
  private async cleanup(session: Session) {
    for (const entry of [...this.journal.registrations]) {
      if (entry.userId !== session.user.id) continue;
      // Never treat timeout/401/offline as removal. The server must confirm the
      // cancellation fence, even if the original POST response was lost.
      await this.deps.unregister(session, entry.registrationId);
      this.journal.registrations = this.journal.registrations.filter(item => item !== entry);
      if (this.confirmed?.registrationId === entry.registrationId) this.confirmed = null;
      await this.save();
    }
    this.publish({ cleanupPending: this.journal.registrations.some(entry => entry.registrationId !== this.confirmed?.registrationId) });
  }
  setSession = (session: Session | null, cleanupSession?: Session | null): Promise<void> => {
    const old = this.session ?? cleanupSession ?? null;
    if (old?.user.id === session?.user.id && old?.access_token === session?.access_token && this.loaded) return this.queue;
    const switched = old?.user.id !== session?.user.id;
    this.session = session;
    const clearing = switched ? this.clear() : Promise.resolve();
    const epoch = ++this.epoch;
    this.confirmed = null;
    this.publish({ status: session ? 'checking' : 'signed_out', busy: true,
      message: session ? 'Checking notification status…' : 'Signed out. Notification cleanup may still be pending.' });
    // Old credentials live only in this bounded transition, never in the journal.
    return this.run(async () => {
      if (switched) {
        await clearing;
        if (old) {
          this.journal.enabledUser = null;
          await this.save();
          try { await this.cleanup(old); }
          catch { this.publish({ cleanupPending: true }); }
        }
      }
      if (epoch !== this.epoch) return;
      await this.reconcile(epoch, false);
    });
  };
  /** Only after the server confirms pending/complete deletion and revokes writes. */
  forgetDeletedAccount = async (): Promise<void> => {
    await this.setSession(null);
    let failure = false;
    await this.run(async () => {
      this.journal = { enabledUser: null, registrations: [] };
      try { await this.save(); } catch { failure = true; }
      this.publish({ cleanupPending: false });
    });
    if (failure || !this.loaded) throw new Error('Unable to clear notification journal');
  };
  refresh = (renew = false): Promise<void> => {
    const epoch = this.epoch;
    if (this.refreshWork?.epoch === epoch) return this.refreshWork.promise;
    const promise = this.run(async () => {
      if (renew && epoch === this.epoch) this.confirmed = null;
      await this.reconcile(epoch, false);
    });
    this.refreshWork = { epoch, promise };
    void promise.then(() => { if (this.refreshWork?.promise === promise) this.refreshWork = null; });
    return promise;
  };
  tokenChanged = (): Promise<void> => {
    // Native token events require a fresh Expo token (the event is NOT an Expo
    // token). Invalidating the epoch also prevents an older token read posting.
    this.epoch++;
    this.confirmed = null;
    return this.refresh();
  };
  enable = (): Promise<void> => {
    const epoch = this.epoch;
    const userId = this.session?.user.id;
    if (!userId) return Promise.resolve();
    this.publish({ busy: true });
    return this.run(async () => {
      if (epoch !== this.epoch) return;
      this.journal.enabledUser = userId;
      await this.save();
      await this.reconcile(epoch, true);
    });
  };
  disable = (): Promise<void> => {
    const epoch = ++this.epoch;
    this.confirmed = null;
    this.publish({ busy: true, status: 'off', message: 'Disabling notifications…' });
    return this.run(async () => {
      this.journal.enabledUser = null;
      await this.save();
      await this.clear();
      await this.reconcile(epoch, false);
    });
  };
  retryCleanup = (): Promise<void> => {
    const epoch = ++this.epoch;
    this.confirmed = null;
    return this.run(async () => {
      await this.clear();
      await this.reconcile(epoch, false);
    });
  };
  canPresent = () => this.session !== null && this.confirmed?.userId === this.session.user.id && this.state.status === 'enabled';
  private async reconcile(epoch: number, requestPermission: boolean) {
    const current = () => epoch === this.epoch;
    if (!current()) return;
    const session = this.session;
    if (!session) {
      // Restart while signed out: forget opt-in, retain cleanup IDs for recovery.
      this.journal.enabledUser = null;
      await this.save();
      await this.clear();
      this.publish({ status: 'signed_out', message: 'Sign in to enable notifications.', cleanupPending: this.journal.registrations.length > 0 });
      return;
    }
    this.publish({ busy: true, status: 'checking', message: 'Checking notification status…' });
    // On restart/uncertain response all journal entries are unconfirmed. Retry
    // them with this account's NEW credentials before creating another intent.
    if (this.journal.registrations.some(entry => entry.userId === session.user.id && entry.registrationId !== this.confirmed?.registrationId)) {
      await this.cleanup(session);
    }
    if (!current()) return;
    if (this.journal.registrations.some(entry => entry.userId !== session.user.id)) {
      this.publish({ status: 'off', message: 'Finish notification cleanup for the previous account before enabling here.', cleanupPending: true });
      return;
    }
    if (this.journal.enabledUser !== session.user.id) {
      await this.cleanup(session);
      if (current()) this.publish({ status: 'off', message: 'Notification registration is off in this app.' });
      return;
    }
    await this.deps.prepareChannels();
    if (!current()) return;
    const allowed = await this.deps.permission(requestPermission);
    if (!current()) return;
    if (!allowed) {
      this.confirmed = null;
      this.journal.enabledUser = null;
      await this.save();
      await this.clear();
      try { await this.cleanup(session); }
      finally { if (current()) this.publish({ status: 'denied', message: 'Notifications are blocked. Allow them in system notification settings, then tap Enable notifications.' }); }
      return;
    }
    const token = await this.deps.getToken();
    if (!current()) return;
    if (this.confirmed?.token === token && this.confirmed.userId === session.user.id) {
      this.publish({ status: 'enabled', message: 'Notifications are enabled for this account.', cleanupPending: false });
      return;
    }
    await this.cleanup(session);
    if (!current()) return;
    const registrationId = this.deps.newId();
    this.journal.registrations.push({ userId: session.user.id, registrationId });
    await this.save(); // Write ahead of POST: a lost response is still recoverable.
    if (!current()) return;
    await this.deps.register(session, token, registrationId);
    if (!current()) return;
    this.confirmed = { userId: session.user.id, registrationId, token };
    this.publish({ status: 'enabled', message: 'Notifications are enabled for this account.', cleanupPending: false });
  }
}
