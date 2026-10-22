const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, deferred, flush, session, fullProfile } = require('./sharing-test-support.cjs');
const { NotificationService } = compile('lib/notification-service.ts', () => { throw Error('No runtime imports expected'); });
const { SessionStore } = compile('lib/session-store.ts', path => path === './api' ? { ApiError: class extends Error {} } : {});

let nextId = 0;
function setup(overrides = {}, saved = null) {
  const calls = [], tombstones = new Set(), rows = new Map();
  let journal = saved ? structuredClone(saved) : null, token = 'ExpoPushToken[first]';
  const deps = {
    load: async () => journal ? structuredClone(journal) : null,
    save: async value => { journal = structuredClone(value); calls.push(['save']); },
    newId: () => `intent-${++nextId}`,
    prepareChannels: async () => { calls.push(['channels']); },
    permission: async request => { calls.push(['permission', request]); return true; },
    getToken: async () => { calls.push(['token']); return token; },
    register: async (s, t, identity) => {
      calls.push(['register', s.user.id, t, identity, s.access_token]);
      assert(journal.registrations.some(entry => entry.registrationId === identity) || tombstones.has(`${s.user.id}/${identity}`));
      if (tombstones.has(`${s.user.id}/${identity}`)) throw Error('cancelled');
      rows.set(t, { userId: s.user.id, registrationId: identity });
    },
    unregister: async (s, identity) => {
      calls.push(['unregister', s.user.id, identity, s.access_token]);
      tombstones.add(`${s.user.id}/${identity}`);
      for (const [t, row] of rows) if (row.userId === s.user.id && row.registrationId === identity) rows.delete(t);
    },
    clearPresented: async () => { calls.push(['clear']); },
    ...overrides,
  };
  const service = new NotificationService(deps);
  return { service, calls, deps, rows, tombstones, journal: () => journal, setToken: t => { token = t; } };
}
const count = (x, name) => x.calls.filter(call => call[0] === name).length;
async function enabled(overrides) {
  const x = setup(overrides);
  await x.service.setSession(session('a'));
  assert.equal(count(x, 'permission'), 0);
  await x.service.enable();
  assert.equal(x.service.snapshot().status, 'enabled');
  return x;
}

test('explicit opt-in creates channels before permission/token and never exposes tokens', async () => {
  const x = await enabled();
  assert.deepEqual(x.calls.filter(call => ['channels', 'permission', 'token', 'register'].includes(call[0])).map(call => call[0]), ['channels', 'permission', 'token', 'register']);
  assert.equal(x.calls.find(call => call[0] === 'permission')[1], true);
  assert(!JSON.stringify(x.service.snapshot()).includes('ExpoPushToken'));
  assert(!JSON.stringify(x.journal()).includes('token'));
  await x.service.setSession(null);
  assert.equal(x.rows.size, 0);
  assert.equal(x.service.canPresent(), false);
});

test('simultaneous enable and foreground refreshes share registration work', async () => {
  const token = deferred(); const x = setup({ getToken: () => token.promise });
  await x.service.setSession(session('a'));
  const enable = x.service.enable(); await flush();
  const first = x.service.refresh(), second = x.service.refresh();
  assert.equal(first, second);
  token.resolve('ExpoPushToken[first]');
  await Promise.all([enable, first, second, x.service.enable()]);
  assert.equal(count(x, 'register'), 1);
});

test('token renewal cancels the old intent and registers a fresh Expo token', async () => {
  const x = await enabled();
  const first = x.journal().registrations[0].registrationId;
  x.setToken('ExpoPushToken[renewed]'); await x.service.tokenChanged();
  assert.equal(count(x, 'register'), 2);
  assert(x.tombstones.has(`a/${first}`));
  assert.equal(x.rows.has('ExpoPushToken[first]'), false);
  assert.equal(x.rows.get('ExpoPushToken[renewed]').userId, 'a');
  await x.service.refresh(true);
  assert.equal(count(x, 'register'), 3);
  await x.service.setSession(session('a', 'new-bearer'));
  assert.equal(count(x, 'register'), 4);
  assert.equal(x.calls.filter(call => call[0] === 'register').at(-1)[4], 'new-bearer');
});

test('denial does not fetch a token; foreground revocation unregisters and clears notifications', async () => {
  const denied = setup({ permission: async () => false });
  await denied.service.setSession(session('a')); await denied.service.enable();
  assert.equal(denied.service.snapshot().status, 'denied');
  assert.equal(count(denied, 'register'), 0); assert.equal(count(denied, 'token'), 0);
  const x = await enabled(); x.deps.permission = async () => false;
  await x.service.refresh();
  assert.equal(x.rows.size, 0); assert.equal(x.journal().enabledUser, null);
  assert.equal(x.service.snapshot().status, 'denied'); assert(count(x, 'clear') > 0);
});

