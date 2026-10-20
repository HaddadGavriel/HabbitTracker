import type { Session } from '@supabase/supabase-js';
import type { HabitResult, HistoryResult, TodayResult } from './api';
import type { SessionState } from './session-store';
import { isTimestamp, uuidPattern } from './reminder-rules';

type Target = { kind: 'today' } | { kind: 'infrastructure' } | { kind: 'habit'; habit: string; occurrence: string; reminder: string };
export type Tap = { key: string; target: Target };
export type TapDestination = '/today' | '/home' | '/diagnostics' | { pathname: '/habit-history'; params: { id: string } };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Payload URLs, route names, dates and account claims are never navigation authority. */
export function parseNotificationTap(response: unknown, defaultAction: string): Tap | null {
  if (!object(response) || response.actionIdentifier !== defaultAction || !object(response.notification)
    || !object(response.notification.request)) return null;
  const request = response.notification.request;
  if (typeof request.identifier !== 'string' || !request.identifier || request.identifier.length > 256
    || !object(request.content) || !object(request.content.data)) return null;
  const data = request.content.data;
  if (data.type === 'habit_reminder') {
    const ids = [data.reminder_id, data.habit_id, data.occurrence_id];
    if (ids.every(id => id === undefined)) return { key: `notification:${request.identifier}`, target: { kind: 'today' } };
    if (!ids.every(id => typeof id === 'string' && uuidPattern.test(id))) return null;
    const [reminder, habit, occurrence] = (ids as string[]).map(id => id.toLowerCase());
    return { key: `reminder:${reminder}`, target: { kind: 'habit', habit, occurrence, reminder } };
  }
  // Infrastructure pushes predate the typed reminder contract. Never use their
  // request ID as a habit/occurrence ID or pass payload content into a route.
  if ((data.type === undefined || data.type === 'infrastructure_test') && typeof data.request_id === 'string'
    && /^[A-Za-z0-9_-]{8,100}$/.test(data.request_id) && isTimestamp(data.server_timestamp)) {
    return { key: `infrastructure:${request.identifier}`, target: { kind: 'infrastructure' } };
  }
  return null;
}

