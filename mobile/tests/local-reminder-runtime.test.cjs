const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { compile, session, fullProfile, flush, deferred, alice, bob } = require('./sharing-test-support.cjs');
const { LocalReminderService } = compile('lib/local-reminder-service.ts', () => ({}));

function runtime(platform = 'android', supported = true) {
  const calls = [], timers = new Map();
  let launchListener, foregroundListener, timerId = 0, stored = null;
  const channel = { importance: 3 };
  const notifications = {
    AndroidImportance: { DEFAULT: 3, NONE: 0 }, AndroidNotificationVisibility: { PRIVATE: 0 },
    setNotificationChannelAsync: async id => { calls.push(['channel', id]); },
    getNotificationChannelAsync: async id => { calls.push(['read-channel', id]); return channel; },
    getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
    requestPermissionsAsync: async () => { calls.push(['permission-prompt']); return { granted: true }; },
  };
  const native = {
    launchMetadata: async () => ({ type: 'local_habit_reminder', owner_id: alice, target: 'today', lease: 'lease', sequence: 1 }),
    addListener: (name, listener) => { assert.equal(name, 'onLaunch'); launchListener = listener; return { remove: () => { launchListener = null; } }; },
  };
  const AppState = { currentState: 'active', addEventListener: (name, listener) => {
    assert.equal(name, 'change'); foregroundListener = listener;
    return { remove: () => { foregroundListener = null; } };
  } };
  class Service {
    constructor(deps) { this.deps = deps; }
    refresh = async () => { calls.push(['refresh']); };
  }
  const modules = {
    '@react-native-async-storage/async-storage': { __esModule: true, default: {
      getItem: async () => stored, setItem: async (_, owner) => { stored = owner; }, removeItem: async () => { stored = null; },
    } },
    'expo-notifications': notifications,
    'react-native': { AppState, Platform: { OS: platform } },
    './api': { readLocalReminderPlan: async () => assert.fail('Listener setup must not call HTTP directly') },
    './local-reminders': { localReminders: supported ? native : null },
    './local-reminder-service': { LocalReminderService: Service },
    './notification-tap-runtime': { notificationTaps: { receiveLocal: async metadata => { calls.push(['tap', metadata]); } } },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../lib/local-reminder-runtime.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Error, require: name => { assert(name in modules, name); return modules[name]; },
    setInterval: (fn, ms) => { assert.equal(ms, 60_000); timers.set(++timerId, fn); return timerId; },
    clearInterval: id => timers.delete(id),
  });
  return { ...exports, calls, channel, notifications, native, AppState, timers,
    launch: () => launchListener(), foreground: state => { AppState.currentState = state; foregroundListener(state); },
    listeners: () => [launchListener, foregroundListener], poll: () => { for (const fn of timers.values()) fn(); } };
}

test('local runtime routes cold and warm metadata through the validated tap handler and removes all listeners', async () => {
  const x = runtime(), stop = x.startLocalReminderListeners();
  await flush(); assert.equal(x.calls.filter(call => call[0] === 'tap').length, 1);
  x.launch(); await flush(); assert.equal(x.calls.filter(call => call[0] === 'tap').length, 2);
  x.foreground('background'); x.poll(); assert.equal(x.calls.filter(call => call[0] === 'refresh').length, 0);
  x.foreground('active'); x.poll(); assert.equal(x.calls.filter(call => call[0] === 'refresh').length, 2);
  stop(); assert.deepEqual(x.listeners(), [null, null]); assert.equal(x.timers.size, 0);
});

test('a cold native metadata read resolving after listener cleanup never enters navigation', async () => {
  const x = runtime(), pending = deferred(); x.native.launchMetadata = () => pending.promise;
  const stop = x.startLocalReminderListeners(); stop();
  pending.resolve({ type: 'local_habit_reminder', target: 'today', owner_id: alice });
  await flush(); assert.equal(x.calls.filter(call => call[0] === 'tap').length, 0);
});

