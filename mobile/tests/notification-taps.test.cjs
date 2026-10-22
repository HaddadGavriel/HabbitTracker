const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const cache = {};
function lib(name) {
  if (cache[name]) return cache[name];
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Error, process: { env: {} }, require: path => lib(path.slice(2)) });
  return cache[name] = exports;
}
const { NotificationTaps, parseNotificationTap, listenNotificationTaps } = lib('notification-taps');
const habit = 'aaaaaaaa-1111-4111-8111-111111111111';
const occurrence = 'bbbbbbbb-2222-4222-8222-222222222222';
const reminder = 'cccccccc-3333-4333-8333-333333333333';
const payload = () => ({ type: 'habit_reminder', habit_id: habit, occurrence_id: occurrence, reminder_id: reminder });
const response = (data = payload(), identifier = 'native-one', action = 'default') => ({ actionIdentifier: action,
  notification: { request: { identifier, content: { data } } } });
const session = (id = 'owner-a') => ({ user: { id }, access_token: `${id}-token` });
const state = (status = 'ready', id = 'owner-a') => ({ status, session: id ? session(id) : null, profile: status === 'ready' ? { user_id: id } : null });
const today = (owner = 'owner-a') => ({ server_time: '2026-10-20T10:00:00Z', local_date: '2026-10-20', timezone: 'UTC',
  occurrences: [{ id: occurrence, habit_id: habit, owner_id: owner, local_date: '2026-10-20' }] });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(overrides = {}, disk = { keys: null }) {
  const calls = [], navigation = [];
  const deps = {
    loadHandled: async () => disk.keys,
    saveHandled: async keys => { disk.keys = JSON.parse(JSON.stringify(keys)); },
    readToday: async s => { calls.push(['today', s.user.id]); return today(s.user.id); },
    readHabit: async (s, id) => { calls.push(['habit', s.user.id, id]); return { id, owner_id: s.user.id, archived_at: null }; },
    readHabitHistory: async (s, id) => { calls.push(['history', s.user.id, id]); return { habit_id: id, occurrences: [], next_cursor: null }; },
    navigate: destination => navigation.push(destination), ...overrides,
  };
  const taps = new NotificationTaps(deps);
  return { taps, deps, disk, calls, navigation, ready: () => { taps.setSession(state()); taps.setReady(true); },
    receive: value => taps.receive(value ?? response(), 'default') };
}

test('strict payload and action validation rejects malformed/partial IDs, unknown types and URL-only data', () => {
  for (const data of [null, [], 'text', {}, { url: '/edit-habit?id=private' }, { type: 'other', ...{ habit_id: habit } },
    { ...payload(), habit_id: '../private' }, { ...payload(), occurrence_id: ['id'] }, { ...payload(), reminder_id: null },
    { type: 'habit_reminder', habit_id: habit }, { type: 'habit_reminder', reminder_id: undefined, occurrence_id: '' }]) {
    assert.equal(parseNotificationTap(response(data), 'default'), null);
  }
  assert.equal(parseNotificationTap(response(payload(), 'id', 'dismiss'), 'default'), null);
  assert.equal(parseNotificationTap(response(payload(), ''), 'default'), null);
  assert.equal(parseNotificationTap({ notification: {} }, 'default'), null);
  const parsed = parseNotificationTap(response({ ...payload(), url: 'https://attacker.test', account_id: 'forged' }), 'default');
  assert.equal(parsed.target.kind, 'habit'); assert.equal(parsed.target.habit, habit);
  assert.equal(JSON.stringify(parsed).includes('attacker'), false);
});

test('cold start waits through sign-in, profile onboarding, auth recovery and root navigation readiness', async () => {
  const x = setup();
  await x.receive(); await flush(); assert.equal(x.calls.length, 0);
  x.taps.setSession(state('signed_out', null)); x.taps.setReady(true); await flush(); assert.equal(x.navigation.length, 0);
  x.taps.setSession(state('profile_required')); await flush(); assert.equal(x.calls.length, 0);
  x.taps.setReady(false); x.taps.setSession(state()); await flush(); assert.equal(x.calls.length, 0);
  x.taps.setReady(true); await flush();
  assert.deepEqual(x.calls.map(c => c[0]), ['habit', 'today']); assert.deepEqual(x.navigation, ['/today']);
});

test('foreground and background taps share the handler; background waits for active and generic payload fetches current Today', async () => {
  for (const background of [false, true]) {
    const x = setup(); x.ready(); x.taps.setForeground(!background);
    await x.receive(response({ type: 'habit_reminder', url: '/diagnostics' })); await flush();
    if (background) { assert.equal(x.calls.length, 0); x.taps.setForeground(true); await flush(); }
    assert.deepEqual(x.calls, [['today', 'owner-a']]); assert.deepEqual(x.navigation, ['/today']);
  }
});

