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
async function setup(listHabits, readProfile = async s => profile(s.user.id), initial = session('a'), restoreHabit = async (_s, id) => habit({ id })) {
  let callback;
  const auth = {
    getSession: async () => ({ data: { session: initial } }),
    onAuthStateChange: cb => { callback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, { readProfile, createProfile: async s => profile(s.user.id) });
  await sessions.start();
  return { store: new HabitsStore(sessions, listHabits, restoreHabit), sessions, auth, event: s => callback('SIGNED_IN', s) };
}
function empty(store, expected = {}) {
  const state = store.snapshot();
  assert.deepEqual({ ...state, habits: Array.from(state.habits) }, {
    habits: [], status: 'active', hasLoaded: false, loading: false, refreshing: false, error: null,
    restoreConfirmation: null, restoringId: null, restoreError: null, restoreUncertain: false, ...expected,
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

const archived = (overrides = {}) => habit({ archived_at: '2026-10-10T13:00:00Z', ...overrides });
async function archivedSetup(restoreHabit, listHabits = async () => [archived()]) {
  const x = await setup(listHabits, undefined, undefined, restoreHabit);
  x.store.start();
  await flush();
  x.store.setStatus('archived');
  await flush();
  return x;
}

test('Active is the default backend filter; changing filter clears previous rows and loads archived habits', async () => {
  const archivedRead = deferred();
  const calls = [];
  const x = await setup((s, status) => {
    calls.push([s.user.id, status]);
    return status === 'archived' ? archivedRead.promise : Promise.resolve([habit()]);
  });
  x.store.start();
  await flush();
  assert.deepEqual(calls, [['a', 'active']]);
  x.store.setStatus('active');
  assert.equal(calls.length, 1);
  x.store.setStatus('archived');
  empty(x.store, { status: 'archived', loading: true });
  assert.deepEqual(calls[1], ['a', 'archived']);
  archivedRead.resolve([habit(), archived()]);
  await flush();
  assert.equal(x.store.snapshot().habits.length, 1);
  assert.ok(x.store.snapshot().habits[0].archived_at);
  x.store.setStatus('active');
  empty(x.store, { loading: true });
  await flush();
  assert.equal(x.store.snapshot().habits[0].archived_at, null);
});

test('filter changes invalidate late successes and failures from earlier filters', async () => {
  for (const outcome of ['success', 'error']) {
    const old = deferred();
    const x = await setup((_s, status) => status === 'active' ? old.promise : Promise.resolve([archived()]));
    x.store.start();
    x.store.setStatus('archived');
    await flush();
    const accepted = x.store.snapshot();
    if (outcome === 'success') old.resolve([habit()]);
    else old.reject(new ApiError('Old read failure', 503, 'http_503'));
    await flush();
    assert.equal(x.store.snapshot(), accepted);
    assert.equal(accepted.status, 'archived');
  }
});

test('restore requires current archived-card confirmation, and cancellation does not mutate or refresh', async () => {
  let restores = 0, reads = 0;
  const x = await archivedSetup(async () => { restores++; return habit(); }, async () => { reads++; return [archived()]; });
  const item = x.store.snapshot().habits[0];
  await x.store.confirmRestore(item);
  assert.equal(restores, 0);
  x.store.requestRestore(item);
  assert.equal(x.store.snapshot().restoreConfirmation, item);
  assert.equal(restores, 0);
  x.store.cancelRestore(item);
  assert.equal(x.store.snapshot().restoreConfirmation, null);
  await x.store.confirmRestore(item);
  assert.equal(restores, 0);
  assert.equal(reads, 2);
  x.store.setStatus('active');
  await flush();
  x.store.requestRestore(item);
  assert.equal(x.store.snapshot().restoreConfirmation, null);
});

test('confirmed restore is single-flight and refreshes the archived list only after success', async () => {
  const mutation = deferred(), refresh = deferred();
  const supplied = [], statuses = [];
  const x = await archivedSetup((s, id) => { supplied.push([s, id]); return mutation.promise; }, async (_s, status) => {
    statuses.push(status);
    return statuses.length > 2 ? refresh.promise : [archived()];
  });
  const item = x.store.snapshot().habits[0];
  x.store.requestRestore(item);
  const pending = x.store.confirmRestore(item);
  assert.equal(x.store.snapshot().restoringId, item.id);
  assert.equal(x.store.snapshot().restoreConfirmation, null);
  x.store.requestRestore(item);
  await x.store.confirmRestore(item);
  await x.store.reload();
  assert.equal(supplied.length, 1);
  assert.equal(supplied[0][0].user.id, 'a');
  assert.equal(supplied[0][1], item.id);
  assert.equal(statuses.length, 2);
  mutation.resolve(habit());
  await flush();
  assert.deepEqual(statuses, ['active', 'archived', 'archived']);
  assert.equal(x.store.snapshot().refreshing, true);
  assert.equal(x.store.snapshot().restoringId, null);
  assert.equal(x.store.snapshot().habits.length, 0);
  refresh.resolve([]);
  await pending;
  assert.equal(x.store.snapshot().refreshing, false);
  assert.equal(x.store.snapshot().restoreError, null);
});

test('restore success remains reflected when the required list refresh fails', async () => {
  let reads = 0, restores = 0;
  const x = await archivedSetup(async () => { restores++; return habit(); }, async () => {
    if (++reads > 2) throw new ApiError('Offline', null, 'network_error');
    return [archived()];
  });
  const item = x.store.snapshot().habits[0];
  x.store.requestRestore(item);
  await x.store.confirmRestore(item);
  assert.equal(restores, 1);
  assert.equal(reads, 3);
  assert.equal(x.store.snapshot().habits.length, 0);
  assert.match(x.store.snapshot().error, /connection/i);
  assert.equal(x.store.snapshot().restoreError, null);
});

test('definite restore failures preserve the card, show a safe error, and require another confirmation to retry', async () => {
  for (const [error, message] of [
    [new ApiError('Expired token', 401, 'http_401'), /verify your session/],
    [new ApiError('Not owned', 404, 'habit_not_found'), /no longer available/],
    [new ApiError('Private implementation detail', 422, 'http_422'), /unable to restore/i],
  ]) {
    let restores = 0, reads = 0;
    const x = await archivedSetup(async () => { restores++; throw error; }, async () => { reads++; return [archived()]; });
    const item = x.store.snapshot().habits[0];
    x.store.requestRestore(item);
    await x.store.confirmRestore(item);
    assert.equal(x.store.snapshot().habits[0], item);
    assert.equal(x.store.snapshot().restoreUncertain, false);
    assert.equal(x.store.snapshot().restoringId, null);
    assert.match(x.store.snapshot().restoreError, message);
    assert.ok(!x.store.snapshot().restoreError.includes('Private implementation detail'));
    await x.store.confirmRestore(item);
    assert.equal(restores, 1);
    assert.equal(reads, 2);
    x.store.requestRestore(item);
    await x.store.confirmRestore(item);
    assert.equal(restores, 2);
  }
});

test('ambiguous restore errors never retry automatically and require a successful current-state refresh before retrying', async () => {
  for (const error of [
    new ApiError('deadline', null, 'request_timeout'), new ApiError('timeout', 408, 'http_408'),
    new ApiError('Offline', null, 'network_error'), new ApiError('Server unavailable', 503, 'http_503'),
    new Error('Unknown upstream error'),
  ]) {
    let reads = 0, restores = 0, failRead = false;
    const x = await archivedSetup(async () => { restores++; throw error; }, async () => {
      reads++;
      if (failRead) throw new ApiError('Offline', null, 'network_error');
      return [archived()];
    });
    let item = x.store.snapshot().habits[0];
    x.store.requestRestore(item);
    await x.store.confirmRestore(item);
    assert.equal(x.store.snapshot().restoreUncertain, true);
    assert.match(x.store.snapshot().restoreError, /may have succeeded.*refresh current server state/i);
    x.store.requestRestore(item);
    await x.store.confirmRestore(item);
    assert.equal(x.store.snapshot().restoreConfirmation, null);
    assert.equal(restores, 1);
    assert.equal(reads, 2);
    failRead = true;
    await x.store.reload();
    assert.equal(x.store.snapshot().restoreUncertain, true);
    assert.match(x.store.snapshot().error, /connection/i);
    failRead = false;
    await x.store.reload();
    assert.equal(x.store.snapshot().restoreUncertain, false);
    assert.equal(x.store.snapshot().restoreError, null);
    assert.equal(restores, 1);
    item = x.store.snapshot().habits[0];
    x.store.requestRestore(item);
    await x.store.confirmRestore(item);
    assert.equal(restores, 2);
  }
});

test('refresh after ambiguous restore removes a habit if the server already restored it', async () => {
  let reads = 0, restores = 0;
  const x = await archivedSetup(async () => { restores++; throw new ApiError('Deadline', null, 'request_timeout'); }, async () => ++reads > 2 ? [] : [archived()]);
  const item = x.store.snapshot().habits[0];
  x.store.requestRestore(item);
  await x.store.confirmRestore(item);
  await x.store.reload();
  assert.equal(restores, 1);
  assert.equal(x.store.snapshot().habits.length, 0);
  assert.equal(x.store.snapshot().restoreUncertain, false);
  assert.equal(x.store.snapshot().restoreError, null);
});

test('restore response identity and lifecycle mismatches are ambiguous and do not refresh', async () => {
  for (const result of [habit({ owner_id: 'b' }), habit({ id: 'other' }), archived()]) {
    let reads = 0;
    const x = await archivedSetup(async () => result, async () => { reads++; return [archived()]; });
    const item = x.store.snapshot().habits[0];
    x.store.requestRestore(item);
    await x.store.confirmRestore(item);
    assert.equal(reads, 2);
    assert.equal(x.store.snapshot().restoreUncertain, true);
    assert.equal(x.store.snapshot().habits[0], item);
  }
});

test('filter changes, navigation, account changes, and refresh invalidate stale confirmations and card handlers', async () => {
  for (const transition of ['filter', 'navigation', 'account', 'refresh']) {
    let restores = 0;
    const x = await archivedSetup(async () => { restores++; return habit(); }, async s => [archived({ owner_id: s.user.id })]);
    const oldItem = x.store.snapshot().habits[0];
    x.store.requestRestore(oldItem);
    if (transition === 'filter') { x.store.setStatus('active'); x.store.setStatus('archived'); }
    if (transition === 'navigation') { x.store.stop(); x.store.start(); await flush(); x.store.setStatus('archived'); }
    if (transition === 'account') { x.event(session('b')); await flush(); x.store.setStatus('archived'); }
    if (transition === 'refresh') await x.store.reload();
    await flush();
    assert.equal(x.store.snapshot().restoreConfirmation, null);
    x.store.requestRestore(oldItem);
    await x.store.confirmRestore(oldItem);
    assert.equal(restores, 0);
    const currentItem = x.store.snapshot().habits[0];
    x.store.requestRestore(currentItem);
    x.store.cancelRestore(oldItem);
    await x.store.confirmRestore(oldItem);
    assert.equal(x.store.snapshot().restoreConfirmation, currentItem);
    assert.equal(restores, 0);
  }
});

test('pending restore ignores late success and error after filter changes or leaving and reopening', async () => {
  for (const transition of ['filter', 'navigation']) for (const outcome of ['success', 'error']) {
    const old = deferred();
    let restores = 0, reads = 0;
    const x = await archivedSetup(async () => { restores++; return old.promise; }, async () => { reads++; return [archived()]; });
    const item = x.store.snapshot().habits[0];
    x.store.requestRestore(item);
    const pending = x.store.confirmRestore(item);
    if (transition === 'filter') { x.store.setStatus('active'); x.store.setStatus('archived'); }
    else { x.store.stop(); x.store.start(); await flush(); x.store.setStatus('archived'); }
    await flush();
    const current = x.store.snapshot().habits[0];
    assert.equal(x.store.snapshot().restoringId, item.id);
    x.store.requestRestore(current);
    await x.store.confirmRestore(current);
    assert.equal(restores, 1);
    const acceptedReads = reads;
    if (outcome === 'success') old.resolve(habit());
    else old.reject(new ApiError('Late failure', null, 'network_error'));
    await pending;
    assert.equal(reads, acceptedReads);
    assert.equal(x.store.snapshot().habits[0], current);
    assert.equal(x.store.snapshot().restoreError, null);
    assert.equal(x.store.snapshot().restoreUncertain, false);
    assert.equal(x.store.snapshot().restoringId, null);
  }
});

test('account changes and sign-out clear restore state and ignore late mutation outcomes', async () => {
  for (const transition of ['account', 'signout']) for (const outcome of ['success', 'error']) {
    const old = deferred(), profileB = deferred();
    let reads = 0;
    const x = await setup(async s => { reads++; return [archived({ owner_id: s.user.id })]; },
      async s => s.user.id === 'b' ? profileB.promise : profile('a'), undefined, () => old.promise);
    x.store.start();
    await flush();
    x.store.setStatus('archived');
    await flush();
    const item = x.store.snapshot().habits[0];
    x.store.requestRestore(item);
    const pending = x.store.confirmRestore(item);
    let signingOut;
    if (transition === 'account') x.event(session('b'));
    else signingOut = x.sessions.signOut();
    empty(x.store);
    if (outcome === 'success') old.resolve(habit());
    else old.reject(new ApiError('Late timeout', null, 'request_timeout'));
    await pending;
    await signingOut;
    empty(x.store);
    assert.equal(reads, 2);
    if (transition === 'account') {
      profileB.resolve(profile('b'));
      await flush();
      assert.equal(x.store.snapshot().status, 'active');
      assert.equal(x.store.snapshot().restoreError, null);
    }
  }
});

test('same-account token refresh preserves the pending restore guard and refreshes with the new token after success', async () => {
  const mutation = deferred();
  const supplied = [];
  let restores = 0;
  const x = await archivedSetup(async () => { restores++; return mutation.promise; }, async s => { supplied.push(s); return [archived()]; });
  const item = x.store.snapshot().habits[0];
  x.store.requestRestore(item);
  const pending = x.store.confirmRestore(item);
  const fresh = { ...session('a'), access_token: 'new-a-token' };
  x.event(fresh);
  x.store.requestRestore(item);
  await x.store.confirmRestore(item);
  assert.equal(restores, 1);
  assert.equal(x.store.snapshot().restoringId, item.id);
  assert.equal(supplied.length, 2);
  mutation.resolve(habit());
  await pending;
  assert.equal(supplied.length, 3);
  assert.equal(supplied[2], fresh);
  assert.equal(x.store.snapshot().restoringId, null);
});

test('repeated recovery refresh taps issue one GET and never repeat an ambiguous restore', async () => {
  const refresh = deferred();
  let reads = 0, restores = 0;
  const x = await archivedSetup(async () => { restores++; throw new ApiError('Deadline', null, 'request_timeout'); }, async () => ++reads > 2 ? refresh.promise : [archived()]);
  const item = x.store.snapshot().habits[0];
  x.store.requestRestore(item);
  await x.store.confirmRestore(item);
  const first = x.store.refreshServerState();
  await x.store.refreshServerState();
  await x.store.refreshServerState();
  assert.equal(reads, 3);
  assert.equal(restores, 1);
  assert.equal(x.store.snapshot().refreshing, true);
  refresh.resolve([archived()]);
  await first;
  assert.equal(x.store.snapshot().restoreUncertain, false);
  assert.equal(restores, 1);
});
