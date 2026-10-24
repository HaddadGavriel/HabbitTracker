const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, session, fullProfile, deferred, flush } = require('./sharing-test-support.cjs');
const { AccountDeletionStore } = compile('lib/account-deletion-store.ts', () => ({}));
const { SessionStore } = compile('lib/session-store.ts', () => ({ ApiError: class extends Error {} }));
let random = 10;
const receiptKey = 'account-deletion-receipt-v1';
const phrase = 'DELETE MY ACCOUNT';
const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];

// Only platform/Auth/HTTP boundaries and React scheduling are mocked. The gate,
// receipt store, runtime and SessionStore are the production implementations.
async function device({ disk = new Map(), owner = 'a', api = {}, storage = {}, notifications } = {}) {
  const calls = [], effects = [], hooks = [];
  let authSession = owner ? session(owner) : null, authEvent, hook = 0, store;
  const auth = {
    getSession: async () => ({ data: { session: authSession }, error: null }),
    onAuthStateChange: callback => { authEvent = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async options => {
      assert.equal(options.scope, 'local'); calls.push(['signout', authSession?.user.id]);
      authSession = null; authEvent('SIGNED_OUT', null); return { error: null };
    },
  };
  const sessions = new SessionStore(auth, { readProfile: async s => fullProfile(s.user.id) }, notifications);
  await sessions.start();
  const record = name => async () => { calls.push([name]); };
  const services = {
    notificationService: { forgetDeletedAccount: record('registrations') },
    localReminderService: { beforeAccountDeletion: record('native') },
    reminderService: { clearForAccountDeletion: record('operations') },
    notificationTaps: { clearForAccountDeletion: record('handled-taps') },
  };
  const endpoints = {
    beginAccountDeletion: async () => ({ state: 'pending' }),
    recoverAccountDeletion: async () => ({ state: 'not_found' }), ...api,
  };
  const runtimeModules = {
    '@react-native-async-storage/async-storage': { __esModule: true, default: {
      getItem: async key => disk.get(key) ?? null,
      setItem: async (key, value) => { disk.set(key, value); },
      removeItem: async key => { disk.delete(key); },
      getAllKeys: async () => [...disk.keys()],
      multiRemove: async keys => { calls.push(['remove', ...keys]); keys.forEach(key => disk.delete(key)); }, ...storage,
    } },
    'expo-crypto': { getRandomBytes: () => new Uint8Array(32).fill(++random) },
    'expo-notifications': { cancelAllScheduledNotificationsAsync: record('scheduled'), dismissAllNotificationsAsync: record('presented'),
      clearLastNotificationResponseAsync: record('last-tap'), setBadgeCountAsync: record('badge') },
    './account-deletion-store': { AccountDeletionStore },
    './api': {
      beginAccountDeletion: (...args) => { calls.push(['begin', args[0].user.id, args[2]]); return endpoints.beginAccountDeletion(...args); },
      recoverAccountDeletion: receipt => { calls.push(['recover', receipt]); return endpoints.recoverAccountDeletion(receipt); },
    },
    './supabase': { supabase: { auth } },
    './notification-runtime': services, './local-reminder-runtime': services,
    './reminder-runtime': services, './notification-tap-runtime': services,
  };
  const runtime = compile('lib/account-deletion-runtime.ts', name => { assert.ok(runtimeModules[name], name); return runtimeModules[name]; });
  const gateModules = {
    react: {
      createContext: () => ({ Provider: ({ value, children }) => { store = value; return children; } }),
      useContext: () => store,
      useState: init => { const index = hook++; if (!(index in hooks)) hooks[index] = init(); return [hooks[index]]; },
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      useEffect: fn => { const index = hook++; if (!(index in hooks)) { hooks[index] = true; effects.push(fn); } },
    },
    ...require('./native-ui-support.cjs'),
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Button: 'Button', Text: 'Text', View: 'View' },
    './form': { Form: 'Form', Message: 'Message', styles: {} },
    '../lib/account-deletion-store': { AccountDeletionStore },
    '../lib/account-deletion-runtime': runtime,
    '../lib/session': { useSession: () => ({ ...sessions.snapshot(), store: sessions }) },
  };
  const { AccountDeletionGate } = compile('components/account-deletion-gate.tsx', name => { assert.ok(gateModules[name], name); return gateModules[name]; });
  const render = () => { hook = 0; return nodes(AccountDeletionGate({ children: jsx('App', {}) })); };
  render(); const stopEffects = effects.map(effect => effect()); await flush();
  return {
    store, sessions, calls, disk, auth, endpoints, services, render,
    saved: () => { const value = disk.get(receiptKey); return value ? JSON.parse(value).entries ?? [JSON.parse(value)] : []; },
    app: () => render().some(node => node.type === 'App'),
    hasButton: title => render().some(node => node.type === 'Button' && node.props.title === title),
    press: async title => {
      const button = render().find(node => node.type === 'Button' && node.props.title === title);
      assert.ok(button, title); assert.ok(!button.props.disabled, title); await button.props.onPress(); await flush();
    },
    switchTo: async owner => { authSession = owner ? session(owner) : null; authEvent(owner ? 'SIGNED_IN' : 'SIGNED_OUT', authSession); await flush(); },
    stop: () => { stopEffects.forEach(stop => stop?.()); sessions.stop(); },
  };
}
const cleanupCalls = x => x.calls.filter(([name]) => !['begin', 'recover'].includes(name));