for (const archived of [null, '2026-10-19T00:00:00Z']) test(`old or archived owned habit uses authorized history (${archived})`, async () => {
  const x = setup({ readHabit: async () => ({ id: habit, owner_id: 'owner-a', archived_at: archived }), readToday: async () => ({ ...today(), occurrences: [] }) });
  x.ready(); await x.receive(); await flush();
  assert.equal(x.calls[0][0], 'history');
  assert.equal(x.navigation[0].pathname, '/habit-history'); assert.equal(x.navigation[0].params.id, habit);
});

for (const failure of ['404', '401', 'wrong-owner', 'bad-today', 'bad-history', 'offline']) test(`${failure} falls back without opening payload-selected content`, async () => {
  const x = setup();
  if (['404', '401', 'offline'].includes(failure)) x.deps.readHabit = async () => { throw Error(failure); };
  if (failure === 'wrong-owner') x.deps.readHabit = async () => ({ id: habit, owner_id: 'someone-else' });
  if (failure === 'bad-today') x.deps.readToday = async () => today('someone-else');
  if (failure === 'bad-history') { x.deps.readToday = async () => ({ ...today(), occurrences: [] }); x.deps.readHabitHistory = async () => ({ habit_id: habit, occurrences: [{ habit_id: habit, owner_id: 'someone-else' }] }); }
  x.ready(); await x.receive(); await flush();
  assert.deepEqual(x.navigation, ['/home']); assert.match(x.taps.snapshot(), /no longer available/);
});

test('account change during an authorized read discards the tap permanently, even after switching back', async () => {
  const read = deferred(); const x = setup({ readHabit: () => read.promise }); x.ready();
  await x.receive(); await flush(); x.taps.setSession(state('ready', 'owner-b'));
  read.resolve({ id: habit, owner_id: 'owner-a' }); await flush(); assert.equal(x.navigation.length, 0);
  x.taps.setSession(state()); await x.receive(); await flush(); assert.equal(x.navigation.length, 0);
});

test('sign-out starts by leaving ready, even while old session credentials remain, and fences navigation', async () => {
  const read = deferred(); const x = setup({ readToday: () => read.promise }); x.ready();
  await x.receive(response({ type: 'habit_reminder' })); await flush();
  x.taps.setSession(state('loading')); read.resolve(today()); await flush();
  x.taps.setSession(state()); await flush(); assert.equal(x.navigation.length, 0);
});

test('account switch while onboarding drops the bound tap rather than carrying it into the new account', async () => {
  const x = setup(); x.taps.setSession(state('profile_required'));
  await x.receive(); x.taps.setSession(state('ready', 'owner-b')); x.taps.setReady(true); await flush();
  assert.equal(x.calls.length, 0); assert.equal(x.navigation.length, 0);
});

test('old notification received on a different signed-in account must pass that account ownership check', async () => {
  const x = setup({ readHabit: async () => ({ id: habit, owner_id: 'owner-a' }) });
  x.taps.setSession(state('ready', 'owner-b')); x.taps.setReady(true);
  await x.receive(); await flush(); assert.deepEqual(x.navigation, ['/home']);
});

test('native duplicate events and restart last-response replay are durably deduplicated across accounts', async () => {
  const x = setup(); x.ready(); await Promise.all([x.receive(), x.receive()]); await flush();
  await x.receive(response(payload(), 'another-native-id')); await flush(); assert.equal(x.navigation.length, 1);
  const restored = setup({}, x.disk); restored.ready(); await restored.receive(); await flush(); assert.equal(restored.calls.length, 0);
  restored.taps.setSession(state('ready', 'owner-b')); await restored.receive(); await flush(); assert.equal(restored.navigation.length, 0);
});

test('dedup storage must succeed before any content read or navigation', async () => {
  for (const deps of [{ loadHandled: async () => ({ bad: true }) }, { saveHandled: async () => { throw Error('storage'); } }]) {
    const x = setup(deps); x.ready(); await x.receive(); await flush();
    assert.equal(x.calls.length, 0); assert.equal(x.navigation.length, 0); assert.match(x.taps.snapshot(), /Unable to safely open/);
  }
});

