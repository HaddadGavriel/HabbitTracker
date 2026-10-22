export type DeletionState = { phase: 'idle' | 'checking' | 'pending' | 'not_found' | 'complete' | 'error'; message: string | null };
type Dependencies = {
  load(): Promise<string | null>; save(receipt: string, expectedUser: string): Promise<void>; newReceipt(): string;
  begin(password: string, receipt: string, expectedUser: string): Promise<{ state: string }>;
  recover(receipt: string): Promise<{ state: string }>;
  cleanup(): Promise<void>; clear(): Promise<void>;
};
/** Receipt is saved before dispatch and retained on every ambiguous response. */
export class AccountDeletionStore {
  private receipt: string | null = null;
  private busy = false;
  private listeners = new Set<() => void>();
  private state: DeletionState = { phase: 'checking', message: null };
  constructor(private deps: Dependencies) {}
  snapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(phase: DeletionState['phase'], message: string | null = null) {
    this.state = { phase, message }; this.listeners.forEach(fn => fn());
  }
  start = async () => {
    try { this.receipt = await this.deps.load(); }
    catch { this.publish('error', 'Unable to read deletion recovery state. Retry.'); return; }
    if (this.receipt) await this.recover(); else this.publish('idle');
  };
  begin = async (password: string, confirmation: string, expectedUser: string) => {
    if (this.busy) return;
    if (!password || confirmation !== 'DELETE MY ACCOUNT') throw new Error('Enter your current password and type DELETE MY ACCOUNT.');
    this.busy = true; this.publish('checking');
    try {
      this.receipt ??= this.deps.newReceipt();
      await this.deps.save(this.receipt, expectedUser);
      await this.result((await this.deps.begin(password, this.receipt, expectedUser)).state);
    } catch { this.publish('error', 'Deletion is unconfirmed. Check status. If no request is recorded, return to Settings and check your password before retrying.'); }
    finally { this.busy = false; }
  };
  recover = async () => {
    if (this.busy) return;
    this.busy = true; this.publish('checking');
    try {
      this.receipt ??= await this.deps.load();
      if (!this.receipt) { this.publish('idle'); return; }
      await this.result((await this.deps.recover(this.receipt)).state);
    } catch { this.publish('error', 'Unable to confirm deletion. Keep this device’s recovery state and retry.'); }
    finally { this.busy = false; }
  };
  private async result(state: string) {
    if (state === 'complete') {
      // Keep the receipt until ALL local cleanup succeeds; retries repeat safely.
      await this.deps.cleanup(); await this.deps.clear(); this.receipt = null;
      this.publish('complete', 'Account deleted.');
    } else if (state === 'pending') {
      await this.deps.cleanup();
      this.publish('pending', 'Deletion is pending. Ordinary account changes are blocked. Retry to finish.');
    }
    else if (state === 'not_found') this.publish('not_found', 'No deletion request is recorded yet. You can return to Settings and retry with your current password.');
    else throw new Error('Invalid deletion response');
  }
  dismiss = () => {
    if (this.state.phase === 'not_found' || this.state.phase === 'complete') this.publish('idle');
  };
}
