const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Real validation and stores; mocked auth/API never read or modify live data.
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const exports = {};
  const source = ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, Error, require: path => load(path.slice(2)), process: { env: {} } });
  return cache[name] = exports;
}
const { EditHabitStore } = load('edit-habit-store');
const { SessionStore } = load('session-store');
const { HabitsStore } = load('habits-store');
const { ApiError } = load('api');
const plain = value => JSON.parse(JSON.stringify(value));
const session = id => ({ user: { id }, access_token: `${id}-token` });
const profile = id => ({ user_id: id, username: id });
const habit = (changes = {}) => ({
  id: 'habit-a', owner_id: 'a', name: 'Read', description: 'Evening reading', type: 'target', target: 20,
  unit: 'pages', schedule: 'selected', weekdays: [1, 7], reminder_times: ['08:00', '21:30'],
  created_at: '2026-10-11T12:00:00Z', updated_at: '2026-10-11T12:00:00Z', archived_at: null, ...changes,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
async function setup(readHabit = async () => habit(), updateHabit = async () => habit(), onSaved = () => {}, readProfile = async s => profile(s.user.id), archiveHabit = async () => habit({ archived_at: '2026-10-11T13:00:00Z' })) {
  let callback;
  const auth = {
    getSession: async () => ({ data: { session: session('a') } }),
    onAuthStateChange: cb => { callback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, { readProfile, createProfile: async s => profile(s.user.id) });
  await sessions.start();
  const store = new EditHabitStore(sessions, { readHabit, updateHabit, archiveHabit }, 'habit-a', onSaved);
  store.start();
  return { store, sessions, auth, event: s => callback('SIGNED_IN', s) };
}
function assertBlank(store, changes = {}) {
  assert.deepEqual(plain(store.snapshot()), {
    habit: null, draft: null, loading: false, saving: false, saved: false, error: null, ambiguous: false, unavailable: null, archive: null, ...changes,
  });
}

test('initial GET must finish before editing; unchanged or invalid fields never PATCH', async () => {
  const read = deferred();
  let writes = 0;
  const x = await setup(() => read.promise, async () => { writes++; return habit(); });
  assertBlank(x.store, { loading: true });
  x.store.update({ name: 'Too soon' });
  await x.store.save();
  assertBlank(x.store, { loading: true });
  read.resolve(habit());
  await flush();
  assert.deepEqual(plain(x.store.snapshot().draft), {
    name: 'Read', description: 'Evening reading', type: 'target', target: '20', unit: 'pages',
    schedule: 'selected', weekdays: [1, 7], reminderTimes: '08:00, 21:30',
  });
  await x.store.save();
  assert.match(x.store.snapshot().error, /No changes/i);
  x.store.update({ name: ' ', type: 'binary' });
  await x.store.save();
  assert.match(x.store.snapshot().error, /Name must be/);
  assert.equal(x.store.snapshot().draft.type, 'target');
  assert.equal(x.store.snapshot().draft.name, ' ');
  assert.equal(writes, 0);
});

test('missing or archived GET results prevent editing and saving; failed GET allows explicit retry', async () => {
  for (const reason of ['missing', 'archived']) {
    let writes = 0;
    const x = await setup(async () => {
      if (reason === 'missing') throw new ApiError('Not found', 404, 'habit_not_found');
      return habit({ archived_at: '2026-10-11T13:00:00Z' });
    }, async () => { writes++; return habit(); });
    await flush();
    assertBlank(x.store, { unavailable: reason });
    x.store.update({ name: 'Blocked edit' });
    await x.store.save();
    assert.equal(writes, 0);
  }
  let reads = 0;
  const x = await setup(async () => { if (++reads === 1) throw new ApiError('offline', null, 'network_error'); return habit(); });
  await flush();
  assert.equal(x.store.snapshot().draft, null);
  assert.match(x.store.snapshot().error, /load.*retry/i);
  assert.equal(reads, 1);
  await x.store.reload();
  assert.equal(reads, 2);
  assert.equal(x.store.snapshot().draft.name, 'Read');
  assert.equal(x.store.snapshot().error, null);
});

test('successful minimal PATCH returns to My habits and refocusing loads the updated list', async () => {
  let saved = habit(), list, navigations = 0, reads = 0;
  const supplied = [];
  const x = await setup(async () => saved, async (current, id, changes) => {
    supplied.push({ current, id, changes });
    saved = habit(changes);
    return saved;
  }, () => { navigations++; list.start(); });
  await flush();
  list = new HabitsStore(x.sessions, async () => { reads++; return [saved]; });
  list.start();
  await flush();
  assert.equal(list.snapshot().habits[0].name, 'Read');
  list.stop();
  x.store.update({ name: ' Read more ' });
  await x.store.save();
  await flush();
  assert.equal(supplied[0].current, x.sessions.snapshot().session);
  assert.equal(supplied[0].id, 'habit-a');
  assert.deepEqual(plain(supplied[0].changes), { name: 'Read more' });
  assert.equal(supplied.length, 1);
  assert.equal(navigations, 1);
  assert.equal(reads, 2);
  assert.equal(list.snapshot().habits[0].name, 'Read more');
  assert.equal(x.store.snapshot().saved, true);
});

test('save uses the current token and duplicate guards survive refresh and confirmed success', async () => {
  const write = deferred(), supplied = [];
  let navigations = 0;
  const x = await setup(undefined, (...args) => { supplied.push(args); return write.promise; }, () => navigations++);
  await flush();
  x.store.update({ name: 'Edited' });
  const current = { ...session('a'), access_token: 'current-token' };
  x.event(current);
  const pending = x.store.save();
  x.event({ ...session('a'), access_token: 'newer-token' });
  const locked = x.store.snapshot();
  x.store.update({ name: 'Not accepted while saving' });
  await Promise.all([x.store.save(), x.store.reload()]);
  assert.equal(x.store.snapshot(), locked);
  assert.equal(x.store.snapshot().saving, true);
  assert.equal(supplied.length, 1);
  assert.equal(supplied[0][0], current);
  write.resolve(habit({ name: 'Edited' }));
  await pending;
  await x.store.save();
  assert.equal(supplied.length, 1);
  assert.equal(navigations, 1);
});

test('definite save errors preserve edits and permit an explicit retry', async () => {
  let writes = 0;
  const x = await setup(undefined, async () => {
    if (++writes === 1) throw new ApiError('Check the selected weekdays.', 422, 'validation_error');
    return habit({ name: 'Edited' });
  });
  await flush();
  x.store.update({ name: 'Edited', description: 'Keep these notes', reminderTimes: '22:00' });
  const entered = plain(x.store.snapshot().draft);
  await x.store.save();
  await flush();
  assert.deepEqual(plain(x.store.snapshot().draft), entered);
  assert.equal(x.store.snapshot().saving, false);
  assert.equal(x.store.snapshot().ambiguous, false);
  assert.match(x.store.snapshot().error, /Check the selected weekdays/);
  assert.equal(writes, 1);
  await x.store.save();
  assert.equal(writes, 2);
  assert.equal(x.store.snapshot().saved, true);
});

test('PATCH missing/archived errors or an archived result block further saves', async () => {
  for (const outcome of ['missing', 'archived', 'archived response']) {
    let writes = 0, navigations = 0;
    const x = await setup(undefined, async () => {
      writes++;
      if (outcome === 'archived response') return habit({ archived_at: '2026-10-11T13:00:00Z' });
      throw new ApiError(outcome, outcome === 'missing' ? 404 : 409, `habit_${outcome === 'missing' ? 'not_found' : 'archived'}`);
    }, () => navigations++);
    await flush();
    x.store.update({ name: 'Edited' });
    await x.store.save();
    assertBlank(x.store, { unavailable: outcome === 'missing' ? 'missing' : 'archived' });
    x.store.update({ name: 'Another edit' });
    await x.store.save();
    assert.equal(writes, 1);
    assert.equal(navigations, 0);
  }
});

test('ambiguous saves explain possible success, preserve edits and never automatically PATCH again', async () => {
  for (const error of [
    new ApiError('timeout', null, 'request_timeout'), new ApiError('body timeout', 200, 'request_timeout'),
    new ApiError('offline', null, 'network_error'), new ApiError('unavailable', 503, 'http_503'),
    new ApiError('bad response', 200, 'invalid_response'),
  ]) {
    let writes = 0, navigations = 0;
    const x = await setup(undefined, async () => { writes++; throw error; }, () => navigations++);
    await flush();
    x.store.update({ name: 'Edited' });
    const entered = plain(x.store.snapshot().draft);
    await x.store.save();
    x.event({ ...session('a'), access_token: 'refreshed' });
    x.store.start();
    await flush();
    assert.equal(writes, 1);
    assert.equal(navigations, 0);
    assert.equal(x.store.snapshot().saving, false);
    assert.equal(x.store.snapshot().ambiguous, true);
    assert.match(x.store.snapshot().error, /may have succeeded.*Reload.*before deciding to save again/i);
    assert.deepEqual(plain(x.store.snapshot().draft), entered);
  }
});

test('explicit reload replaces edits only on success and preserves uncertainty when GET fails', async () => {
  let reads = 0, writes = 0;
  const x = await setup(async () => {
    if (++reads === 2) throw new ApiError('offline', null, 'network_error');
    return reads === 1 ? habit() : habit({ name: 'Saved on server', target: 30 });
  }, async () => { writes++; throw new ApiError('timeout', null, 'request_timeout'); });
  await flush();
  x.store.update({ name: 'Local changes', target: '30' });
  await x.store.save();
  const entered = plain(x.store.snapshot().draft);
  await x.store.reload();
  assert.deepEqual(plain(x.store.snapshot().draft), entered);
  assert.equal(x.store.snapshot().ambiguous, true);
  assert.match(x.store.snapshot().error, /load.*retry/i);
  await x.store.reload();
  assert.equal(x.store.snapshot().draft.name, 'Saved on server');
  assert.equal(x.store.snapshot().draft.target, '30');
  assert.equal(x.store.snapshot().ambiguous, false);
  assert.equal(x.store.snapshot().error, null);
  await x.store.save();
  assert.equal(writes, 1);
  assert.match(x.store.snapshot().error, /No changes/i);
});

test('overlapping GETs accept only the newest response or error', async () => {
  for (const outcome of ['success', 'error']) {
    const older = deferred(), newer = deferred();
    let reads = 0;
    const x = await setup(() => ++reads === 1 ? older.promise : newer.promise);
    const pending = x.store.reload();
    newer.resolve(habit({ name: 'Newest' }));
    await pending;
    const accepted = x.store.snapshot();
    if (outcome === 'success') older.resolve(habit({ name: 'Old' }));
    else older.reject(new ApiError('Old error', null, 'network_error'));
    await flush();
    assert.equal(x.store.snapshot(), accepted);
    assert.equal(accepted.draft.name, 'Newest');
  }
});

test('account switches and sign-out clear data immediately and invalidate pending GETs and PATCHes', async () => {
  for (const operation of ['read', 'save']) for (const transition of ['account', 'signout']) for (const outcome of ['success', 'error']) {
    const old = deferred(), authPending = deferred();
    let navigations = 0;
    const x = await setup(current => {
      if (current.user.id === 'b') throw new ApiError('missing', 404, 'habit_not_found');
      return operation === 'read' ? old.promise : Promise.resolve(habit());
    }, () => old.promise, () => navigations++, current => current.user.id === 'b' ? authPending.promise : Promise.resolve(profile('a')));
    let pending;
    if (operation === 'save') { await flush(); x.store.update({ name: 'Private draft' }); pending = x.store.save(); }
    let signingOut;
    if (transition === 'account') x.event(session('b'));
    else { x.auth.signOut = () => authPending.promise; signingOut = x.sessions.signOut(); }
    assertBlank(x.store);
    if (outcome === 'success') old.resolve(habit());
    else old.reject(new ApiError('Old failure', null, 'network_error'));
    await pending;
    await flush();
    assertBlank(x.store);
    authPending.resolve(transition === 'account' ? profile('b') : { error: null });
    await signingOut;
    await flush();
    assertBlank(x.store, transition === 'account' ? { unavailable: 'missing' } : {});
    assert.equal(navigations, 0);
  }
});

test('leaving and restarting invalidates both pending reads and saves', async () => {
  for (const operation of ['read', 'save']) for (const outcome of ['success', 'error']) {
    const old = deferred();
    let reads = 0, writes = 0, navigations = 0;
    const x = await setup(() => ++reads === 1 && operation === 'read' ? old.promise : Promise.resolve(habit({ name: `Read ${reads}` })),
      () => { writes++; return old.promise; }, () => navigations++);
    let pending;
    if (operation === 'save') { await flush(); x.store.update({ name: 'Edited' }); pending = x.store.save(); }
    x.store.stop();
    assertBlank(x.store);
    await Promise.all([x.store.save(), x.store.reload()]);
    x.store.start();
    await flush();
    const accepted = x.store.snapshot();
    if (outcome === 'success') old.resolve(habit({ name: 'Old result' }));
    else old.reject(new ApiError('Old error', 503, 'http_503'));
    await pending;
    await flush();
    assert.equal(x.store.snapshot(), accepted);
    assert.equal(accepted.draft.name, 'Read 2');
    assert.equal(reads, 2);
    assert.equal(writes, operation === 'save' ? 1 : 0);
    assert.equal(navigations, 0);
  }
});

test('owner or id mismatches fail GET safely and make PATCH uncertain without navigating', async () => {
  for (const wrong of [{ owner_id: 'b' }, { id: 'other-habit' }]) for (const operation of ['read', 'save']) {
    let navigations = 0;
    const x = await setup(async () => habit(operation === 'read' ? wrong : {}), async () => habit(wrong), () => navigations++);
    await flush();
    if (operation === 'save') {
      x.store.update({ name: 'Edited' });
      await x.store.save();
      assert.equal(x.store.snapshot().ambiguous, true);
      assert.equal(x.store.snapshot().draft.name, 'Edited');
      assert.equal(x.store.snapshot().saved, false);
    } else {
      assert.equal(x.store.snapshot().draft, null);
      assert.match(x.store.snapshot().error, /load.*retry/i);
    }
    assert.equal(navigations, 0);
  }
});

test('archive needs a fresh confirmation; cancellation preserves even unvalidated edits without writing', async () => {
  let archives = 0, saves = 0;
  const x = await setup(undefined, async () => { saves++; return habit(); }, undefined, undefined,
    async () => { archives++; return habit({ archived_at: '2026-10-11T13:00:00Z' }); });
  await flush();
  assert.equal(x.store.hasUnsavedEdits(), false);
  // Raw whitespace and invalid form input still require the discard warning.
  for (const patch of [{ name: 'Read ' }, { name: '', target: 'invalid' }]) {
    x.store.update(patch);
    assert.equal(x.store.hasUnsavedEdits(), true);
    const draft = plain(x.store.snapshot().draft);
    await x.store.confirmArchive();
    assert.equal(archives, 0);
    x.store.requestArchive();
    assert.equal(x.store.snapshot().archive.phase, 'confirming');
    x.store.update({ name: 'Not accepted during confirmation' });
    await Promise.all([x.store.save(), x.store.reload()]);
    assert.deepEqual(plain(x.store.snapshot().draft), draft);
    assert.equal(saves, 0);
    x.store.cancelArchive();
    assert.equal(x.store.snapshot().archive, null);
    assert.deepEqual(plain(x.store.snapshot().draft), draft);
    await x.store.confirmArchive();
    assert.equal(archives, 0);
  }
});

test('archive is blocked during loading, saving, and archived/missing states', async () => {
  const read = deferred(), save = deferred();
  let archives = 0;
  const x = await setup(() => read.promise, () => save.promise, undefined, undefined,
    async () => { archives++; return habit({ archived_at: '2026-10-11T13:00:00Z' }); });
  x.store.requestArchive();
  await x.store.confirmArchive();
  assert.equal(x.store.snapshot().archive, null);
  read.resolve(habit());
  await flush();
  x.store.update({ name: 'Edited' });
  const pending = x.store.save();
  x.store.requestArchive();
  await x.store.confirmArchive();
  assert.equal(x.store.snapshot().archive, null);
  assert.equal(archives, 0);
  save.resolve(habit({ name: 'Edited' }));
  await pending;
  x.store.requestArchive();
  await x.store.confirmArchive();
  assert.equal(archives, 0);

  for (const reason of ['archived', 'missing']) {
    const unavailable = await setup(async () => {
      if (reason === 'missing') throw new ApiError('missing', 404, 'habit_not_found');
      return habit({ archived_at: '2026-10-11T13:00:00Z' });
    }, undefined, undefined, undefined, async () => { archives++; return habit(); });
    await flush();
    unavailable.store.requestArchive();
    await unavailable.store.confirmArchive();
    assertBlank(unavailable.store, { unavailable: reason });
    assert.equal(archives, 0);
  }
});

test('confirmed archive uses the current token once, drops no PATCH, and refreshes Active after navigation', async () => {
  const response = deferred(), supplied = [], filters = [];
  let saved = habit(), list, navigations = 0, patches = 0;
  const x = await setup(async () => saved, async () => { patches++; return saved; }, () => { navigations++; list.start(); }, undefined,
    (...args) => { supplied.push(args); return response.promise; });
  await flush();
  list = new HabitsStore(x.sessions, async (_session, status) => {
    filters.push(status);
    return saved.archived_at === null ? [saved] : [];
  });
  list.start();
  await flush();
  assert.equal(list.snapshot().habits.length, 1);
  list.stop();
  x.store.update({ name: 'Unsaved edit' });
  x.store.requestArchive();
  const current = { ...session('a'), access_token: 'current-token' };
  x.event(current);
  const pending = x.store.confirmArchive();
  const locked = x.store.snapshot();
  assert.equal(locked.archive.phase, 'pending');
  x.event({ ...session('a'), access_token: 'newer-token' });
  x.store.requestArchive();
  x.store.cancelArchive();
  x.store.update({ name: 'Blocked' });
  await Promise.all([x.store.confirmArchive(), x.store.save(), x.store.reload()]);
  assert.equal(x.store.snapshot(), locked);
  assert.equal(supplied.length, 1);
  assert.equal(supplied[0][0], current);
  assert.equal(supplied[0][1], 'habit-a');
  saved = habit({ archived_at: '2026-10-11T13:00:00Z' });
  response.resolve(saved);
  await pending;
  await flush();
  assert.equal(patches, 0);
  assert.equal(navigations, 1);
  assert.equal(x.store.snapshot().saved, true);
  assert.deepEqual(filters, ['active', 'active']);
  assert.equal(list.snapshot().habits.length, 0);
  x.store.requestArchive();
  await x.store.confirmArchive();
  assert.equal(supplied.length, 1);
});

test('definite archive failure retains edits and requires another confirmation before retry', async () => {
  let archives = 0, navigations = 0;
  const x = await setup(undefined, undefined, () => navigations++, undefined, async () => {
    if (++archives === 1) throw new ApiError('Please sign in again.', 401, 'http_401');
    return habit({ archived_at: '2026-10-11T13:00:00Z' });
  });
  await flush();
  x.store.update({ name: 'Unfinished draft', target: 'invalid' });
  const draft = plain(x.store.snapshot().draft);
  x.store.requestArchive();
  await x.store.confirmArchive();
  assert.equal(x.store.snapshot().archive.phase, 'failed');
  assert.equal(x.store.snapshot().archive.ambiguous, false);
  assert.match(x.store.snapshot().archive.error, /sign in/i);
  assert.deepEqual(plain(x.store.snapshot().draft), draft);
  assert.equal(navigations, 0);
  await x.store.confirmArchive();
  x.store.start();
  x.event({ ...session('a'), access_token: 'refreshed-token' });
  await flush();
  assert.equal(archives, 1);
  x.store.requestArchive();
  assert.equal(x.store.snapshot().archive.phase, 'confirming');
  await x.store.confirmArchive();
  assert.equal(archives, 2);
  assert.equal(navigations, 1);
});

test('ambiguous archive failures explain uncertainty, block editing and never automatically repeat mutations', async () => {
  for (const error of [
    new ApiError('deadline', null, 'request_timeout'), new ApiError('body deadline', 200, 'request_timeout'),
    new ApiError('offline', null, 'network_error'), new ApiError('unavailable', 503, 'http_503'),
    new ApiError('invalid result', 200, 'invalid_response'), new Error('private upstream information'),
  ]) {
    let archives = 0, saves = 0, navigations = 0;
    const x = await setup(undefined, async () => { saves++; return habit(); }, () => navigations++, undefined,
      async () => { archives++; throw error; });
    await flush();
    x.store.update({ description: 'Keep my private notes' });
    const draft = plain(x.store.snapshot().draft);
    x.store.requestArchive();
    await x.store.confirmArchive();
    assert.equal(x.store.snapshot().archive.phase, 'failed');
    assert.equal(x.store.snapshot().archive.ambiguous, true);
    assert.match(x.store.snapshot().archive.error, /may have succeeded.*refresh.*before.*retry/i);
    assert.ok(!x.store.snapshot().archive.error.includes('private upstream information'));
    x.store.update({ name: 'Blocked until server state is known' });
    await Promise.all([x.store.save(), x.store.confirmArchive()]);
    x.store.start();
    x.event({ ...session('a'), access_token: 'refreshed-token' });
    await flush();
    assert.deepEqual(plain(x.store.snapshot().draft), draft);
    assert.equal(archives, 1);
    assert.equal(saves, 0);
    assert.equal(navigations, 0);
  }
});

test('explicit refresh after archive uncertainty preserves failed reads then accepts active or archived server state', async () => {
  for (const archived of [false, true]) {
    let reads = 0, archives = 0;
    const x = await setup(async () => {
      if (++reads === 2) throw new ApiError('offline', null, 'network_error');
      return habit(reads > 2 ? { name: 'Server configuration', archived_at: archived ? '2026-10-11T13:00:00Z' : null } : {});
    }, undefined, undefined, undefined, async () => { archives++; throw new ApiError('timeout', null, 'request_timeout'); });
    await flush();
    x.store.update({ name: 'Local draft' });
    const draft = plain(x.store.snapshot().draft);
    x.store.requestArchive();
    await x.store.confirmArchive();
    await x.store.reload();
    assert.equal(x.store.snapshot().archive.ambiguous, true);
    assert.deepEqual(plain(x.store.snapshot().draft), draft);
    assert.match(x.store.snapshot().error, /load.*retry/i);
    await x.store.save();
    assert.equal(archives, 1);
    await x.store.reload();
    assert.equal(reads, 3);
    assert.equal(x.store.snapshot().archive, null);
    if (archived) assertBlank(x.store, { unavailable: 'archived' });
    else {
      assert.equal(x.store.snapshot().draft.name, 'Server configuration');
      assert.equal(x.store.hasUnsavedEdits(), false);
      x.store.update({ name: 'New editable draft' });
      assert.equal(x.store.snapshot().draft.name, 'New editable draft');
    }
    assert.equal(archives, 1);
  }
});

test('archive uncertainty survives a cancelled or definitely failed retry until the server is refreshed', async () => {
  let archives = 0, saves = 0;
  const x = await setup(undefined, async () => { saves++; return habit(); }, undefined, undefined, async () => {
    if (++archives === 1) throw new ApiError('timeout', null, 'request_timeout');
    throw new ApiError('Please sign in again.', 401, 'http_401');
  });
  await flush();
  x.store.update({ name: 'Local edit' });
  x.store.requestArchive();
  await x.store.confirmArchive();
  x.store.requestArchive();
  x.store.cancelArchive();
  assert.equal(x.store.snapshot().archive.ambiguous, true);
  assert.equal(x.store.snapshot().archive.phase, 'failed');
  x.store.requestArchive();
  await x.store.confirmArchive();
  assert.equal(x.store.snapshot().archive.ambiguous, true);
  assert.match(x.store.snapshot().archive.error, /may have succeeded.*refresh/i);
  x.store.update({ name: 'Blocked change' });
  await x.store.save();
  assert.equal(saves, 0);
  assert.equal(x.store.snapshot().draft.name, 'Local edit');
  assert.equal(archives, 2);
  await x.store.refreshServerState();
  assert.equal(x.store.snapshot().archive, null);
  assert.equal(x.store.snapshot().draft.name, 'Read');
  assert.equal(archives, 2);
});

test('rapid server refresh presses after an uncertain archive make only one recovery GET', async () => {
  const response = deferred();
  let reads = 0, archives = 0;
  const x = await setup(() => ++reads === 1 ? Promise.resolve(habit()) : response.promise, undefined, undefined, undefined,
    async () => { archives++; throw new ApiError('timeout', null, 'request_timeout'); });
  await flush();
  x.store.requestArchive();
  await x.store.confirmArchive();
  const pending = x.store.refreshServerState();
  await x.store.refreshServerState();
  assert.equal(reads, 2);
  assert.equal(x.store.snapshot().loading, true);
  response.resolve(habit());
  await pending;
  assert.equal(x.store.snapshot().loading, false);
  assert.equal(x.store.snapshot().archive, null);
  assert.equal(archives, 1);
});

test('missing archive response blocks editing; wrong identity or active response remains uncertain', async () => {
  for (const outcome of ['missing', 'wrong owner', 'wrong id', 'active']) {
    let navigations = 0;
    const x = await setup(undefined, undefined, () => navigations++, undefined, async () => {
      if (outcome === 'missing') throw new ApiError('missing', 404, 'habit_not_found');
      return habit({ archived_at: outcome === 'active' ? null : '2026-10-11T13:00:00Z',
        ...(outcome === 'wrong owner' ? { owner_id: 'b' } : outcome === 'wrong id' ? { id: 'other' } : {}) });
    });
    await flush();
    x.store.requestArchive();
    await x.store.confirmArchive();
    if (outcome === 'missing') assertBlank(x.store, { unavailable: 'missing' });
    else {
      assert.equal(x.store.snapshot().archive.ambiguous, true);
      assert.equal(x.store.snapshot().saved, false);
    }
    assert.equal(navigations, 0);
  }
});

test('account changes, sign-out and navigation clear archive state and ignore late success or errors', async () => {
  for (const transition of ['account', 'signout', 'navigation']) for (const outcome of ['success', 'error']) {
    const old = deferred(), authPending = deferred();
    let archives = 0, navigations = 0;
    const x = await setup(async current => {
      if (current.user.id === 'b') throw new ApiError('missing', 404, 'habit_not_found');
      return habit();
    }, undefined, () => navigations++, current => current.user.id === 'b' ? authPending.promise : Promise.resolve(profile('a')),
    () => { archives++; return old.promise; });
    await flush();
    x.store.update({ name: 'Account A private draft' });
    x.store.requestArchive();
    const pending = x.store.confirmArchive();
    let signingOut;
    if (transition === 'account') x.event(session('b'));
    else if (transition === 'signout') { x.auth.signOut = () => authPending.promise; signingOut = x.sessions.signOut(); }
    else x.store.stop();
    assertBlank(x.store);
    await x.store.confirmArchive();
    x.store.requestArchive();
    assert.equal(archives, 1);
    if (transition === 'navigation') { x.store.start(); await flush(); }
    const accepted = x.store.snapshot();
    if (outcome === 'success') old.resolve(habit({ archived_at: '2026-10-11T13:00:00Z' }));
    else old.reject(new ApiError('Old failure', null, 'network_error'));
    await pending;
    assert.equal(x.store.snapshot(), accepted);
    assert.equal(navigations, 0);
    if (transition !== 'navigation') {
      authPending.resolve(transition === 'account' ? profile('b') : { error: null });
      await signingOut;
      await flush();
      assertBlank(x.store, transition === 'account' ? { unavailable: 'missing' } : {});
    }
  }
});

test('stale archive confirmation after an account change or navigation cannot make a request', async () => {
  for (const transition of ['account', 'navigation']) {
    let archives = 0;
    const x = await setup(async current => habit({ owner_id: current.user.id }), undefined, undefined, undefined,
      async () => { archives++; return habit({ archived_at: '2026-10-11T13:00:00Z' }); });
    await flush();
    x.store.requestArchive();
    if (transition === 'account') x.event(session('b'));
    else { x.store.stop(); x.store.start(); }
    await flush();
    await x.store.confirmArchive();
    assert.equal(x.store.snapshot().archive, null);
    assert.equal(archives, 0);
  }
});