test('newer warm tap wins over stale cold-start capture and listener cleanup removes the subscription', async () => {
  const x = setup(); x.ready(); let listener, removed = false;
  const cold = response(), warm = response({ type: 'habit_reminder' }, 'newer');
  const stop = listenNotificationTaps({ DEFAULT_ACTION_IDENTIFIER: 'default',
    addNotificationResponseReceivedListener: callback => { listener = callback; return { remove: () => { removed = true; } }; },
    getLastNotificationResponse: () => { listener(warm); return cold; },
  }, x.taps);
  await flush(); assert.deepEqual(x.calls.map(c => c[0]), ['today']);
  listener(warm); await flush(); assert.equal(x.navigation.length, 1); stop(); assert.equal(removed, true);
});

test('cold capture occurs synchronously and remains queued while lifecycle cleanup clears the native response', async () => {
  const x = setup(); let last = response();
  listenNotificationTaps({ DEFAULT_ACTION_IDENTIFIER: 'default', addNotificationResponseReceivedListener: () => ({ remove() {} }),
    getLastNotificationResponse: () => last }, x.taps);
  last = null; await flush(); assert.equal(x.calls.length, 0);
  x.ready(); await flush(); assert.deepEqual(x.navigation, ['/today']);
});

test('infrastructure test taps only open Diagnostics and never invoke habit reads', async () => {
  const x = setup(); x.ready();
  await x.receive(response({ request_id: 'infra_request_123', server_timestamp: '2026-10-20T10:00:00Z', url: '/habit-history', habit_id: habit }));
  await flush(); assert.equal(x.calls.length, 0); assert.deepEqual(x.navigation, ['/diagnostics']);
});

test('route readiness loss during a read waits and revalidates before navigating', async () => {
  const read = deferred(); const x = setup(); let reads = 0;
  x.deps.readToday = async () => ++reads === 1 ? read.promise : today();
  x.ready(); await x.receive(response({ type: 'habit_reminder' })); await flush();
  x.taps.setReady(false); read.resolve(today()); await flush(); assert.equal(x.navigation.length, 0);
  x.taps.setReady(true); await flush(); assert.equal(reads, 2); assert.deepEqual(x.navigation, ['/today']);
});

const localMetadata = (changes = {}) => ({ type: 'local_habit_reminder', owner_id: habit,
  target: 'today', receipt_id: `${reminder}:1`, ...changes });

test('local native cold tap uses the shared authenticated Today gate and durable receipt dedup', async () => {
  const x = setup();
  await x.taps.receiveLocal(localMetadata());
  x.taps.setSession(state('loading', habit)); x.taps.setReady(true);
  await flush(); assert.equal(x.calls.length, 0);
  x.taps.setSession(state('ready', habit)); await flush();
  assert.deepEqual(x.calls, [['today', habit]]); assert.deepEqual(x.navigation, ['/today']);
  await x.taps.receiveLocal(localMetadata()); await flush(); assert.equal(x.navigation.length, 1);
  const restarted = setup({}, x.disk); restarted.taps.setSession(state('ready', habit)); restarted.taps.setReady(true);
  await restarted.taps.receiveLocal(localMetadata()); await flush(); assert.equal(restarted.calls.length, 0);
});

test('local tap ignores malformed metadata, arbitrary destinations, missing receipts and another owner', async () => {
  const x = setup(); x.taps.setSession(state('ready', habit)); x.taps.setReady(true);
  for (const metadata of [null, {}, localMetadata({ owner_id: occurrence }), localMetadata({ target: '/diagnostics' }),
    localMetadata({ receipt_id: null }), localMetadata({ receipt_id: 'a/b' }), localMetadata({ type: 'habit_reminder' })]) {
    await x.taps.receiveLocal(metadata);
  }
  await flush(); assert.equal(x.calls.length, 0); assert.equal(x.navigation.length, 0);
});

test('local receipt is bound to its original account through startup and late Today reads', async () => {
  const cold = setup(); await cold.taps.receiveLocal(localMetadata());
  cold.taps.setSession(state('ready', occurrence)); cold.taps.setReady(true); await flush();
  assert.equal(cold.calls.length, 0);
  const read = deferred(), x = setup({ readToday: () => read.promise });
  x.taps.setSession(state('ready', habit)); x.taps.setReady(true);
  await x.taps.receiveLocal(localMetadata()); await flush();
  x.taps.setSession(state('ready', occurrence)); read.resolve(today(habit)); await flush();
  assert.equal(x.navigation.length, 0);
});

test('offline local tap falls back safely without trusting the receipt as authorization', async () => {
  const x = setup({ readToday: async () => { throw Error('offline'); } });
  x.taps.setSession(state('ready', habit)); x.taps.setReady(true);
  await x.taps.receiveLocal(localMetadata()); await flush();
  assert.deepEqual(x.navigation, ['/home']); assert.match(x.taps.snapshot(), /no longer available/);
});
