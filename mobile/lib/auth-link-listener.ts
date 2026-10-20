import type { SessionStore } from './session-store';
import type { AuthLinks } from './auth-links';
type Linking = { getInitialURL(): Promise<string | null>; addEventListener(type: 'url', fn: (event: { url: string }) => void): { remove(): void } };
/** Subscribe before reading the initial URL; a newer warm URL always wins. */
export function listenAuthLinks(linking: Linking, sessions: Pick<SessionStore, 'snapshot' | 'subscribe'>, links: AuthLinks) {
  let active = true, received = false, sequence = 0;
  const waits = new Set<() => void>();
  async function open(url: string) {
    const operation = ++sequence;
    if (sessions.snapshot().status === 'startup') await new Promise<void>(resolve => {
      const done = () => { unsubscribe(); waits.delete(done); resolve(); };
      const unsubscribe = sessions.subscribe(() => { if (sessions.snapshot().status !== 'startup') done(); });
      waits.add(done);
    });
    if (active && operation === sequence) await links.open(url);
  }
  const subscription = linking.addEventListener('url', ({ url }) => { received = true; void open(url); });
  const ready = linking.getInitialURL().then(async url => { if (active && !received && url) await open(url); }).catch(() => {});
  return { ready, stop() { active = false; sequence++; subscription.remove(); waits.forEach(done => done()); links.cancel(); } };
}