type Dependencies = {
  loadHandled(): Promise<unknown>;
  saveHandled(keys: string[]): Promise<void>;
  readToday(session: Session): Promise<TodayResult>;
  readHabit(session: Session, id: string): Promise<HabitResult>;
  readHabitHistory(session: Session, id: string): Promise<HistoryResult>;
  navigate(destination: TapDestination): void;
};
type Pending = { tap: Tap; user: string | null; claimed: boolean };
export class NotificationTaps {
  private session: SessionState = { status: 'startup', session: null, profile: null, error: null };
  private ready = false;
  private foreground = true;
  private epoch = 0;
  private pending: Pending | null = null;
  private running: object | null = null;
  private seen = new Set<string>();
  private handled: Set<string> | null = null;
  private storage: Promise<void> = Promise.resolve();
  private message: string | null = null;
  private listeners = new Set<() => void>();
  constructor(private deps: Dependencies) {}
  snapshot = () => this.message;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(message: string | null) { this.message = message; this.listeners.forEach(listener => listener()); }
  dismiss = () => this.publish(null);
  setSession = (state: SessionState) => {
    if (state === this.session) return;
    if (this.pending && ((this.pending.user && this.pending.user !== state.session?.user.id)
      || (this.session.status === 'ready' && state.status !== 'ready'))) this.pending = null;
    this.session = state;
    if (this.pending && !this.pending.user && state.session) this.pending.user = state.session.user.id;
    this.epoch++;
    this.publish(null);
    this.pump();
  };
  setReady = (ready: boolean) => { if (this.ready !== ready) { this.ready = ready; this.epoch++; } this.pump(); };
  setForeground = (foreground: boolean) => { if (this.foreground !== foreground) { this.foreground = foreground; this.epoch++; } this.pump(); };
  stop = () => { this.pending = null; this.ready = false; this.epoch++; };
  receive = (response: unknown, defaultAction: string): Promise<void> => {
    const tap = parseNotificationTap(response, defaultAction);
    if (!tap || this.seen.has(tap.key)) return Promise.resolve();
    this.seen.add(tap.key);
    const pending: Pending = { tap, user: this.session.session?.user.id ?? null, claimed: false };
    this.pending = pending;
    this.epoch++;
    // Claim before navigating, with serialized writes. A stale native last
    // response cannot reopen content after restart or after an account switch.
    const work = this.storage.then(async () => {
      try {
        if (!this.handled) {
          const keys = await this.deps.loadHandled();
          if (keys !== null && (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || key.length > 300))) throw new Error('Invalid tap journal');
          this.handled = new Set(keys ?? []);
        }
        if (this.handled.has(tap.key)) { if (this.pending === pending) this.pending = null; return; }
        this.handled.add(tap.key);
        await this.deps.saveHandled([...this.handled]);
        pending.claimed = true;
        this.pump();
      } catch {
        if (this.pending === pending) {
          this.pending = null;
          this.publish('Unable to safely open this notification. Open Today from Home.');
        }
      }
    });
    this.storage = work;
    return work;
  };
  private pump() {
    const pending = this.pending, session = this.session.session;
    if (this.running || !pending?.claimed || !this.ready || !this.foreground || this.session.status !== 'ready'
      || !session || pending.user !== session.user.id) return;
    const operation = {}, epoch = this.epoch;
    this.running = operation;
    const current = () => this.pending === pending && this.epoch === epoch && this.ready && this.foreground
      && this.session.status === 'ready' && this.session.session === session;
    void (async () => {
      let destination: TapDestination = '/home', unavailable = false;
      try {
        const target = pending.tap.target;
        if (target.kind === 'infrastructure') {
          destination = '/diagnostics';
        } else if (target.kind === 'today') {
          this.validateToday(await this.deps.readToday(session), session);
          destination = '/today';
        } else {
          const habit = await this.deps.readHabit(session, target.habit);
          if (!current()) return;
          if (habit.id !== target.habit || habit.owner_id !== session.user.id) throw new Error('Not owned');
          const today = await this.deps.readToday(session);
          if (!current()) return;
          this.validateToday(today, session);
          if (!habit.archived_at && today.occurrences.some(row => row.id === target.occurrence && row.habit_id === habit.id && row.local_date === today.local_date)) {
            destination = '/today';
          } else {
            const history = await this.deps.readHabitHistory(session, habit.id);
            if (!current()) return;
            if (history.habit_id !== habit.id || !Array.isArray(history.occurrences)
              || history.occurrences.some(row => row.habit_id !== habit.id || row.owner_id !== session.user.id)) throw new Error('Invalid history');
            destination = { pathname: '/habit-history', params: { id: habit.id } };
          }
        }
      } catch { unavailable = true; }
      if (!current()) return;
      this.pending = null;
      this.publish(unavailable ? 'This notification is no longer available to this account. Open Today or My habits from Home.' : null);
      this.deps.navigate(destination);
    })().finally(() => {
      if (this.running === operation) this.running = null;
      this.pump();
    });
  }
  private validateToday(today: TodayResult, session: Session) {
    if (!today || !isTimestamp(today.server_time) || !Array.isArray(today.occurrences)
      || today.occurrences.some(row => row.owner_id !== session.user.id || row.local_date !== today.local_date)) throw new Error('Invalid Today');
  }
}

/** Install first, then synchronously capture cold-start response before logout
 * cleanup can clear it. Foreground banners and background taps use one handler.
 */
export function listenNotificationTaps(native: {
  DEFAULT_ACTION_IDENTIFIER: string;
  addNotificationResponseReceivedListener(listener: (response: unknown) => void): { remove(): void };
  getLastNotificationResponse(): unknown;
}, taps: NotificationTaps) {
  let received = false;
  const subscription = native.addNotificationResponseReceivedListener(response => {
    received = true; void taps.receive(response, native.DEFAULT_ACTION_IDENTIFIER);
  });
  try {
    const response = native.getLastNotificationResponse();
    if (!received && response) void taps.receive(response, native.DEFAULT_ACTION_IDENTIFIER);
  } catch { /* Native responses are unavailable on web; ordinary navigation works. */ }
  return () => subscription.remove();
}
