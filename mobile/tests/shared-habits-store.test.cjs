const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual read store and session owner with controlled API timing.
const cache = {};
function lib(name) {
  if (cache[name]) return cache[name];
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Error, require: path => lib(path.slice(2)), process: { env: {} } });
  return cache[name] = exports;
}
const { SharedHabitsStore } = lib('shared-habits-store');
const { SessionStore } = lib('session-store');
const { ApiError } = lib('api');
const habitId = 'aaaaaaaa-1111-4111-8111-111111111111';
const session = (id = 'recipient-a', token = `${id}-token`) => ({ user: { id }, access_token: token });
const profile = id => ({ user_id: id, username: id, display_name: id, timezone: 'America/Los_Angeles' });
const configuration = { name: 'Read', description: null, type: 'target', target: 20, unit: 'pages',
  schedule: 'daily', weekdays: [], reminder_times: [] };
const shared = (changes = {}) => ({ id: habitId, owner: profile('owner'), configuration,
  local_date: '2026-10-19', timezone: 'Asia/Tokyo', server_time: '2026-10-19T14:00:00Z',
  due_today: false, occurrence: null, current_streak: 7, provisional: true,
  calculated_at: '2026-10-19T14:00:00Z', ...changes });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup(mode, read, readProfile = async s => profile(s.user.id)) {
  let authEvent;
  const calls = [];
  const auth = {
    getSession: async () => ({ data: { session: session() } }),
    onAuthStateChange: callback => { authEvent = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, { readProfile, createProfile: async s => profile(s.user.id) });
  await sessions.start();
  const api = {
    listSharedHabits: (...args) => { assert.equal(mode, 'list'); calls.push(args); return read(...args); },
    readSharedHabit: (...args) => { assert.equal(mode, 'detail'); calls.push(args); return read(...args); },
  };
  const store = new SharedHabitsStore(sessions, api, mode === 'detail' ? habitId : undefined);
  return { store, sessions, auth, calls, event: value => authEvent(value ? 'SIGNED_IN' : 'SIGNED_OUT', value) };
}
const result = (mode, value = shared()) => mode === 'list' ? [value] : value;
const loaded = (mode, store) => mode === 'list' ? store.snapshot().habits[0] : store.snapshot().habit;
function cleared(store, refreshing = false) {
  assert.equal(store.snapshot().habits.length, 0);
  assert.equal(store.snapshot().habit, null);
  if (!refreshing) assert.equal(store.snapshot().hasLoaded, false);
}

for (const mode of ['list', 'detail']) {
  test(`${mode}: initial read waits for server authorization and refresh removes previously authorized data immediately`, async () => {
    const initial = deferred(), refresh = deferred();
    let reads = 0, notifications = 0;
    const x = await setup(mode, () => ++reads === 1 ? initial.promise : refresh.promise);
    const unsubscribe = x.store.subscribe(() => notifications++);
    x.store.start();
    assert.equal(x.store.snapshot().loading, true);
    cleared(x.store);
    await x.store.refresh();
    assert.equal(reads, 1, 'An overlapping refresh does not issue another request');
    initial.resolve(result(mode));
    await flush();
    assert.equal(loaded(mode, x.store).current_streak, 7);
    assert.equal(x.store.snapshot().hasLoaded, true);
    assert.equal(x.calls[0][0].user.id, 'recipient-a');
    if (mode === 'detail') assert.equal(x.calls[0][1], habitId);
    const pending = x.store.refresh();
    cleared(x.store, true);
    assert.equal(x.store.snapshot().refreshing, true);
    await x.store.refresh();
    assert.equal(reads, 2);
    refresh.resolve(result(mode, shared({ current_streak: 8 })));
    await pending;
    assert.equal(loaded(mode, x.store).current_streak, 8);
    assert.equal(x.store.snapshot().refreshing, false);
    assert.equal(x.store.snapshot().error, null);
    assert.ok(notifications > 0);
    unsubscribe();
    const before = notifications;
    x.store.stop();
    assert.equal(notifications, before);
    cleared(x.store);
  });

  for (const [status, code, message] of [
    [404, 'habit_not_found', /no longer|unavailable|access|available/i],
    [403, 'http_403', /no longer|unavailable|access|available/i],
    [401, 'http_401', /session|sign in/i],
    [404, 'profile_not_found', /profile|onboarding/i],
    [null, 'network_error', /connection|network/i],
    [null, 'request_timeout', /timed out|timeout/i],
    [503, 'http_503', /unable|retry|again/i],
  ]) test(`${mode}: ${code} purges cached content, hides server details, and permits an explicit successful retry`, async () => {
    let reads = 0;
    const x = await setup(mode, async () => {
      if (++reads === 2) throw new ApiError('private backend diagnostic', status, code);
      return result(mode);
    });
    x.store.start();
    await flush();
    assert.ok(loaded(mode, x.store));
    await x.store.refresh();
    cleared(x.store);
    assert.match(x.store.snapshot().error, message);
    assert.doesNotMatch(x.store.snapshot().error, /private backend diagnostic/);
    assert.equal(x.store.snapshot().loading, false);
    assert.equal(x.store.snapshot().refreshing, false);
    if (status === 403 || code === 'habit_not_found') assert.equal(x.store.snapshot().inaccessible, true);
    await x.store.refresh();
    assert.equal(reads, 3);
    assert.ok(loaded(mode, x.store));
    assert.equal(x.store.snapshot().error, null);
    assert.equal(x.store.snapshot().inaccessible, false);
  });

  for (const outcome of ['success', 'failure']) {
    test(`${mode}: navigation invalidates an old ${outcome}, including after refocus`, async () => {
      const oldRead = deferred(), newRead = deferred();
      let reads = 0;
      const x = await setup(mode, () => ++reads === 1 ? Promise.resolve(result(mode)) : reads === 2 ? oldRead.promise : newRead.promise);
      x.store.start();
      await flush();
      const pending = x.store.refresh();
      x.store.stop();
      cleared(x.store);
      await x.store.refresh();
      assert.equal(reads, 2, 'A captured refresh handler cannot read after blur');
      x.store.start();
      assert.equal(reads, 3);
      const current = x.store.snapshot();
      if (outcome === 'success') oldRead.resolve(result(mode));
      else oldRead.reject(new ApiError('old denied request', 404, 'habit_not_found'));
      await pending;
      assert.equal(x.store.snapshot(), current);
      newRead.resolve(result(mode, shared({ current_streak: 12 })));
      await flush();
      assert.equal(loaded(mode, x.store).current_streak, 12);
    });

    for (const change of ['account', 'token']) test(`${mode}: ${change} changes clear identities and reject an old ${outcome}`, async () => {
      const oldRead = deferred(), newRead = deferred(), newProfile = deferred();
      let reads = 0;
      const x = await setup(mode,
        () => ++reads === 1 ? Promise.resolve(result(mode)) : reads === 2 ? oldRead.promise : newRead.promise,
        s => s.user.id === 'recipient-b' ? newProfile.promise : Promise.resolve(profile(s.user.id)));
      x.store.start();
      await flush();
      const pending = x.store.refresh();
      const next = change === 'account' ? session('recipient-b') : session('recipient-a', 'rotated-token');
      x.event(next);
      cleared(x.store);
      if (change === 'account') {
        assert.equal(x.sessions.snapshot().status, 'loading');
        assert.equal(reads, 2, 'Wait for the new account profile before reading');
        newProfile.resolve(profile('recipient-b'));
        await flush();
      }
      assert.equal(reads, 3);
      const current = x.store.snapshot();
      if (outcome === 'success') oldRead.resolve(result(mode, shared({ owner: profile('private-old-owner') })));
      else oldRead.reject(new ApiError('old private failure', 401, 'http_401'));
      await pending;
      assert.equal(x.store.snapshot(), current);
      assert.equal(x.calls.at(-1)[0], next);
      newRead.resolve(result(mode, shared({ owner: profile('current-owner') })));
      await flush();
      assert.equal(loaded(mode, x.store).owner.user_id, 'current-owner');
      assert.equal(x.store.snapshot().error, null);
    });
  }

  test(`${mode}: sign-out clears shared content before Auth storage settles and rejects a pending read`, async () => {
    const oldRead = deferred(), logout = deferred();
    let reads = 0;
    const x = await setup(mode, () => ++reads === 1 ? Promise.resolve(result(mode)) : oldRead.promise);
    x.store.start();
    await flush();
    const pending = x.store.refresh();
    x.auth.signOut = () => logout.promise;
    const signingOut = x.sessions.signOut();
    assert.equal(x.sessions.snapshot().status, 'loading');
    cleared(x.store);
    oldRead.resolve(result(mode));
    await pending;
    cleared(x.store);
    await x.store.refresh();
    assert.equal(reads, 2);
    logout.resolve({ error: null });
    await signingOut;
    assert.equal(x.sessions.snapshot().status, 'signed_out');
    cleared(x.store);
  });
}

test('a successful empty recipient list is private by default without invoking any owner or friendship endpoint', async () => {
  const x = await setup('list', async () => []);
  x.store.start();
  await flush();
  assert.equal(x.store.snapshot().habits.length, 0);
  assert.equal(x.store.snapshot().habit, null);
  assert.equal(x.store.snapshot().hasLoaded, true);
  assert.equal(x.store.snapshot().error, null);
  assert.equal(x.calls.length, 1);
});

for (const mode of ['list', 'detail']) {
  test(`${mode}: an old authorized success cannot repopulate data after a newer access denial`, async () => {
    const oldRead = deferred();
    let reads = 0;
    const x = await setup(mode, async () => {
      if (++reads === 1) return result(mode);
      if (reads === 2) return oldRead.promise;
      throw new ApiError('Habit not found', 404, 'habit_not_found');
    });
    x.store.start();
    await flush();
    const pending = x.store.refresh();
    x.event(session('recipient-a', 'renewed-token'));
    await flush();
    cleared(x.store);
    assert.equal(x.store.snapshot().inaccessible, true);
    const denied = x.store.snapshot();
    oldRead.resolve(result(mode));
    await pending;
    assert.equal(x.store.snapshot(), denied);
    cleared(x.store);
  });

  test(`${mode}: an old denial cannot erase a newer successful response`, async () => {
    const oldRead = deferred();
    let reads = 0;
    const x = await setup(mode, async () => {
      if (++reads === 1) return oldRead.promise;
      return result(mode, shared({ current_streak: 9 }));
    });
    x.store.start();
    x.event(session('recipient-a', 'renewed-token'));
    await flush();
    assert.equal(loaded(mode, x.store).current_streak, 9);
    const current = x.store.snapshot();
    oldRead.reject(new ApiError('Old habit denial', 404, 'habit_not_found'));
    await flush();
    assert.equal(x.store.snapshot(), current);
    assert.equal(x.store.snapshot().error, null);
  });
}
