import type { SupabaseClient } from '@supabase/supabase-js';
import { authRedirect } from './auth-links';
export class EmailRequest {
  private next = 0;
  private busy = false;
  constructor(private auth: Pick<SupabaseClient['auth'], 'resetPasswordForEmail' | 'resend'>, private now = () => Date.now()) {}
  remaining = () => Math.max(0, Math.ceil((this.next - this.now()) / 1000));
  async send(email: string, confirmation = false): Promise<string> {
    if (this.busy || this.remaining()) return `Please wait ${this.remaining() || 60} seconds before requesting another email.`;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Enter a valid email address.';
    this.busy = true; this.next = this.now() + 60_000;
    try {
      const result = confirmation ? await this.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: authRedirect } })
        : await this.auth.resetPasswordForEmail(email.trim(), { redirectTo: authRedirect });
      if (result.error && (result.error.status === 429 || result.error.code === 'over_email_send_rate_limit')) return 'Too many requests. Wait before trying again.';
      if (result.error && (result.error.status ?? 0) >= 500) return 'Email service is unavailable. Try again later.';
      return confirmation ? 'If confirmation is available for this address, a new confirmation email will arrive. Check spam too.' : 'If this address has an account, a recovery email will arrive. Check spam too.';
    } catch { return 'Unable to contact the email service. Check your connection and try again later.'; }
    finally { this.busy = false; }
  }
}