test('local notification permission prepares its own channel and requests only when allowed', async () => {
  const x = runtime();
  x.notifications.getPermissionsAsync = async () => ({ granted: false, canAskAgain: true });
  assert.equal(await x.localReminderPermission(true), true);
  assert.deepEqual(x.calls.map(call => call[0]), ['channel', 'permission-prompt', 'read-channel']);
  assert.equal(x.calls[0][1], 'local-habit-reminders');
  x.calls.length = 0;
  x.notifications.getPermissionsAsync = async () => ({ granted: false, canAskAgain: false });
  assert.equal(await x.localReminderPermission(true), false);
  assert.ok(!x.calls.some(call => call[0] === 'permission-prompt'));
  x.notifications.getPermissionsAsync = async () => ({ granted: true }); x.channel.importance = 0;
  assert.equal(await x.localReminderPermission(false), false);
  assert.equal(await runtime('ios').localReminderPermission(true), false);
  assert.equal(await runtime('android', false).localReminderPermission(true), false);
});

test('runtime preference recovery persists account opt-in and removes it on explicit disable', async () => {
  const x = runtime(), deps = x.localReminderService.deps;
  assert.equal(await deps.loadEnabled(), null);
  await deps.saveEnabled(alice); assert.equal(await deps.loadEnabled(), alice);
  await deps.saveEnabled(null); assert.equal(await deps.loadEnabled(), null);
});

const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props.children)];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : tree && typeof tree === 'object' ? text(tree.props.children) : '';

test('Settings local controls expose permission, failure, last sync and actionable scheduling controls', async () => {
  const calls = [], state = { status: 'error', enabled: true, busy: false, permission: 'denied',
    message: 'Scheduling needs repair. Retry reminders.', lastSuccess: '2026-10-21T12:00:00Z' };
  const service = { snapshot: () => state, subscribe() {}, enable: async () => calls.push('enable'),
    refresh: async () => calls.push('refresh'), disable: async () => calls.push('disable') };
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
  const controls = compile('components/local-reminder-controls.tsx', name => ({
    react: { useSyncExternalStore: (_, snapshot) => snapshot() }, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Text: 'Text', View: 'View', Button: 'Button' },
    '../lib/local-reminder-runtime': { localReminderService: service },
  })[name]);
  const tree = controls.LocalReminderControls(), content = text(tree);
  assert.match(content, /Notification permission: Blocked/); assert.match(content, /Scheduling needs repair/);
  assert.match(content, /Last successful schedule sync: 2026-10-21T12:00:00Z/);
  assert.match(content, /Another device.*offline notifications/); assert.match(content, /permission denial does not block habit tracking/);
  const buttons = new Map(nodes(tree).filter(node => node.type === 'Button').map(node => [node.props.title, node.props]));
  assert.equal(buttons.get('Enable habit reminders').disabled, true);
  assert.equal(buttons.get('Retry / resync reminders').disabled, false);
  assert.equal(buttons.get('Disable habit reminders').disabled, false);
  buttons.get('Retry / resync reminders').onPress(); buttons.get('Disable habit reminders').onPress();
  state.enabled = false; state.status = 'off'; state.permission = 'unknown';
  const enabled = nodes(controls.LocalReminderControls()).find(node => node.props.title === 'Enable habit reminders');
  assert.equal(enabled.props.disabled, false); enabled.props.onPress();
  assert.deepEqual(calls, ['refresh', 'disable', 'enable']);
  state.busy = true;
  assert.equal(nodes(controls.LocalReminderControls()).find(node => node.props.title === 'Retry / resync reminders').props.disabled, true);
});

