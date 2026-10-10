const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the stores without a native runtime, real auth, or network requests.
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const exports = {};
  const source = ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: path => load(path.slice(2)), process: { env: {} } });
  return cache[name] = exports;
}
const { HabitsStore } = load('habits-store');
const { SessionStore } = load('session-store');
const { ApiError } = load('api');
const { habitSchedule, habitType } = load('habit-labels');
const session = id => ({ user: { id }, access_token: `${id}-token` });
const profile = id => ({ user_id: id, username: id });
const habit = (overrides = {}) => ({
  id: 'habit-a', owner_id: 'a', name: 'Read', description: null,
  type: 'binary', target: null, unit: null, schedule: 'daily', weekdays: [], reminder_times: ['08:00'],
  created_at: '2026-10-10T12:00:00Z', updated_at: '2026-10-10T12:00:00Z', archived_at: null,
  ...overrides,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
async function setup(listHabits, readProfile = async s => profile(s.user.id), initial = session('a')) {
  let callback;
  const auth = {
    getSession: async () => ({ data: { session: initial } }),
    onAuthStateChange: cb => { callback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, { readProfile, createProfile: async s => profile(s.user.id) });
  await sessions.start();
  return { store: new HabitsStore(sessions, listHabits), sessions, auth, event: s => callback('SIGNED_IN', s) };
}
function empty(store, expected = {}) {
  const state = store.snapshot();
  assert.deepEqual({ ...state, habits: Array.from(state.habits) }, {
    habits: [], hasLoaded: false, loading: false, refreshing: false, error: null, ...expected,
  });
}

test('initial load shows loading and returns only active habits', async () => {
  const read = deferred();
  const x = await setup(() => read.promise);
  empty(x.store);
  x.store.start();
  empty(x.store, { loading: true });
  const binary = habit();
  const target = habit({ id: 'target', type: 'target', target: 5000, unit: 'steps' });
  read.resolve([binary, habit({ id: 'archived', archived_at: '2026-10-09T12:00:00Z' }), target]);
  await flush();
  assert.deepEqual(x.store.snapshot().habits, [binary, target]);
  assert.equal(x.store.snapshot().hasLoaded, true);
  assert.equal(x.store.snapshot().loading, false);
  assert.equal(x.store.snapshot().refreshing, false);
  assert.equal(x.store.snapshot().error, null);
});

test('an empty response finishes loading and represents a successful empty account', async () => {
  const x = await setup(async () => []);
  x.store.start();
  await flush();
  empty(x.store, { hasLoaded: true });
});

test('initial failures explain retry without claiming the account is empty', async () => {
  for (const [error, message] of [
    [new ApiError('expired', 401, 'http_401'), /verify your session/i],
    [new ApiError('offline', null, 'network_error'), /connection/i],
    [new ApiError('deadline', null, 'request_timeout'), /timed out/i],
    [new ApiError('unavailable', 503, 'http_503'), /unable to load/i],
    [new Error('private upstream detail'), /unable to load/i],
  ]) {
    let fail = true, calls = 0;
    const x = await setup(async () => { calls++; if (fail) throw error; return [habit()]; });
    x.store.start();
    await flush();
    const failed = x.store.snapshot();
    empty(x.store, { error: failed.error });
    assert.match(failed.error, message);
    assert.match(failed.error, /retry/i);
    assert.ok(!failed.error.includes('private upstream detail'));
    assert.equal(calls, 1);
    fail = false;
    const retry = x.store.reload();
    empty(x.store, { loading: true });
    await retry;
    assert.equal(calls, 2);
    assert.equal(x.store.snapshot().habits[0].name, 'Read');
    assert.equal(x.store.snapshot().error, null);
  }
});

test('failed pull-to-refresh retains visible habits and can be retried', async () => {
  const refresh = deferred();
  let calls = 0;
  const existing = habit();
  const x = await setup(() => ++calls === 2 ? refresh.promise : Promise.resolve([existing]));
  x.store.start();
  await flush();
  const pending = x.store.reload();
  assert.equal(x.store.snapshot().refreshing, true);
  assert.equal(x.store.snapshot().loading, false);
  assert.deepEqual(x.store.snapshot().habits, [existing]);
  refresh.reject(new ApiError('offline', null, 'network_error'));
  await pending;
  assert.deepEqual(x.store.snapshot().habits, [existing]);
  assert.equal(x.store.snapshot().hasLoaded, true);
  assert.equal(x.store.snapshot().refreshing, false);
  assert.match(x.store.snapshot().error, /connection/i);
  await x.store.reload();
  assert.equal(x.store.snapshot().error, null);
  assert.equal(calls, 3);
});

test('overlapping reads ignore stale successes and errors', async () => {
  for (const outcome of ['success', 'error']) {
    const older = deferred(), newer = deferred();
    let calls = 0;
    const x = await setup(() => ++calls === 1 ? older.promise : newer.promise);
    x.store.start();
    const latest = x.store.reload();
    const currentHabit = habit({ name: 'Latest result' });
    newer.resolve([currentHabit]);
    await latest;
    const accepted = x.store.snapshot();
    if (outcome === 'success') older.resolve([habit({ name: 'Old result' })]);
    else older.reject(new ApiError('offline', null, 'network_error'));
    await flush();
    assert.equal(x.store.snapshot(), accepted);
    assert.equal(x.store.snapshot().habits[0], currentHabit);
  }
});

test('account switching immediately clears populated data and ignores the previous account read', async () => {
  for (const outcome of ['success', 'error']) {
    const oldRead = deferred(), nextProfile = deferred();
    let readsA = 0;
    const x = await setup(
      s => s.user.id === 'b' ? Promise.resolve([habit({ owner_id: 'b', name: 'B habit' })])
        : ++readsA === 1 ? Promise.resolve([habit()]) : oldRead.promise,
      s => s.user.id === 'b' ? nextProfile.promise : Promise.resolve(profile('a')),
    );
    x.store.start();
    await flush();
    assert.equal(x.store.snapshot().habits.length, 1);
    const pending = x.store.reload();
    x.event(session('b'));
    assert.equal(x.sessions.snapshot().status, 'loading');
    empty(x.store);
    nextProfile.resolve(profile('b'));
    await flush();
    const accepted = x.store.snapshot();
    assert.equal(accepted.habits[0].owner_id, 'b');
    if (outcome === 'success') oldRead.resolve([habit({ name: 'Late A habit' })]);
    else oldRead.reject(new ApiError('expired A token', 401, 'http_401'));
    await pending;
    assert.equal(x.store.snapshot(), accepted);
  }
});

test('sign-out clears habits before auth settles and invalidates pending reads', async () => {
  const oldRead = deferred(), logout = deferred();
  let calls = 0;
  const x = await setup(() => ++calls === 1 ? Promise.resolve([habit()]) : oldRead.promise);
  x.store.start();
  await flush();
  const pending = x.store.reload();
  x.auth.signOut = () => logout.promise;
  const signingOut = x.sessions.signOut();
  assert.equal(x.sessions.snapshot().status, 'loading');
  empty(x.store);
  oldRead.resolve([habit()]);
  await pending;
  empty(x.store);
  logout.resolve({ error: null });
  await signingOut;
  empty(x.store);
  await x.store.reload();
  assert.equal(calls, 2);
  assert.equal(x.sessions.snapshot().status, 'signed_out');
});

test('stopping clears data, ignores late reads, and unsubscribes from session changes', async () => {
  const oldRead = deferred();
  let calls = 0;
  const x = await setup(() => ++calls === 1 ? Promise.resolve([habit()]) : oldRead.promise);
  x.store.start();
  await flush();
  const pending = x.store.reload();
  x.store.stop();
  empty(x.store);
  oldRead.resolve([habit()]);
  await pending;
  x.event(session('b'));
  await flush();
  empty(x.store);
  assert.equal(calls, 2);
});

test('a late request from before restart cannot change the new loading state', async () => {
  const oldRead = deferred(), newRead = deferred();
  let calls = 0;
  const x = await setup(() => ++calls === 1 ? oldRead.promise : newRead.promise);
  x.store.start();
  x.store.stop();
  x.store.start();
  oldRead.reject(new ApiError('offline', null, 'network_error'));
  await flush();
  empty(x.store, { loading: true });
  newRead.resolve([habit({ name: 'Reopened screen' })]);
  await flush();
  assert.equal(x.store.snapshot().habits[0].name, 'Reopened screen');
  assert.equal(x.store.snapshot().error, null);
});

test('token refresh uses the current session and preserves data while rejecting older results', async () => {
  const oldRead = deferred(), newRead = deferred();
  const supplied = [];
  const existing = habit();
  const x = await setup(s => {
    supplied.push(s);
    return supplied.length === 1 ? Promise.resolve([existing]) : supplied.length === 2 ? oldRead.promise : newRead.promise;
  });
  x.store.start();
  await flush();
  const pending = x.store.reload();
  const refreshed = { ...session('a'), access_token: 'refreshed-a-token' };
  x.event(refreshed);
  assert.equal(supplied[2], refreshed);
  assert.equal(supplied[2].access_token, 'refreshed-a-token');
  assert.deepEqual(x.store.snapshot().habits, [existing]);
  assert.equal(x.store.snapshot().refreshing, true);
  newRead.resolve([habit({ name: 'Fresh token result' })]);
  await flush();
  const accepted = x.store.snapshot();
  oldRead.resolve([habit({ name: 'Old token result' })]);
  await pending;
  assert.equal(x.store.snapshot(), accepted);
  assert.equal(accepted.habits[0].name, 'Fresh token result');
});

test('responses containing another owner fail without displaying any returned habits', async () => {
  const x = await setup(async () => [habit(), habit({ id: 'foreign', owner_id: 'b' })]);
  x.store.start();
  await flush();
  assert.match(x.store.snapshot().error, /unable to load.*retry/i);
  empty(x.store, { error: x.store.snapshot().error });
});

test('schedule labels use ISO weekdays, including Sunday, and explain daily habits', () => {
  assert.equal(habitSchedule(habit()), 'Every day');
  assert.equal(habitSchedule(habit({ schedule: 'selected', weekdays: [1, 3, 7] })), 'Monday, Wednesday, Sunday');
  assert.equal(habitSchedule(habit({ schedule: 'selected', weekdays: [7] })), 'Sunday');
});

test('type labels explain binary and target habits with an optional unit', () => {
  assert.equal(habitType(habit()), 'Binary (yes/no)');
  assert.equal(habitType(habit({ type: 'target', target: 2, unit: 'litres' })), 'Target: 2 litres');
  assert.equal(habitType(habit({ type: 'target', target: 10, unit: null })), 'Target: 10');
});
