import type { SupabaseClient } from '@supabase/supabase-js';
export const authRedirect = 'habittrackerinfra://auth-callback';
type Kind = 'recovery' | 'signup';
type Link = { kind: Kind; access_token: string; refresh_token: string } | { kind: Kind; token_hash: string };
const invalid = () => new Error('This authentication link is invalid, expired, or already used. Request a new email.');
/** Accept only our callback and legacy root URI. Never return provider error text. */
export function parseAuthLink(raw: string): Link | null {
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid(); }
  if (url.protocol !== 'habittrackerinfra:') return null;
  const route = `${url.hostname}${url.pathname}`;
  if (!['', '/', 'auth-callback', 'auth-callback/', '/auth-callback'].includes(route)) {
    if (url.hash || /(?:token|code|error|type)=/.test(url.search)) throw invalid();
    return null;
  }
  if (!url.hash && !url.search) return null;
  if (url.username || url.password || url.port || /%(?![0-9a-f]{2})/i.test(raw)) throw invalid();
  const params = new URLSearchParams(url.search);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const allowed = new Set(['type', 'access_token', 'refresh_token', 'token_hash', 'token_type', 'expires_in', 'expires_at', 'error', 'error_code', 'error_description']);
  const values = new Map<string, string>();
  for (const [key, value] of [...params, ...fragment]) {
    if (!allowed.has(key) || values.has(key) || !value || value.length > 16384) throw invalid();
    values.set(key, value);
  }
  if (values.has('error') || values.has('error_code') || values.has('error_description')) throw invalid();
  for (const key of ['expires_in', 'expires_at']) {
    const value = values.get(key);
    if (value && (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw invalid();
  }
  const kind = values.get('type');
  if (kind !== 'recovery' && kind !== 'signup') throw invalid();
  const hash = values.get('token_hash'), access = values.get('access_token'), refresh = values.get('refresh_token');
  if (hash && !access && !refresh && /^[a-zA-Z0-9_-]+$/.test(hash)) return { kind, token_hash: hash };
  if (!hash && access && refresh && (!values.has('token_type') || values.get('token_type') === 'bearer')) return { kind, access_token: access, refresh_token: refresh };
  throw invalid();
}
type Auth = Pick<SupabaseClient['auth'], 'setSession' | 'verifyOtp' | 'getUser' | 'updateUser'> & Partial<Pick<SupabaseClient['auth'], 'dispose'>>;
export type LinkState = { phase: 'idle' | 'loading' | 'decision' | 'recovery' | 'confirmed' | 'error' | 'updated'; email?: string; error?: string };
/** One isolated, nonpersistent Auth client per link. Never mutates the app session. */
export class AuthLinks {
  private state: LinkState = { phase: 'idle' };
  private listeners = new Set<() => void>();
  private revision = 0;
  private client?: Auth;
  private kind?: Kind;
  private seen = new Set<string>();
  private busy = false;
  private currentLink?: string;
  private linkedUser?: string;
  private approvedFrom?: string;
  constructor(private createAuth: () => Auth, private currentUser: () => string | undefined) {}
  snapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(state: LinkState) { this.state = state; this.listeners.forEach(fn => fn()); }
  private release(client = this.client) { void client?.dispose?.().catch(() => {}); if (client === this.client) this.client = undefined; }
  cancel = () => { this.revision++; this.release(); this.busy = false; this.publish({ phase: 'idle' }); };
  open = async (raw: string) => {
    if (this.seen.has(raw)) {
      if (raw === this.currentLink && ['loading', 'decision', 'recovery'].includes(this.state.phase)) return;
      this.cancel(); this.publish({ phase: 'error', error: invalid().message }); return;
    }
    let link: Link | null;
    try { link = parseAuthLink(raw); } catch { this.cancel(); this.publish({ phase: 'error', error: invalid().message }); return; }
    if (!link) return;
    this.seen.add(raw); this.currentLink = raw;
    const revision = ++this.revision;
    this.release(); this.busy = false; this.approvedFrom = undefined;
    this.publish({ phase: 'loading' });
    const client = this.createAuth();
    try {
      const response = 'token_hash' in link ? await client.verifyOtp({ token_hash: link.token_hash, type: link.kind }) : await client.setSession(link);
      if (revision !== this.revision) return;
      if (response.error || !response.data.session) throw invalid();
      const verified = await client.getUser();
      if (revision !== this.revision) return;
      if (verified.error || !verified.data.user || verified.data.user.id !== response.data.session.user.id) throw invalid();
      this.client = client; this.kind = link.kind; this.linkedUser = verified.data.user.id;
      const current = this.currentUser();
      this.publish({ phase: current && current !== verified.data.user.id ? 'decision' : link.kind === 'recovery' ? 'recovery' : 'confirmed', email: verified.data.user.email });
    } catch { if (revision === this.revision) this.publish({ phase: 'error', error: invalid().message }); }
    finally { if (this.client !== client) this.release(client); }
  };
  continue = () => {
    if (this.state.phase === 'decision') { this.approvedFrom = this.currentUser(); this.publish({ phase: this.kind === 'recovery' ? 'recovery' : 'confirmed', email: this.state.email }); }
  };
  updatePassword = async (password: string, confirmation: string) => {
    if (this.busy || this.state.phase !== 'recovery' || !this.client) return;
    const current = this.currentUser();
    if (current && current !== this.linkedUser && current !== this.approvedFrom) { this.publish({ phase: 'decision', email: this.state.email }); return; }
    if (password.length < 6 || password !== confirmation) { this.publish({ ...this.state, error: 'Use at least 6 characters and matching passwords.' }); return; }
    const revision = this.revision;
    this.busy = true;
    try {
      const result = await this.client.updateUser({ password });
      if (revision !== this.revision) return;
      if (result.error) throw invalid();
      this.release();
      this.publish({ phase: 'updated' });
    } catch { if (revision === this.revision) this.publish({ ...this.state, error: 'Password update failed. Check password requirements and your connection, or request a fresh recovery email if the link expired.' }); }
    finally { if (revision === this.revision) this.busy = false; }
  };
}
