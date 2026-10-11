const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Real stores and validation, with mocked auth/API and no native runtime or live writes.
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const exports = {};
  const source = ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // Modules in the app share Error; use the same constructor across these VM contexts.
  vm.runInNewContext(source, { exports, Error, require: path => load(path.slice(2)), process: { env: {} } });
  return cache[name] = exports;
}
const { CreateHabitStore } = load('create-habit-store');
const { HabitsStore } = load('habits-store');
const { SessionStore } = load('session-store');
const { ApiError } = load('api');
const { emptyHabitDraft } = load('habit-input');
const plain = value => JSON.parse(JSON.stringify(value));
const session = id => ({ user: { id }, access_token: `${id}-token` });
const profile = id => ({ user_id: id, username: id });
const draft = (changes = {}) => ({
  ...emptyHabitDraft(), name: ' Read ', description: 'Read a little every evening',
  type: 'target', target: ' 25 ', unit: ' pages ', schedule: 'selected', weekdays: [7, 1],
  reminderTimes: '21:30, 08:00', ...changes,
});
const habit = (changes = {}) => ({
  id: 'new-habit', owner_id: 'a', name: 'Read', description: 'Read a little every evening',
  type: 'target', target: 25, unit: 'pages', schedule: 'selected', weekdays: [1, 7],
  reminder_times: ['08:00', '21:30'], created_at: '2026-10-10T12:00:00Z',
  updated_at: '2026-10-10T12:00:00Z', archived_at: null, ...changes,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
async function setup(createHabit, onCreated = () => {}, options = {}) {
  let callback;
  const auth = {
    getSession: async () => ({ data: { session: options.initial === undefined ? session('a') : options.initial } }),
    onAuthStateChange: cb => { callback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, {
    readProfile: options.readProfile || (async s => profile(s.user.id)),
    createProfile: async s => profile(s.user.id),
  });
  await sessions.start();
  const store = new CreateHabitStore(sessions, createHabit, onCreated);
  store.start();
  return { store, sessions, auth, event: s => callback('SIGNED_IN', s) };
}
function assertEmpty(store) {
  assert.deepEqual(plain(store.snapshot()), {
    draft: plain(emptyHabitDraft()), busy: false, created: false, error: null, ambiguous: false,
  });
}

test('invalid form values show readable validation errors without calling creation', async () => {
  let calls = 0;
  const x = await setup(async () => { calls++; return habit(); });
  for (const [changes, expected] of [
    [{ name: ' ' }, /Name must be 1–100 characters/],
    [{ schedule: 'selected', weekdays: [] }, /Select at least one weekday/],
    [{ reminderTimes: '' }, /at least one reminder time/],
    [{ reminderTimes: '08:00,08:00' }, /must be distinct/],
    [{ target: '0' }, /positive whole number/],
  ]) {
    const entered = draft(changes);
    x.store.update(entered);
    await x.store.submit();
    assert.match(x.store.snapshot().error, expected);
    assert.deepEqual(plain(x.store.snapshot().draft), plain(entered));
    assert.equal(x.store.snapshot().busy, false);
    assert.equal(x.store.snapshot().ambiguous, false);
  }
  assert.equal(calls, 0);
});

test('successful creation uses validated payload and returning to My habits fetches the new habit', async () => {
  let saved = [], reads = 0, navigations = 0, list;
  const supplied = [];
  const x = await setup(async (current, input) => {
    supplied.push({ current, input });
    const result = habit({ ...input, owner_id: current.user.id });
    saved = [result];
    return result;
  }, () => { navigations++; list.start(); });
  list = new HabitsStore(x.sessions, async () => { reads++; return saved; });
  list.start();
  await flush();
  assert.equal(list.snapshot().habits.length, 0);
  assert.equal(list.snapshot().hasLoaded, true);
  list.stop(); // My habits loses focus while its create screen is open.
  x.store.update(draft());
  await x.store.submit();
  await flush();
  assert.equal(supplied.length, 1);
  assert.equal(supplied[0].current, x.sessions.snapshot().session);
  assert.deepEqual(plain(supplied[0].input), {
    name: 'Read', description: 'Read a little every evening', type: 'target', target: 25, unit: 'pages',
    schedule: 'selected', weekdays: [1, 7], reminder_times: ['08:00', '21:30'],
  });
  assert.equal(navigations, 1);
  assert.equal(reads, 2);
  assert.equal(list.snapshot().habits[0].id, 'new-habit');
  assert.equal(list.snapshot().habits[0].name, 'Read');
  assert.equal(list.snapshot().error, null);
  assert.equal(x.store.snapshot().created, true);
  assert.equal(x.store.snapshot().busy, false);
  assert.equal(x.store.snapshot().error, null);
});

test('duplicate submissions are blocked immediately and remain blocked after confirmed success', async () => {
  const write = deferred();
  let calls = 0, navigations = 0;
  const x = await setup(() => { calls++; return write.promise; }, () => navigations++);
  const entered = draft();
  x.store.update(entered);
  const first = x.store.submit();
  const second = x.store.submit();
  assert.equal(calls, 1);
  assert.equal(x.store.snapshot().busy, true);
  x.store.update({ name: 'Changed while saving' });
  assert.deepEqual(plain(x.store.snapshot().draft), plain(entered));
  write.resolve(habit());
  await Promise.all([first, second]);
  await x.store.submit();
  x.store.update({ name: 'Changed after saving' });
  assert.deepEqual(plain(x.store.snapshot().draft), plain(entered));
  assert.equal(calls, 1);
  assert.equal(navigations, 1);
  assert.equal(x.store.snapshot().created, true);
});

test('definite failures preserve every entered value and allow an explicit retry', async () => {
  for (const [error, expected] of [
    [new ApiError('Request validation failed. Check the submitted fields.', 422, 'validation_error'), /validation failed.*fields/i],
    [new ApiError('Create a profile to complete onboarding', 404, 'profile_not_found'), /Create a profile to complete onboarding/],
    [new ApiError('expired', 401, 'http_401'), /session.*sign out and sign in/i],
    [new ApiError('forbidden', 403, 'http_403'), /session.*sign out and sign in/i],
    [new ApiError('Missing EXPO_PUBLIC_API_URL', null, 'configuration_error'), /API address.*configuration/i],
  ]) {
    let calls = 0, navigations = 0;
    const x = await setup(async () => { if (++calls === 1) throw error; return habit(); }, () => navigations++);
    const entered = draft();
    x.store.update(entered);
    await x.store.submit();
    await flush();
    assert.equal(calls, 1);
    assert.equal(navigations, 0);
    assert.equal(x.store.snapshot().busy, false);
    assert.equal(x.store.snapshot().created, false);
    assert.equal(x.store.snapshot().ambiguous, false);
    assert.match(x.store.snapshot().error, expected);
    assert.deepEqual(plain(x.store.snapshot().draft), plain(entered));
    await x.store.submit();
    assert.equal(calls, 2);
    assert.equal(navigations, 1);
    assert.equal(x.store.snapshot().error, null);
  }
});

test('uncertain requests explain possible success and never retry without another submit', async () => {
  for (const error of [
    new ApiError('deadline', null, 'request_timeout'),
    new ApiError('body deadline', 201, 'request_timeout'),
    new ApiError('deadline', 408, 'request_timeout'),
    new ApiError('offline', null, 'network_error'),
    new ApiError('unavailable', 503, 'http_503'),
    new ApiError('invalid response', 201, 'invalid_response'),
    new Error('private upstream detail'),
  ]) {
    let calls = 0, navigations = 0;
    const x = await setup(async () => { calls++; throw error; }, () => navigations++);
    const entered = draft();
    x.store.update(entered);
    await x.store.submit();
    assert.equal(x.store.snapshot().busy, false);
    assert.equal(x.store.snapshot().ambiguous, true);
    assert.match(x.store.snapshot().error, /may have succeeded.*Check My habits.*before submitting again/i);
    assert.ok(!x.store.snapshot().error.includes('private upstream detail'));
    assert.deepEqual(plain(x.store.snapshot().draft), plain(entered));
    x.store.start();
    x.event({ ...session('a'), access_token: 'refreshed-a-token' });
    x.store.update({ description: 'Still my draft' });
    await flush();
    await flush();
    assert.equal(calls, 1);
    assert.equal(navigations, 0);
    assert.equal(x.store.snapshot().ambiguous, true);
    assert.match(x.store.snapshot().error, /Check My habits/);
    await x.store.submit();
    assert.equal(calls, 2);
    assert.equal(navigations, 0);
  }
});

test('submission reads the current token rather than the token from opening the form', async () => {
  const supplied = [];
  const x = await setup(async current => { supplied.push(current); return habit(); });
  x.store.update(draft());
  const refreshed = { ...session('a'), access_token: 'current-a-token' };
  x.event(refreshed);
  await x.store.submit();
  assert.equal(supplied.length, 1);
  assert.equal(supplied[0], refreshed);
  assert.equal(supplied[0].access_token, 'current-a-token');
});

test('same-account token refresh preserves a pending draft and cannot release its submit guard', async () => {
  const write = deferred();
  let calls = 0, navigations = 0;
  const x = await setup(() => { calls++; return write.promise; }, () => navigations++);
  const entered = draft();
  x.store.update(entered);
  const pending = x.store.submit();
  x.event({ ...session('a'), access_token: 'refreshed-a-token' });
  assert.equal(x.store.snapshot().busy, true);
  assert.deepEqual(plain(x.store.snapshot().draft), plain(entered));
  await x.store.submit();
  assert.equal(calls, 1);
  write.resolve(habit());
  await pending;
  assert.equal(navigations, 1);
  assert.equal(x.store.snapshot().created, true);
});

test('account switching clears the old draft immediately and ignores old successes and failures', async () => {
  for (const outcome of ['success', 'error']) {
    const oldWrite = deferred(), newWrite = deferred(), nextProfile = deferred();
    let calls = 0, navigations = 0;
    const x = await setup(current => {
      calls++;
      return current.user.id === 'a' ? oldWrite.promise : newWrite.promise;
    }, () => navigations++, {
      readProfile: current => current.user.id === 'b' ? nextProfile.promise : Promise.resolve(profile('a')),
    });
    x.store.update(draft());
    const previous = x.store.submit();
    x.event(session('b'));
    assert.equal(x.sessions.snapshot().status, 'loading');
    assertEmpty(x.store);
    await x.store.submit();
    assert.equal(calls, 1);
    nextProfile.resolve(profile('b'));
    await flush();
    assertEmpty(x.store);
    const nextDraft = draft({ name: 'B habit', description: 'B private notes' });
    x.store.update(nextDraft);
    const current = x.store.submit();
    const beforeOldResponse = x.store.snapshot();
    if (outcome === 'success') oldWrite.resolve(habit());
    else oldWrite.reject(new ApiError('Old account request failed', 422, 'validation_error'));
    await previous;
    assert.equal(x.store.snapshot(), beforeOldResponse);
    assert.equal(x.store.snapshot().busy, true);
    assert.deepEqual(plain(x.store.snapshot().draft), plain(nextDraft));
    assert.equal(navigations, 0);
    newWrite.resolve(habit({ owner_id: 'b', name: 'B habit' }));
    await current;
    assert.equal(calls, 2);
    assert.equal(navigations, 1);
    assert.equal(x.store.snapshot().created, true);
  }
});

test('sign-out clears the draft before auth settles and ignores pending success or error', async () => {
  for (const outcome of ['success', 'error']) {
    const write = deferred(), logout = deferred();
    let calls = 0, navigations = 0;
    const x = await setup(() => { calls++; return write.promise; }, () => navigations++);
    x.store.update(draft());
    const pending = x.store.submit();
    x.auth.signOut = () => logout.promise;
    const signingOut = x.sessions.signOut();
    assert.equal(x.sessions.snapshot().status, 'loading');
    assertEmpty(x.store);
    if (outcome === 'success') write.resolve(habit());
    else write.reject(new ApiError('offline', null, 'network_error'));
    await pending;
    assertEmpty(x.store);
    logout.resolve({ error: null });
    await signingOut;
    x.store.update(draft());
    await x.store.submit();
    assertEmpty(x.store);
    assert.equal(calls, 1);
    assert.equal(navigations, 0);
  }
});

test('stopping clears the draft and ignores late creation results after reopening', async () => {
  for (const outcome of ['success', 'error']) {
    const oldWrite = deferred(), currentWrite = deferred();
    let calls = 0, navigations = 0;
    const x = await setup(() => ++calls === 1 ? oldWrite.promise : currentWrite.promise, () => navigations++);
    x.store.update(draft());
    const previous = x.store.submit();
    x.store.stop();
    assertEmpty(x.store);
    await x.store.submit();
    x.store.update(draft());
    assertEmpty(x.store);
    x.store.start();
    x.store.update(draft({ name: 'Reopened draft' }));
    const current = x.store.submit();
    const accepted = x.store.snapshot();
    if (outcome === 'success') oldWrite.resolve(habit());
    else oldWrite.reject(new ApiError('unavailable', 503, 'http_503'));
    await previous;
    assert.equal(x.store.snapshot(), accepted);
    assert.equal(navigations, 0);
    currentWrite.resolve(habit({ name: 'Reopened draft' }));
    await current;
    assert.equal(calls, 2);
    assert.equal(navigations, 1);
  }
});

test('foreign-owner responses never navigate and preserve the draft with an uncertain error', async () => {
  let calls = 0, navigations = 0;
  const x = await setup(async () => { calls++; return habit({ owner_id: 'b' }); }, () => navigations++);
  const entered = draft();
  x.store.update(entered);
  await x.store.submit();
  await flush();
  assert.equal(calls, 1);
  assert.equal(navigations, 0);
  assert.equal(x.store.snapshot().created, false);
  assert.equal(x.store.snapshot().busy, false);
  assert.equal(x.store.snapshot().ambiguous, true);
  assert.match(x.store.snapshot().error, /may have succeeded.*Check My habits/i);
  assert.deepEqual(plain(x.store.snapshot().draft), plain(entered));
});

test('signed-out sessions cannot edit or submit a protected create form', async () => {
  let calls = 0;
  const x = await setup(async () => { calls++; return habit(); }, undefined, { initial: null });
  x.store.update(draft());
  await x.store.submit();
  assertEmpty(x.store);
  assert.equal(calls, 0);
});
