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
  }).outputText, { exports, Error, require: path => lib(path.slice(2)), process: { env: {} } });
  return cache[name] = exports;
}
const { PendingExcusesStore } = lib('pending-excuses-store');
const { ExcuseDetailStore } = lib('excuse-detail-store');
const { ApiError } = lib('api');
const flush = () => new Promise(resolve => setImmediate(resolve));
const session = (id = 'friend', token = `${id}-token`) => ({ user: { id }, access_token: token });
function source(initial = session()) {
  let state = { status: 'ready', session: initial };
  const listeners = new Set();
  return { snapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    change: (next, status = next ? 'ready' : 'signed_out') => { state = { status, session: next }; listeners.forEach(listener => listener()); } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function excuse(status = 'pending', changes = {}) {
  return { id: 'excuse-1', occurrence_id: 'occurrence-1', habit_id: 'habit-1', owner_id: 'owner',
    explanation: 'Recovering from an injury', status, decision_source: status === 'pending' ? null : 'friend',
    decided_at: status === 'pending' ? null : '2026-10-19T10:00:00Z', decided_by: status === 'pending' ? null : 'friend',
    created_at: '2026-10-17T10:00:00Z', occurrence: { id: 'occurrence-1', habit_id: 'habit-1', owner_id: 'owner',
      local_date: '2026-10-17', timezone: 'America/Los_Angeles', closes_at: '2026-10-18T07:00:00Z',
      snapshot: { name: 'Stored reading habit', type: 'target', target: 20, unit: 'pages', schedule: 'daily', weekdays: [], reminder_times: [] },
      completed: false, progress: 3, state: status === 'pending' ? 'justification_pending' : status === 'approved' ? 'excused' : 'missed',
      created_at: '2026-10-17T07:00:00Z', updated_at: '2026-10-17T10:00:00Z' }, ...changes };
}
async function setup(overrides = {}, sessions = source()) {
  const calls = { list: [], read: [], decide: [] };
  const api = {
    listPendingExcuses: async (...args) => { calls.list.push(args); return overrides.list ? overrides.list(...args) : [excuse()]; },
    readExcuse: async (...args) => { calls.read.push(args); return overrides.read ? overrides.read(...args) : excuse(); },
    decideExcuse: async (...args) => { calls.decide.push(args); return overrides.decide ? overrides.decide(...args) : excuse(args[2] === 'approve' ? 'approved' : 'rejected'); },
  };
  const store = PendingExcusesStore.forSession(sessions, api);
  store.start(); await flush();
  return { store, sessions, api, calls };
}
function confirm(store, decision = 'approve') {
  const row = store.snapshot().excuses[0];
  store.requestDecision(row, decision);
  return store.snapshot().confirmation;
}

test('pending list keeps older dates and original stored progress; decision after midnight has no client deadline', async () => {
  let result = excuse();
  const x = await setup({ list: async () => result.status === 'pending' ? [result] : [], read: async () => result,
    decide: async () => result = excuse('approved') });
  assert.equal(x.store.snapshot().excuses[0].occurrence.local_date, '2026-10-17');
  assert.equal(x.store.snapshot().excuses[0].occurrence.progress, 3);
  assert.equal(x.store.canDecide(), true);
  await x.store.confirmDecision(confirm(x.store));
  assert.equal(x.calls.decide.length, 1);
  assert.equal(x.calls.decide[0][1], 'excuse-1');
  assert.equal(x.calls.decide[0][2], 'approve');
  assert.equal(x.calls.read[0][1], 'occurrence-1');
  assert.equal(x.store.snapshot().excuses.length, 0);
  assert.equal(x.store.snapshot().resolved.status, 'approved');
  assert.equal(x.store.snapshot().resolved.occurrence.completed, false);
  assert.equal(x.store.snapshot().resolved.occurrence.progress, 3);
});

test('decisions need a current explicit confirmation, including cancel/reopen and refresh', async () => {
  const x = await setup();
  await x.store.confirmDecision({ excuse: x.store.snapshot().excuses[0], decision: 'approve' });
  const old = confirm(x.store);
  x.store.cancelDecision(old);
  const current = confirm(x.store, 'reject');
  await x.store.confirmDecision(old);
  assert.equal(x.calls.decide.length, 0);
  await x.store.refresh();
  assert.equal(x.store.snapshot().confirmation, null);
  await x.store.confirmDecision(current);
  assert.equal(x.calls.decide.length, 0);
});

for (const decision of ['approve', 'reject']) test(`confirmed ${decision} removes all actionable rows until server reconciliation`, async () => {
  const write = deferred(), read = deferred();
  let decided = false;
  const x = await setup({ list: async () => decided ? [] : [excuse()], read: () => read.promise,
    decide: () => write.promise });
  const confirmation = confirm(x.store, decision);
  const pending = x.store.confirmDecision(confirmation);
  assert.equal(x.store.snapshot().excuses.length, 0);
  assert.equal(x.store.snapshot().confirmation, null);
  assert.equal(x.store.canDecide(), false);
  await x.store.confirmDecision(confirmation);
  await x.store.refresh();
  assert.equal(x.calls.decide.length, 1);
  assert.equal(x.calls.list.length, 1);
  const final = excuse(decision === 'approve' ? 'approved' : 'rejected');
  decided = true; write.resolve(final); await flush();
  assert.equal(x.store.snapshot().loading, true);
  assert.equal(x.store.canDecide(), false);
  read.resolve(final); await pending;
  assert.equal(x.store.snapshot().resolved.status, final.status);
  assert.equal(x.store.snapshot().refreshRequired, false);
});

for (const code of ['excuse_already_decided', 'request_timeout', 'network_error']) {
  test(`${code}: reconciliation shows the other friend's final rejection without false approval`, async () => {
    let writes = 0;
    const x = await setup({ list: async () => writes ? [] : [excuse()],
      decide: async () => { writes++; throw new ApiError('private diagnostic', code === 'excuse_already_decided' ? 409 : null, code); },
      read: async () => excuse('rejected', { decided_by: 'another-friend' }) });
    await x.store.confirmDecision(confirm(x.store));
    assert.equal(x.store.snapshot().resolved.status, 'rejected');
    assert.equal(x.store.snapshot().resolved.decided_by, 'another-friend');
    assert.match(x.store.snapshot().notice, /current server decision is rejected/);
    assert.doesNotMatch(x.store.snapshot().notice, /approval.*saved|private diagnostic/);
    assert.equal(x.store.snapshot().excuses.length, 0);
    assert.equal(x.calls.read.length, 1);
  });
}

test('timeout plus failed reconciliation keeps actions blocked across remount until a fresh read succeeds', async () => {
  let canRead = false;
  const x = await setup({ decide: async () => { throw new ApiError('timeout', null, 'request_timeout'); },
    read: async () => { if (!canRead) throw new ApiError('offline', null, 'network_error'); return excuse(); } });
  await x.store.confirmDecision(confirm(x.store));
  assert.equal(x.store.snapshot().refreshRequired, true);
  assert.equal(x.store.snapshot().excuses.length, 0);
  assert.equal(x.store.canDecide(), false);
  assert.equal(x.calls.list.length, 1, 'A failed reconciliation must not unlock through a pending-list read');
  x.store.stop();
  const remounted = PendingExcusesStore.forSession(x.sessions, x.api);
  assert.equal(remounted, x.store);
  remounted.start(); await flush();
  assert.equal(remounted.canDecide(), false);
  canRead = true; await remounted.refresh();
  assert.equal(x.calls.read.length, 3);
  assert.equal(remounted.canDecide(), true);
  assert.equal(remounted.snapshot().confirmation, null);
  assert.match(remounted.snapshot().notice, /still pending/);
  assert.equal(x.calls.decide.length, 1, 'Never automatically retry a decision');
});

for (const change of ['share revocation', 'friendship removal', 'archival']) {
  test(`${change} during a decision purges explanation and controls without reporting success`, async () => {
    let lost = false;
    const x = await setup({ list: async () => lost ? [] : [excuse()],
      decide: async () => { lost = true; throw new ApiError('Excuse not found', 404, 'excuse_not_found'); },
      read: async () => { throw new ApiError('Excuse not found', 404, 'excuse_not_found'); } });
    const confirmation = confirm(x.store);
    await x.store.confirmDecision(confirmation);
    assert.equal(x.store.snapshot().excuses.length, 0);
    assert.equal(x.store.snapshot().resolved, null);
    assert.equal(x.store.snapshot().confirmation, null);
    assert.match(x.store.snapshot().notice, /no longer accessible/);
    assert.doesNotMatch(x.store.snapshot().notice, /saved/);
    await x.store.confirmDecision(confirmation);
    assert.equal(x.calls.decide.length, 1);
  });
}

for (const event of ['account', 'token', 'signout', 'background']) {
  for (const outcome of ['success', 'failure']) test(`${event} clears old pending reads and ignores late ${outcome}`, async () => {
    const old = deferred(); let reads = 0;
    const x = await setup({ list: async () => ++reads === 1 ? [excuse()] : reads === 2 ? old.promise : [] });
    const refresh = x.store.refresh();
    assert.equal(x.store.snapshot().excuses.length, 0);
    if (event === 'account') x.sessions.change(session('friend-b'));
    if (event === 'token') x.sessions.change(session('friend', 'new-token'));
    if (event === 'signout') x.sessions.change(null);
    if (event === 'background') x.store.stop();
    await flush();
    const current = x.store.snapshot();
    if (outcome === 'success') old.resolve([excuse()]);
    else old.reject(new ApiError('private diagnostic', 404, 'excuse_not_found'));
    await refresh;
    assert.equal(x.store.snapshot(), current);
    assert.equal(x.store.snapshot().excuses.length, 0);
    assert.equal(x.store.snapshot().confirmation, null);
  });
}

test('in-flight write is isolated across account switching and re-read on returning to original account', async () => {
  const write = deferred();
  let final = false;
  const x = await setup({ list: async s => s.user.id === 'friend-b' || final ? [] : [excuse()],
    decide: () => write.promise, read: async () => excuse('approved') });
  const pending = x.store.confirmDecision(confirm(x.store));
  x.sessions.change(session('friend-b')); await flush();
  const otherAccount = x.store.snapshot();
  final = true; write.resolve(excuse('approved')); await pending;
  assert.equal(x.store.snapshot(), otherAccount);
  assert.equal(x.store.snapshot().notice, null);
  assert.equal(x.store.snapshot().resolved, null);
  x.sessions.change(session()); await flush();
  assert.equal(x.calls.read.length, 1);
  assert.equal(x.calls.read[0][0].user.id, 'friend');
  assert.equal(x.store.snapshot().resolved.status, 'approved');
  assert.equal(x.store.snapshot().refreshRequired, false);
});

test('returning while an old decision is still pending cannot submit again before settlement', async () => {
  const write = deferred();
  const x = await setup({ decide: () => write.promise, read: async () => excuse() });
  const old = confirm(x.store);
  const pending = x.store.confirmDecision(old);
  x.store.stop(); x.store.start(); await flush();
  assert.equal(x.store.snapshot().deciding, true);
  assert.equal(x.store.canDecide(), false);
  assert.equal(x.calls.list.length, 1);
  await x.store.confirmDecision(old);
  write.reject(new ApiError('timeout', null, 'request_timeout'));
  await pending;
  assert.equal(x.calls.read.length, 1);
  assert.equal(x.calls.decide.length, 1);
  assert.equal(x.store.canDecide(), true);
});

for (const invalid of ['own', 'decided', 'duplicate', 'wrong-occurrence']) {
  test(`invalid ${invalid} pending response never exposes a decision control`, async () => {
    const row = invalid === 'own' ? excuse('pending', { owner_id: 'friend' })
      : invalid === 'decided' ? excuse('approved')
        : invalid === 'wrong-occurrence' ? excuse('pending', { occurrence_id: 'wrong' }) : excuse();
    const x = await setup({ list: async () => invalid === 'duplicate' ? [row, row] : [row] });
    assert.equal(x.store.snapshot().excuses.length, 0);
    assert.equal(x.store.canDecide(), false);
    assert.match(x.store.snapshot().error, /Unable to load/);
  });
}

test('invalid decision acknowledgement does not claim success and reconciles the actual outcome', async () => {
  let wrote = false;
  const read = deferred();
  const x = await setup({ list: async () => wrote ? [] : [excuse()], read: () => read.promise,
    decide: async () => { wrote = true; return excuse('rejected', { decided_by: 'another-friend' }); } });
  const pending = x.store.confirmDecision(confirm(x.store)); await flush();
  assert.match(x.store.snapshot().notice, /could not confirm/);
  assert.doesNotMatch(x.store.snapshot().notice, /approval.*saved/);
  read.resolve(excuse('rejected', { decided_by: 'another-friend' })); await pending;
  assert.equal(x.store.snapshot().resolved.status, 'rejected');
});

for (const code of ['network_error', 'request_timeout', 'excuse_not_found']) {
  test(`detail ${code} clears private data immediately on refresh and supports retry`, async () => {
    const sessions = source(); let reads = 0;
    const store = new ExcuseDetailStore(sessions, { readExcuse: async (s, occurrenceId) => {
      assert.equal(occurrenceId, 'occurrence-1');
      if (++reads === 2) throw new ApiError('private diagnostic', code === 'excuse_not_found' ? 404 : null, code);
      return excuse();
    } }, 'occurrence-1');
    store.start(); await flush(); assert.ok(store.snapshot().excuse);
    const refresh = store.refresh(); assert.equal(store.snapshot().excuse, null);
    await refresh;
    assert.equal(store.snapshot().excuse, null);
    assert.doesNotMatch(store.snapshot().error, /private diagnostic/);
    await store.refresh(); assert.ok(store.snapshot().excuse);
    store.stop(); assert.equal(store.snapshot().excuse, null);
  });
}

for (const change of ['account', 'token', 'signout', 'background']) {
  test(`detail ${change} clears explanation and rejects an old successful read`, async () => {
    const sessions = source(); const old = deferred(); let reads = 0;
    const store = new ExcuseDetailStore(sessions, { readExcuse: () => ++reads === 1 ? old.promise
      : Promise.reject(new ApiError('denied', 404, 'excuse_not_found')) }, 'occurrence-1');
    store.start();
    if (change === 'account') sessions.change(session('friend-b'));
    if (change === 'token') sessions.change(session('friend', 'new-token'));
    if (change === 'signout') sessions.change(null);
    if (change === 'background') store.stop();
    await flush(); const current = store.snapshot();
    old.resolve(excuse()); await flush();
    assert.equal(store.snapshot(), current);
    assert.equal(store.snapshot().excuse, null);
  });
}

test('detail permits an owner to inspect a pending archived excuse without decision methods', async () => {
  const sessions = source(session('owner'));
  const store = new ExcuseDetailStore(sessions, { readExcuse: async () => excuse() }, 'occurrence-1');
  store.start(); await flush();
  assert.equal(store.snapshot().excuse.status, 'pending');
  assert.equal(store.confirmDecision, undefined);
});

for (const detail of ['final', 'inaccessible']) {
  test(`${detail} detail followed by a contradictory pending list keeps all decisions blocked`, async () => {
    let reconciled = false;
    const x = await setup({
      list: async () => reconciled ? [] : [excuse()],
      decide: async () => { throw new ApiError('Ambiguous result', null, 'request_timeout'); },
      read: async () => {
        if (detail === 'inaccessible') throw new ApiError('Excuse not found', 404, 'excuse_not_found');
        return excuse('rejected', { decided_by: 'another-friend' });
      },
    });
    await x.store.confirmDecision(confirm(x.store));
    assert.equal(x.store.snapshot().excuses.length, 0);
    assert.equal(x.store.snapshot().resolved, null);
    assert.equal(x.store.snapshot().refreshRequired, true);
    assert.equal(x.store.canDecide(), false);
    reconciled = true;
    await x.store.refresh();
    assert.equal(x.store.snapshot().refreshRequired, false);
    assert.equal(x.store.snapshot().excuses.length, 0);
    assert.equal(x.calls.decide.length, 1);
  });
}

test('a conflict proving finality followed by a stale pending read retains the guard until final reconciliation', async () => {
  let final = false;
  const x = await setup({
    list: async () => final ? [] : [excuse()],
    decide: async () => { throw new ApiError('Already decided', 409, 'excuse_already_decided'); },
    read: async () => excuse(final ? 'rejected' : 'pending'),
  });
  await x.store.confirmDecision(confirm(x.store));
  assert.equal(x.store.snapshot().excuses.length, 0);
  assert.equal(x.store.snapshot().refreshRequired, true);
  assert.equal(x.store.canDecide(), false);
  assert.equal(x.calls.list.length, 1, 'A stale detail cannot unlock via another pending list');
  x.store.stop(); x.store.start(); await flush();
  assert.equal(x.store.canDecide(), false);
  final = true;
  await x.store.refresh();
  assert.equal(x.store.snapshot().resolved.status, 'rejected');
  assert.equal(x.store.snapshot().refreshRequired, false);
  assert.equal(x.calls.decide.length, 1);
});