function coordinator(options = {}) {
  const calls = [], saved = options.storage ?? { owner: options.owner ?? alice }, current = session();
  const nativeState = options.nativeState ?? { cancelled: false };
  const native = {
    acquire: async owner => { calls.push(['acquire', owner]); nativeState.cancelled = false; return 'lease'; },
    cancelAll: async () => { calls.push(['cancel']); if (options.cancelStatus) return { status: options.cancelStatus };
      nativeState.cancelled = true; return { status: 'cancelled' }; },
    status: async () => ({ status: nativeState.cancelled ? 'cancelled' : 'scheduled_os_limited' }),
    clock: async () => 1,
    reconcile: async () => { calls.push(['reconcile']); return { status: 'idle' }; },
    suppress: async (...args) => { calls.push(['suppress', ...args]); return { status: 'idle' }; },
  };
  const service = new LocalReminderService({ native, loadEnabled: async () => {
    if (options.loadError) throw new Error('Preference storage unavailable'); return saved.owner;
  },
    saveEnabled: async owner => { if (options.saveError) throw new Error('Preference write failed'); saved.owner = owner; }, permission: async () => true,
    readPlan: async s => ({ version: 1, owner_id: s.user.id, server_time: '2026-10-21T12:00:00Z',
      timezone: 'UTC', local_date: '2026-10-21', effective: [], future: [] }),
  });
  const state = (status, s = current) => ({ status, session: s, profile: status === 'ready' ? fullProfile(s.user.id) : null, error: null });
  return { service, native, nativeState, saved, calls, current, state };
}

test('deletion cancellation queued behind native work cannot cancel B reminders after ownership changes', async () => {
  const x = coordinator(), native = deferred(); let current = true;
  await x.service.setSession(x.state('ready'));
  x.native.suppress = () => native.promise;
  const suppress = x.service.changed(x.current, { habitId: 'habit' }); await flush();
  const cleanup = x.service.beforeAccountDeletion(() => current);
  current = false;
  // The queued delete must neither cancel native state nor clear its preference.
  x.saved.owner = bob;
  const cancellations = x.calls.filter(([name]) => name === 'cancel').length;
  native.resolve({ status: 'idle' }); await Promise.all([suppress, cleanup]);
  assert.equal(x.saved.owner, bob);
  assert.equal(x.calls.filter(([name]) => name === 'cancel').length, cancellations);
});

test('initial authenticated profile loading preserves same-account preference and waits for ready before reconciling', async () => {
  const x = coordinator();
  await x.service.setSession(x.state('loading'));
  assert.equal(x.saved.owner, alice); assert.deepEqual(x.calls, []);
  await x.service.setSession(x.state('ready'));
  assert.equal(x.saved.owner, alice); assert.equal(x.service.snapshot().enabled, true);
  assert.ok(x.calls.some(call => call[0] === 'reconcile'));
});

test('foreground and polling refreshes during startup/profile hydration cannot cancel persisted same-account reminders', async () => {
  const x = coordinator();
  await x.service.refresh();
  assert.equal(x.nativeState.cancelled, false);
  await x.service.setSession(x.state('loading'));
  await x.service.refresh();
  assert.equal(x.nativeState.cancelled, false);
  assert.equal(x.saved.owner, alice);
  await x.service.setSession(x.state('ready'));
  assert.equal(x.service.snapshot().enabled, true);
  assert.equal(x.service.snapshot().status, 'scheduled');
});

test('initial loading for a different account cancels persisted local work before profile readiness', async () => {
  const x = coordinator();
  await x.service.setSession(x.state('loading', session(bob)));
  assert.equal(x.saved.owner, null); assert.deepEqual(x.calls, [['cancel']]);
});

test('signed-out or failed authentication after profile hydration cancels persisted same-account work', async () => {
  for (const status of ['signed_out', 'failure', 'profile_required']) {
    const x = coordinator();
    await x.service.setSession(x.state('loading'));
    await x.service.setSession(x.state(status, status === 'signed_out' ? null : x.current));
    assert.equal(x.nativeState.cancelled, true);
    assert.equal(x.saved.owner, null);
    assert.equal(x.service.snapshot().enabled, false);
  }
});