test('revocation cleanup failure retains denial and warns honestly', async () => {
  const x = await enabled();
  x.deps.permission = async () => false; x.deps.unregister = async () => { throw Error('offline'); };
  await x.service.refresh();
  assert.equal(x.service.snapshot().status, 'denied');
  assert.equal(x.service.snapshot().cleanupPending, true);
  assert.equal(x.rows.size, 1); assert.equal(x.service.canPresent(), false);
});

test('logout during token acquisition never registers the previous account', async () => {
  const token = deferred(); const x = setup({ getToken: () => token.promise });
  await x.service.setSession(session('a'));
  const pending = x.service.enable(); await flush();
  const logout = x.service.setSession(null);
  assert.equal(x.service.canPresent(), false);
  token.resolve('ExpoPushToken[late]'); await Promise.all([pending, logout]);
  assert.equal(count(x, 'register'), 0);
  assert.equal(x.journal().registrations.length, 0);
});

test('logout during registration cleans the completed or ambiguous intent before switching', async () => {
  const response = deferred(); const x = setup(); const register = x.deps.register;
  x.deps.register = async (...args) => { await register(...args); await response.promise; };
  await x.service.setSession(session('a'));
  const enabling = x.service.enable(); await flush();
  const switching = x.service.setSession(session('b'));
  response.resolve(); await Promise.all([enabling, switching]);
  assert.equal(x.rows.size, 0); assert.equal(x.service.snapshot().status, 'off');
  await x.service.enable();
  assert.equal(x.rows.get('ExpoPushToken[first]').userId, 'b');
  assert.deepEqual(x.calls.filter(call => ['register', 'unregister'].includes(call[0])).map(call => call.slice(0, 2)), [['register', 'a'], ['unregister', 'a'], ['register', 'b']]);
});

test('offline logout persists only cleanup IDs, blocks another account and recovers with fresh credentials', async () => {
  const x = await enabled(); const unregister = x.deps.unregister;
  x.deps.unregister = async () => { throw Error('offline bearer-secret ExpoPushToken[secret]'); };
  await x.service.setSession(null);
  assert.equal(x.service.snapshot().status, 'signed_out');
  assert.equal(x.service.snapshot().cleanupPending, true); assert.equal(x.rows.size, 1);
  assert(!JSON.stringify(x.service.snapshot()).includes('secret'));
  assert.deepEqual(Object.keys(x.journal().registrations[0]), ['userId', 'registrationId']);
  await x.service.setSession(session('b')); await x.service.enable();
  assert.equal(count(x, 'register'), 1);
  x.deps.unregister = unregister;
  await x.service.setSession(session('a', 'fresh-bearer'));
  assert.equal(x.service.snapshot().cleanupPending, false);
  assert.equal(x.rows.size, 0);
  assert.equal(x.calls.filter(call => call[0] === 'unregister').at(-1)[3], 'fresh-bearer');
  await x.service.enable(); assert.equal(x.rows.size, 1);
});

test('restart repairs a lost registration response without storing bearer or Expo tokens', async () => {
  const x = setup({ register: async () => { throw Error('response lost'); } });
  await x.service.setSession(session('a')); await x.service.enable();
  assert.equal(x.service.snapshot().cleanupPending, true);
  const y = setup({}, x.journal());
  await y.service.setSession(session('a', 'new-login'));
  assert.equal(count(y, 'unregister'), 1);
  assert.equal(y.service.snapshot().cleanupPending, false);
  assert.equal(y.service.snapshot().status, 'enabled');
});

test('disable fences a failed registration and never re-enables on foreground', async () => {
  const x = await enabled(); await x.service.disable(); await x.service.refresh(true);
  assert.equal(x.rows.size, 0); assert.equal(count(x, 'register'), 1);
  assert.equal(x.service.snapshot().status, 'off');
});

test('storage failure prevents registration; visible notification clearing failure is reported', async () => {
  const x = setup({ save: async () => { throw Error('disk'); } });
  await x.service.setSession(session('a')); await x.service.enable();
  assert.equal(count(x, 'register'), 0);
  const y = await enabled(); y.deps.clearPresented = async () => { throw Error('native'); };
  await y.service.disable(); assert.equal(y.service.snapshot().clearFailed, true);
  assert.equal(y.rows.size, 0);
});

