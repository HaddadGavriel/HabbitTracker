import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { ApiError, type ProfileCreate, type ProfileResult } from './api';

type Status = 'startup' | 'loading' | 'signed_out' | 'profile_required' | 'ready' | 'failure';
export type SessionState = { status: Status; session: Session | null; profile: ProfileResult | null; error: string | null };
type Auth = Pick<SupabaseClient['auth'], 'getSession' | 'onAuthStateChange' | 'signOut'>;
type API = { readProfile(session: Session): Promise<ProfileResult>; createProfile(session: Session, input: ProfileCreate): Promise<ProfileResult> };
export function routeAccess(status: Status) {
  return { auth: status === 'signed_out', onboarding: status === 'profile_required', home: status === 'ready', pending: status === 'startup' || status === 'loading' || status === 'failure' };
}
export class SessionStore {
  state: SessionState = { status: 'startup', session: null, profile: null, error: null };
  private listeners = new Set<() => void>();
  private revision = 0;
  private active = false;
  private unsubscribe?: () => void;
  private creation: Promise<void> | null = null;
  constructor(private auth: Auth, private api: API) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private publish(state: SessionState) { this.state = state; this.listeners.forEach(listener => listener()); }
  async start() {
    this.active = true;
    const subscription = this.auth.onAuthStateChange((_event, session) => { void this.accept(session); });
    this.unsubscribe = () => subscription.data.subscription.unsubscribe();
    const revision = this.revision;
    try {
      const { data, error } = await this.auth.getSession();
      if (!this.active || revision !== this.revision) return;
      if (error) throw error;
      await this.accept(data.session);
    } catch {
      if (this.active && revision === this.revision) this.publish({ ...this.state, status: 'failure', error: 'Unable to restore your session. Please retry.' });
    }
  }
  stop() { this.active = false; this.revision++; this.unsubscribe?.(); }
  private async accept(session: Session | null) {
    const revision = ++this.revision;
    if (!session) { this.publish({ status: 'signed_out', session: null, profile: null, error: null }); return; }
    const sameUser = session.user.id === this.state.session?.user.id;
    if (!sameUser) this.creation = null;
    const profile = sameUser ? this.state.profile : null;
    this.publish({ status: profile ? 'ready' : 'loading', session, profile, error: null });
    if (!profile) await this.load(session, revision);
  }
  private async load(session: Session, revision: number) {
    try {
      const profile = await this.api.readProfile(session);
      if (this.active && revision === this.revision) {
        if (profile.user_id !== session.user.id) throw new Error('Profile identity mismatch');
        this.publish({ status: 'ready', session, profile, error: null });
      }
    } catch (error) {
      if (!this.active || revision !== this.revision) return;
      const missing = error instanceof ApiError && error.code === 'profile_not_found';
      this.publish({ status: missing ? 'profile_required' : 'failure', session, profile: null, error: missing ? null : 'Unable to load your profile. Check your connection and retry.' });
    }
  }
  retry = async () => {
    if (!this.state.session) { await this.startAfterStop(); return; }
    await this.accept(this.state.session);
  };
  private async startAfterStop() { this.stop(); await this.start(); }
  signOut = async () => {
    // Invalidate in-flight profile reads/mutations before waiting for storage/network.
    const revision = ++this.revision;
    this.publish({ status: 'loading', session: this.state.session, profile: null, error: null });
    try {
      const { error } = await this.auth.signOut({ scope: 'local' });
      if (error) throw error;
      if (revision === this.revision) await this.accept(null);
    } catch {
      if (!this.active || revision !== this.revision) return;
      this.publish({ ...this.state, status: 'failure', profile: null, error: 'Sign-out failed. Retry sign-out before leaving this device.' });
    }
  };
  create = (input: ProfileCreate): Promise<void> => {
    if (this.creation) return this.creation;
    const operation = this.createOnce(input);
    this.creation = operation;
    void operation.finally(() => { if (this.creation === operation) this.creation = null; }).catch(() => {});
    return operation;
  };
  private async createOnce(input: ProfileCreate) {
    const session = this.state.session;
    if (!session) return;
    const revision = this.revision;
    try {
      const profile = await this.api.createProfile(session, input);
      if (!this.active || revision !== this.revision) return;
      if (profile.user_id !== session.user.id) throw new Error('Profile identity mismatch');
      this.publish({ status: 'ready', session: this.state.session, profile, error: null });
    } catch (error) {
      if (!this.active || revision !== this.revision) return;
      if (error instanceof ApiError && error.code === 'profile_already_exists') { await this.retry(); return; }
      throw error;
    }
  }
}