test('A completes durable cleanup, then B can delete using the same runtime and gate', async () => {
  const x = await device({ api: { beginAccountDeletion: async () => ({ state: 'complete' }) } });
  await x.store.begin('password', phrase, 'a');
  assert.equal(x.store.snapshot().phase, 'complete'); assert.equal(x.saved().length, 0);
  assert.equal(x.app(), false); await x.press('Continue to app'); assert.equal(x.app(), true);
  await x.switchTo('b'); await x.store.begin('password', phrase, 'b');
  assert.equal(x.store.snapshot().phase, 'complete'); assert.equal(x.saved().length, 0);
  assert.deepEqual(x.calls.filter(([name]) => name === 'begin').map(([, id]) => id), ['a', 'b']);
  const requests = x.calls.filter(([name]) => name === 'begin'); assert.notEqual(requests[0][2], requests[1][2]);
  assert.deepEqual(x.calls.filter(([name]) => name === 'signout').map(([, id]) => id), ['a', 'b']);
});

for (const restart of [false, true]) test(`wrong password then not_found keeps A recoverable without blocking B (restart=${restart})`, async () => {
  const disk = new Map();
  const x = await device({ disk, api: { beginAccountDeletion: async () => { throw Error('private password/token'); } } });
  await x.store.begin('wrong', phrase, 'a');
  assert.equal(x.store.snapshot().phase, 'error'); assert.equal(x.hasButton('Continue to app'), false);
  assert.doesNotMatch(x.store.snapshot().message, /private password\/token/);
  await x.press('Check and retry deletion'); assert.equal(x.store.snapshot().phase, 'not_found');
  const a = x.saved()[0]; await x.press('Continue to app'); assert.equal(x.app(), true);
  await x.switchTo('b'); assert.equal(x.app(), true); assert.deepEqual(x.saved(), [a]);
  if (restart) x.stop();
  const y = restart ? await device({ disk, owner: 'b' }) : x;
  y.endpoints.beginAccountDeletion = async () => ({ state: 'pending' });
  assert.equal(y.app(), true); assert.deepEqual(y.saved(), [a]); assert.equal(cleanupCalls(y).length, 0);
  await y.store.begin('b-password', phrase, 'b');
  assert.equal(y.calls.filter(([name, owner]) => name === 'begin' && owner === 'b').length, 1);
  assert.equal(y.saved().length, 2); assert.deepEqual(y.saved()[0], a);
  assert.notEqual(y.saved()[1].receipt, a.receipt);
  assert.equal(y.saved()[1].owner, 'b');
});