test('account-deletion hook confirms native cleanup and rejects when cancellation is unconfirmed', async () => {
  const x = coordinator(); await x.service.setSession(x.state('ready'));
  await x.service.beforeAccountDeletion();
  assert.equal(x.saved.owner, null); assert.equal(x.service.snapshot().status, 'off');
  const failed = coordinator({ cancelStatus: 'repair_required' });
  await failed.service.setSession(failed.state('ready'));
  await assert.rejects(failed.service.beforeAccountDeletion(), /Retry local reminder cleanup/);
  assert.equal(failed.service.snapshot().status, 'error');
});


test('preference hydration failure cancels unknown persisted native ownership before reporting failure', async () => {
  for (const status of ['loading', 'ready']) {
    const x = coordinator({ loadError: true });
    await x.service.setSession(x.state(status, session(bob)));
    assert.equal(x.nativeState.cancelled, true);
    assert.equal(x.service.snapshot().status, 'error');
    assert.ok(!x.calls.some(call => call[0] === 'acquire' || call[0] === 'reconcile'));
  }
});

test('failed preference removal cannot resurrect a durably cancelled schedule on process restart', async () => {
  const x = coordinator({ saveError: true });
  await x.service.setSession(x.state('ready'));
  await x.service.disable();
  assert.equal(x.nativeState.cancelled, true);
  assert.equal(x.saved.owner, alice);
  assert.equal(x.service.snapshot().status, 'error');
  const restarted = coordinator({ nativeState: x.nativeState, storage: x.saved });
  await restarted.service.setSession(restarted.state('loading'));
  await restarted.service.setSession(restarted.state('ready'));
  assert.equal(restarted.saved.owner, null);
  assert.equal(restarted.service.snapshot().enabled, false);
  assert.ok(!restarted.calls.some(call => call[0] === 'acquire' || call[0] === 'reconcile'));
});

test('same-account token renewal preserves confirmed mutation suppression but a later account epoch rejects it', async () => {
  const x = coordinator();
  await x.service.setSession(x.state('ready'));
  const renewed = session(alice, 'new-token');
  await x.service.setSession(x.state('ready', renewed));
  await x.service.changed(x.current, { habitId: 'dddddddd-4444-4444-8444-444444444444', localDate: '2026-10-21' });
  assert.equal(x.calls.filter(call => call[0] === 'suppress').length, 1);
  await x.service.setSession(x.state('ready', session(bob)));
  await x.service.setSession(x.state('ready', session(alice, 'third-token')));
  await x.service.enable();
  await x.service.changed(x.current, { habitId: 'dddddddd-4444-4444-8444-444444444444', localDate: '2026-10-21' });
  assert.equal(x.calls.filter(call => call[0] === 'suppress').length, 1);
});

test('SessionProvider fences remote sign-out immediately while local cleanup is pending', async () => {
  const cleanup = deferred(), remoteCalls = [];
  let lifecycle;
  const jsx = (_type, props) => props;
  const modules = {
    react: { createContext: () => ({ Provider: 'Provider' }), useContext() {}, useEffect() {},
      useState: factory => [factory(), () => {}], useSyncExternalStore() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { View: 'View' },
    './api': {}, './supabase': { supabase: { auth: {} } },
    './session-store': { SessionStore: class { constructor(_auth, _api, notifications) { lifecycle = notifications; } } },
    './notification-runtime': { notificationService: { setSession: async s => remoteCalls.push(s?.user.id ?? null) } },
    './local-reminder-runtime': { localReminderService: { disable: () => cleanup.promise } },
    'expo-notifications': {}, './notification-tap-runtime': {}, './notification-taps': {}, './reminder-runtime': {},
    '../components/notification-controls': { NotificationCleanupNotice: () => null },
  };
  const { SessionProvider } = compile('lib/session.tsx', name => { assert(name in modules, name); return modules[name]; });
  SessionProvider({ children: null });
  const signingOut = lifecycle.setSession(null, session());
  await lifecycle.setSession(session(bob));
  assert.deepEqual(remoteCalls, [null, bob]);
  cleanup.resolve(); await signingOut;
  assert.deepEqual(remoteCalls, [null, bob]);
});