test('SessionStore waits for cleanup but still signs out locally when removal fails', async () => {
  const x = await enabled(); x.deps.unregister = async () => { throw Error('offline'); };
  let event, signouts = 0;
  const auth = { getSession: async () => ({ data: { session: session('a') } }),
    onAuthStateChange: callback => { event = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => { signouts++; return { error: null }; } };
  const store = new SessionStore(auth, { readProfile: async s => fullProfile(s.user.id) }, x.service);
  await store.start(); await store.signOut();
  assert.equal(signouts, 1); assert.equal(store.snapshot().status, 'signed_out');
  assert.equal(x.service.snapshot().cleanupPending, true);
  event('SIGNED_IN', session('a', 'relogin')); await flush();
  assert.equal(store.snapshot().session.user.id, 'a');
});

test('session refresh during logout cannot re-enable A, and a switch to B prevents delayed auth signout', async () => {
  const cleanup = deferred(), x = await enabled(); x.deps.unregister = () => cleanup.promise;
  let event, signouts = 0;
  const auth = { getSession: async () => ({ data: { session: session('a') } }),
    onAuthStateChange: callback => { event = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => { signouts++; return { error: null }; } };
  const store = new SessionStore(auth, { readProfile: async s => fullProfile(s.user.id) }, x.service);
  await store.start(); const logout = store.signOut(); await flush();
  event('TOKEN_REFRESHED', session('a', 'refreshed'));
  assert.equal(x.service.canPresent(), false);
  event('SIGNED_IN', session('b')); cleanup.resolve(); await logout; await flush();
  assert.equal(signouts, 0); assert.equal(store.snapshot().session.user.id, 'b');
});

test('A to B to A while token lookup is pending never uses the old A intent', async () => {
  const oldToken = deferred(), x = setup(); let reads = 0;
  x.deps.getToken = () => ++reads === 1 ? oldToken.promise : Promise.resolve('ExpoPushToken[current]');
  await x.service.setSession(session('a'));
  const pending = x.service.enable(); await flush();
  const b = x.service.setSession(session('b')), a = x.service.setSession(session('a', 'new-a'));
  oldToken.resolve('ExpoPushToken[stale]'); await Promise.all([pending, b, a]);
  assert.equal(count(x, 'register'), 0);
  await x.service.enable();
  assert.equal(x.calls.find(c => c[0] === 'register')[2], 'ExpoPushToken[current]');
  assert.equal(x.calls.find(c => c[0] === 'register')[4], 'new-a');
});

test('native token change invalidates an old Expo lookup before it can register', async () => {
  const oldToken = deferred(), x = setup(); let reads = 0;
  x.deps.getToken = () => ++reads === 1 ? oldToken.promise : Promise.resolve('ExpoPushToken[new]');
  await x.service.setSession(session('a'));
  const pending = x.service.enable(); await flush();
  const changed = x.service.tokenChanged(); oldToken.resolve('ExpoPushToken[old]');
  await Promise.all([pending, changed]);
  assert.equal(count(x, 'register'), 1);
  assert.equal(x.rows.has('ExpoPushToken[old]'), false);
  assert.equal(x.rows.has('ExpoPushToken[new]'), true);
});

test('disable after an uncertain POST fences a server request that arrives after new-account registration', async () => {
  const x = setup(); const apply = x.deps.register; let delayed;
  x.deps.register = async (...args) => { delayed = () => apply(...args); throw Error('response lost'); };
  await x.service.setSession(session('a')); await x.service.enable();
  // Preserve the server request independently of the now-settled client Promise.
  const oldRequest = delayed;
  await x.service.disable(); await x.service.setSession(session('b'));
  x.deps.register = apply; await x.service.enable();
  // The fake database uses the same cancellation fence as the PostgreSQL tests.
  await assert.rejects(oldRequest(), /cancelled/);
  assert(x.tombstones.size > 0);
  assert.equal(x.rows.get('ExpoPushToken[first]').userId, 'b');
});


test('an unreadable journal warns after local signout instead of assuming no remote registration', async () => {
  const x = setup({ load: async () => { throw Error('storage unreadable'); } });
  await x.service.setSession(null);
  assert.equal(x.service.snapshot().cleanupPending, true);
  assert.equal(x.service.snapshot().status, 'error');
  assert.equal(count(x, 'register'), 0);
});

test('confirmed deletion forgets registration journal despite unavailable remote cancellation, and reports local storage failure', async () => {
  const x=await enabled({unregister:async()=>{throw Error('Auth account removed');}});
  await x.service.forgetDeletedAccount();
  assert.equal(x.journal().registrations.length,0); assert.equal(x.journal().enabledUser,null);
  assert.equal(x.service.canPresent(),false);
  x.deps.save=async()=>{throw Error('storage');};
  await assert.rejects(x.service.forgetDeletedAccount(),/clear notification journal/);
});