test('independent in-flight A and B requests retain both receipts and cannot overwrite each other on completion', async () => {
  const a = deferred(), b = deferred();
  const x = await device({ api: { beginAccountDeletion: s => s.user.id === 'a' ? a.promise : b.promise } });
  const first = x.store.begin('password', phrase, 'a'); await flush();
  await x.switchTo('b'); const second = x.store.begin('password', phrase, 'b'); await flush();
  assert.equal(x.saved().length, 2);
  const original = x.saved(); assert.notEqual(original[0].receipt, original[1].receipt);
  a.resolve({ state: 'complete' }); await first;
  assert.equal(x.store.snapshot().owner, 'b'); assert.equal(x.store.snapshot().phase, 'checking');
  assert.equal(cleanupCalls(x).length, 0); assert.deepEqual(x.saved(), original);
  b.resolve({ state: 'complete' }); await second;
  assert.deepEqual(x.saved(), [original[0]]); assert.equal(x.store.snapshot().phase, 'complete');
  // Delayed completion is still recoverable after B's receipt has been removed.
  x.endpoints.recoverAccountDeletion = async () => ({ state: 'complete' });
  await x.press('Continue to app'); await x.press('Check saved deletion 1');
  assert.equal(x.store.snapshot().phase, 'complete'); assert.equal(x.saved().length, 0);
});

for (const endpoint of ['begin', 'recover']) test(`delayed A ${endpoint} completion leaves B signed in, preserves B state and permits navigation/restart`, async () => {
  const delayed = deferred(), disk = new Map([['friend-reminders-v1:a:habit', 'a-private'], ['friend-reminders-v1:b:habit', 'b-private'], ['unrelated', 'keep']]);
  const x = await device({ disk, api: { beginAccountDeletion: async () => {
    if (endpoint === 'begin') return delayed.promise;
    throw Error('response lost');
  } } });
  let work = x.store.begin('password', phrase, 'a'); await flush();
  if (endpoint === 'recover') {
    await work; x.endpoints.recoverAccountDeletion = () => delayed.promise;
    work = x.store.recover(); await flush();
  }
  const saved = x.saved()[0]; await x.switchTo('b'); assert.equal(x.app(), true);
  delayed.resolve({ state: 'complete' }); await work; await flush();
  assert.equal(x.app(), true); assert.equal(x.sessions.snapshot().session.user.id, 'b');
  assert.equal(cleanupCalls(x).length, 0); assert.deepEqual(x.saved(), [saved]);
  assert.equal(disk.get('friend-reminders-v1:b:habit'), 'b-private');
  x.endpoints.recoverAccountDeletion = async () => ({ state: 'complete' });
  await x.press('Check saved deletion 1'); assert.equal(x.store.snapshot().phase, 'cleanup_pending');
  await x.press('Continue to app'); assert.equal(x.app(), true);
  x.stop();
  const y = await device({ disk, owner: 'b', api: { recoverAccountDeletion: async () => ({ state: 'complete' }) } });
  assert.equal(y.app(), true); assert.equal(cleanupCalls(y).length, 0); assert.deepEqual(y.saved(), [saved]);
  // An ordinary signout makes deferred cleanup safe. Only A's private keys go.
  await y.switchTo(null);
  assert.equal(y.saved().length, 0); assert.equal(disk.has('friend-reminders-v1:a:habit'), false);
  assert.equal(disk.get('friend-reminders-v1:b:habit'), 'b-private'); assert.equal(disk.get('unrelated'), 'keep');
  assert.equal(y.calls.some(([name]) => name === 'signout'), false);
});

test('legacy receipt survives restart/migration while a second account starts deletion', async () => {
  const a = { owner: 'a', receipt: 'a'.repeat(64) }, disk = new Map([[receiptKey, JSON.stringify(a)]]);
  const x = await device({ disk, owner: 'b' }); assert.equal(x.app(), true);
  await x.store.begin('password', phrase, 'b');
  assert.equal(JSON.parse(disk.get(receiptKey)).version, 2); assert.deepEqual(x.saved()[0], a);
  x.stop(); const y = await device({ disk, owner: 'b' });
  assert.equal(y.store.snapshot().owner, 'b'); assert.equal(y.store.snapshot().phase, 'not_found');
  assert.equal(y.saved().length, 2);
});

