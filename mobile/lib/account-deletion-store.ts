export type DeletionReceipt = { owner: string; receipt: string };
type Phase = 'idle' | 'checking' | 'pending' | 'not_found' | 'complete' | 'cleanup_pending' | 'error';
export type DeletionState = {
  phase: Phase; message: string | null; owner: string | null; canDismiss: boolean;
  saved: { owner: string }[];
};
type Dependencies = {
  load(): Promise<DeletionReceipt[]>; save(entries: DeletionReceipt[]): Promise<void>; newReceipt(): string;
  currentOwner(): string | null | undefined; // undefined means Auth is still restoring.
  subscribeAccount(listener: () => void): () => void;
  begin(password: string, receipt: string, expectedUser: string): Promise<{ state: string }>;
  recover(receipt: string): Promise<{ state: string }>;
  cleanup(owner: string): Promise<boolean>; // false: another account owns the device; defer.
};
/** Each account retains its own capability until confirmed deletion AND durable
 * local cleanup. Navigation never changes ownership of an in-flight operation. */
export class AccountDeletionStore {
  private entries: DeletionReceipt[] = [];
  private results = new Map<string, { phase: Phase; message: string | null }>();
  private busy = new Set<string>();
  private listeners = new Set<() => void>();
  private focus: string | null = null;
  private activeOwner: string | null | undefined;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private journal: Promise<unknown> = Promise.resolve();
  private unsubscribe?: () => void;
  private loadError = false;
  private state: DeletionState = { phase: 'checking', message: null, owner: null, canDismiss: false, saved: [] };
  constructor(private deps: Dependencies) {}
  snapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish() {
    const result = this.focus ? this.results.get(this.focus) : undefined;
    const phase = !this.loaded ? this.loadError ? 'error' : 'checking'
      : this.activeOwner === undefined ? 'checking' : result?.phase ?? 'idle';
    this.state = { phase, owner: this.focus, saved: this.entries.map(({ owner }) => ({ owner })),
      message: !this.loaded && this.loadError ? 'Unable to read deletion recovery state. Retry.' : result?.message ?? null,
      canDismiss: this.loaded && this.activeOwner !== undefined && this.focus !== null
        && (this.activeOwner !== this.focus || phase === 'not_found' || phase === 'complete'),
    };
    this.listeners.forEach(fn => fn());
  }
  private result(owner: string, phase: Phase, message: string | null = null) {
    this.results.set(owner, { phase, message }); this.publish();
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.journal.then(operation); this.journal = work.catch(() => {}); return work;
  }
  private async load() {
    if (this.loaded) return;
    if (!this.loading) this.loading = this.deps.load().then(entries => {
      this.entries = entries; this.loaded = true; this.loadError = false;
    }).finally(() => { this.loading = null; });
    await this.loading;
  }
  private accountChanged = () => {
    const owner = this.deps.currentOwner();
    if (owner === this.activeOwner) return;
    this.activeOwner = owner;
    if (owner) this.focus = this.entries.some(e => e.owner === owner) ? owner : null;
    this.publish();
    if (this.loaded && owner !== undefined) void this.recoverSaved();
  };
  start = async () => {
    this.unsubscribe ??= this.deps.subscribeAccount(this.accountChanged);
    try {
      await this.load();
      this.activeOwner = this.deps.currentOwner();
      this.focus = this.entries.find(e => e.owner === this.activeOwner)?.owner
        ?? (this.activeOwner === null ? this.entries[0]?.owner ?? null : null);
      this.publish();
      if (this.activeOwner !== undefined) await this.recoverSaved();
    } catch { this.loadError = true; this.publish(); }
  };
  stop = () => { this.unsubscribe?.(); this.unsubscribe = undefined; };
  private recoverSaved = async () => {
    await Promise.all(this.entries.map(entry => this.recoverOwner(entry.owner)));
  };
  begin = async (password: string, confirmation: string, expectedUser: string) => {
    if (this.busy.has(expectedUser)) return;
    if (!password || confirmation !== 'DELETE MY ACCOUNT') throw new Error('Enter your current password and type DELETE MY ACCOUNT.');
    if (this.deps.currentOwner() !== expectedUser) throw new Error('Account changed. Review deletion again.');
    this.busy.add(expectedUser); this.focus = expectedUser; this.result(expectedUser, 'checking');
    try {
      await this.load();
      const entry = await this.exclusive(async () => {
        let entry = this.entries.find(e => e.owner === expectedUser);
        if (!entry) {
          entry = { owner: expectedUser, receipt: this.deps.newReceipt() };
          this.entries = [...this.entries, entry];
        }
        // Retain the same in-memory receipt even if a storage response is lost.
        // A failed save never dispatches, and another owner's save cannot drop it.
        await this.deps.save(this.entries);
        return entry;
      });
      await this.accept(entry, (await this.deps.begin(password, entry.receipt, expectedUser)).state);
    } catch { this.result(expectedUser, 'error', 'Deletion is unconfirmed. Check status. If no request is recorded, return to Settings and check your password before retrying.'); }
    finally { this.busy.delete(expectedUser); }
  };
  recover = async (owner?: string) => {
    if (!this.loaded) { await this.start(); return; }
    const target = owner ?? this.focus ?? this.entries[0]?.owner;
    if (!target) { this.publish(); return; }
    this.focus = target; this.publish();
    await this.recoverOwner(target);
  };
  private recoverOwner = async (owner: string) => {
    const entry = this.entries.find(e => e.owner === owner);
    if (!entry || this.busy.has(owner)) return;
    this.busy.add(owner); this.result(owner, 'checking');
    try { await this.accept(entry, (await this.deps.recover(entry.receipt)).state); }
    catch { this.result(owner, 'error', 'Unable to confirm deletion. Your saved recovery is retained. Retry when connected.'); }
    finally { this.busy.delete(owner); }
  };
  private async accept(entry: DeletionReceipt, state: string) {
    if (state === 'complete' || state === 'pending') {
      if (this.activeOwner === entry.owner) this.focus = entry.owner;
      const cleaned = await this.deps.cleanup(entry.owner);
      if (state === 'complete' && cleaned) {
        await this.exclusive(async () => {
          const remaining = this.entries.filter(e => e !== entry);
          await this.deps.save(remaining);
          // Forget completed ownership only after durable removal succeeds.
          this.entries = remaining;
        });
        this.result(entry.owner, 'complete', 'Account deleted.');
      } else if (state === 'complete') {
        this.result(entry.owner, 'cleanup_pending', 'This saved deletion is confirmed. Local cleanup will retry when the device is signed out. You can continue with the current account.');
      } else this.result(entry.owner, 'pending', 'Deletion is pending. Changes to that account are blocked. Retry to finish.');
    } else if (state === 'not_found') {
      this.result(entry.owner, 'not_found', 'No deletion request is recorded yet. Recovery is retained because an earlier request may still finish. You can return to the app; retry deletion from Settings while signed into that account.');
    } else throw new Error('Invalid deletion response');
  }
  dismiss = () => {
    if (this.state.canDismiss) { this.focus = null; this.publish(); }
  };
}