test('completed receipt is retained through native and durable removal failures; retries unlock B', async () => {
  let failRemove = true;
  const disk = new Map(), x = await device({ disk, storage: { removeItem: async key => { if (failRemove) throw Error('disk'); disk.delete(key); } },
    api: { beginAccountDeletion: async () => ({ state: 'complete' }), recoverAccountDeletion: async () => ({ state: 'complete' }) } });
  const cleanup = x.services.localReminderService.beforeAccountDeletion;
  x.services.localReminderService.beforeAccountDeletion = async () => { throw Error('native'); };
  await x.store.begin('password', phrase, 'a'); assert.equal(x.store.snapshot().phase, 'error'); assert.equal(x.saved().length, 1);
  x.services.localReminderService.beforeAccountDeletion = cleanup;
  await x.store.recover(); assert.equal(x.store.snapshot().phase, 'error'); assert.equal(x.saved().length, 1);
  assert.doesNotMatch(x.store.snapshot().message, /Account deleted/);
  failRemove = false; await x.store.recover();
  assert.equal(x.store.snapshot().phase, 'complete'); assert.equal(x.saved().length, 0);
  await x.switchTo('b'); await x.store.begin('password', phrase, 'b'); assert.equal(x.store.snapshot().phase, 'complete');
});

test('account switch during cleanup Auth read or a queued cleanup step fences every later side effect', async () => {
  for (const step of ['auth', 'handled-taps']) {
    const delayed = deferred(), x = await device({ api: { beginAccountDeletion: async () => ({ state: 'complete' }) } });
    if (step === 'auth') {
      let reads = 0;
      const getSession = x.auth.getSession;
      x.auth.getSession = () => ++reads === 1 ? getSession() : delayed.promise;
    } else x.services.notificationTaps.clearForAccountDeletion = () => delayed.promise;
    const work = x.store.begin('password', phrase, 'a'); await flush();
    const before = cleanupCalls(x).length;
    await x.switchTo('b'); delayed.resolve({ data: { session: session('a') } }); await work;
    assert.equal(cleanupCalls(x).length, before); assert.equal(x.sessions.snapshot().session.user.id, 'b');
    assert.equal(x.app(), true); assert.equal(x.saved().length, 1);
  }
});

test('B signing in during A sign-out preparation cancels the old sign-out and defers deletion cleanup', async () => {
  const waiting = deferred();
  const x = await device({ api: { beginAccountDeletion: async () => ({ state: 'complete' }) },
    notifications: { setSession: async (_session, cleanupSession) => { if (cleanupSession) await waiting.promise; } } });
  const work = x.store.begin('password', phrase, 'a'); await flush();
  assert.equal(x.sessions.snapshot().status, 'loading');
  await x.switchTo('b'); waiting.resolve(); await work;
  assert.equal(x.sessions.snapshot().session.user.id, 'b'); assert.equal(cleanupCalls(x).length, 0);
  assert.equal(x.app(), true); assert.equal(x.saved().length, 1);
});

test('stale confirmation/Auth identity cannot dispatch, and pending deletion never claims completion', async () => {
  const x = await device();
  await assert.rejects(x.store.begin('password', phrase, 'b'), /Account changed/);
  x.auth.getSession = async () => ({ data: { session: session('other') } });
  await x.store.begin('password', phrase, 'a');
  assert.equal(x.calls.some(([name]) => name === 'begin'), false); assert.equal(x.store.snapshot().phase, 'error');
  const y = await device(); await y.store.begin('password', phrase, 'a');
  assert.equal(y.store.snapshot().phase, 'pending'); assert.equal(y.saved().length, 1);
  assert.doesNotMatch(y.store.snapshot().message, /Account deleted/);
  for (const name of ['signout', 'operations', 'native', 'registrations', 'scheduled', 'presented', 'last-tap', 'badge']) {
    assert.ok(y.calls.some(([call]) => call === name), name);
  }
});
