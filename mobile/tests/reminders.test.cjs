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
  }).outputText, { exports, Error, Date, Intl, performance, process: { env: {} }, require: path => lib(path.slice(2)) });
  return cache[name] = exports;
}
const { ReminderService } = lib('reminder-service');
const { ApiError } = lib('api');
const { reminderEligible, serverNow, reminderLabels } = lib('reminder-rules');
const habit = 'aaaaaaaa-1111-4111-8111-111111111111';
const occurrence = 'bbbbbbbb-2222-4222-8222-222222222222';
const reminder = 'cccccccc-3333-4333-8333-333333333333';
const session = (id = 'sender-a', token = id) => ({ user: { id }, access_token: token });
const shared = (changes = {}) => ({ id: habit, owner: { user_id: 'owner' }, due_today: true,
  server_time: '2026-10-20T10:00:00Z', local_date: '2026-10-20', timezone: 'UTC',
  occurrence: { id: occurrence, local_date: '2026-10-20', completed: false, state: 'in_progress', closes_at: '2026-10-21T00:00:00Z' }, ...changes });
const result = (status = 'provider_accepted', changes = {}) => ({ id: reminder, habit_id: habit, occurrence_id: occurrence,
  status, reserved_at: '2026-10-20T10:00:00Z', retry_at: '2026-10-20T11:00:00Z', finished_at: status === 'reserved' ? null : '2026-10-20T10:00:01Z',
  device_count: 1, accepted_count: 0, failed_count: 0, unknown_count: 0, ...changes });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(overrides = {}, disk = new Map()) {
  let counter = 0;
  const calls = [];
  const deps = {
    load: async (sender, id) => JSON.parse(disk.get(`${sender}/${id}`) ?? 'null'),
    save: async (sender, id, rows) => { calls.push(['save', sender, id, JSON.stringify(rows)]); disk.set(`${sender}/${id}`, JSON.stringify(rows)); },
    newKey: () => `key-${++counter}`,
    clock: () => ({ wall: 1000, monotonic: 1000 }),
    readSharedHabit: async () => shared(),
    requestReminder: async (s, id, key) => { calls.push(['post', s.user.id, id, key]); return result(); },
    ...overrides,
  };
  const service = new ReminderService(deps);
  service.setSession(session());
  return { service, deps, disk, calls, state: () => service.snapshot()[habit], load: () => service.load(habit, 'sender-a'),
    send: (key, ack) => service.send(habit, 'sender-a', key, ack) };
}

for (const status of Object.keys(reminderLabels)) test(`persists and honestly exposes ${status}, without automatic resend`, async () => {
  const x = setup({ requestReminder: async () => result(status) });
  await x.load(); await x.send();
  assert.equal(x.state().requests[0].status, status);
  assert.equal(x.state().requests[0].retryAt, '2026-10-20T11:00:00Z');
  assert.equal(JSON.parse(x.disk.values().next().value)[0].result.status, status);
  await x.load();
  assert.equal(x.state().requests.length, 1);
  if (status.includes('accepted')) assert.match(reminderLabels[status], /does not confirm phone delivery/);
});

test('save completes before dispatch; overlapping clicks share one logical request', async () => {
  const saving = deferred(); let posts = 0;
  const x = setup({ save: () => saving.promise, requestReminder: async () => { posts++; return result(); } });
  await x.load(); const pending = x.send(); await flush(); await x.send();
  assert.equal(posts, 0); saving.resolve(); await pending; assert.equal(posts, 1);
  assert.equal(x.state().requests.length, 1);
});

test('storage failure never dispatches; explicit recovery saves the exact key before dispatch', async () => {
  const x = setup(); const save = x.deps.save;
  x.deps.save = async () => { throw Error('storage'); };
  await x.load(); await x.send(); assert.equal(x.calls.length, 0);
  const key = x.state().requests[0].key;
  assert.match(x.state().message, /could not be saved/);
  await x.send(); assert.equal(x.state().requests.length, 1);
  x.deps.save = save; await x.send(key);
  assert.deepEqual(x.calls.map(c => c[0]), ['save', 'post', 'save']);
  assert.equal(x.calls[1][3], key);
});

for (const failure of ['timeout', '503', 'malformed']) test(`${failure}: process restart and navigation recover the durable key without auto dispatch`, async () => {
  let posts = 0;
  const disk = new Map();
  const x = setup({ requestReminder: async () => {
    posts++;
    if (failure === 'malformed') return { secret: 'not a summary' };
    throw new ApiError('not shown', failure === '503' ? 503 : null, failure === '503' ? 'reminder_outcome_unavailable' : 'request_timeout', undefined, reminder);
  } }, disk);
  await x.load(); await x.send(); const key = x.state().requests[0].key;
  await x.send(); assert.equal(posts, 1); assert.equal(x.state().requests.length, 1);
  const recovered = setup({ requestReminder: async (_s, _h, replayKey) => { posts++; assert.equal(replayKey, key); return result(); } }, disk);
  await recovered.load(); assert.equal(posts, 1);
  await recovered.send(key); assert.equal(posts, 2); assert.equal(recovered.state().requests[0].status, 'provider_accepted');
});

test('lost final-result write leaves a recoverable original request after restart', async () => {
  const x = setup(); const save = x.deps.save; let writes = 0;
  x.deps.save = (...args) => ++writes === 1 ? save(...args) : Promise.reject(Error('storage'));
  await x.load(); await x.send();
  const restored = setup({}, x.disk); await restored.load();
  assert.equal(restored.state().requests[0].status, 'unconfirmed');
  await restored.send(restored.state().requests[0].key);
  assert.equal(restored.state().requests[0].status, 'provider_accepted');
});

for (const status of ['reserved', 'unknown']) test(`${status}: replay bypasses current eligibility and new request needs cooldown plus explicit duplicate acknowledgement`, async () => {
  const x = setup({ requestReminder: async () => result(status) }); await x.load(); await x.send();
  const key = x.state().requests[0].key;
  x.deps.readSharedHabit = async () => shared({ due_today: false, occurrence: null });
  await x.send(key); assert.equal(x.state().requests[0].status, status);
  await x.send(); assert.equal(x.state().requests.length, 1);
  x.deps.readSharedHabit = async () => shared({ server_time: '2026-10-20T11:01:00Z' });
  await x.send(); assert.match(x.state().message, /duplicate/); assert.equal(x.state().requests.length, 1);
  x.deps.requestReminder = async () => result('provider_accepted', { id: 'dddddddd-4444-4444-8444-444444444444', retry_at: '2026-10-20T12:01:00Z' });
  await x.send(undefined, key); assert.equal(x.state().requests.length, 2);
  assert.equal(x.state().requests[0].key, key, 'earlier unresolved key retained');
});

for (const retryAt of ['2026-10-20T11:00:00Z', undefined]) test(`429 respects server retry_at (${retryAt}) even across restart`, async () => {
  const x = setup({ requestReminder: async () => { throw new ApiError('private', 429, 'reminder_cooldown', retryAt); } });
  await x.load(); await x.send();
  assert.equal(x.state().requests[0].status, 'cooldown');
  const restored = setup({}, x.disk); await restored.load(); await restored.send();
  assert.equal(restored.calls.filter(c => c[0] === 'post').length, 0);
  if (retryAt) {
    restored.deps.newKey = () => 'explicit-new-key';
    restored.deps.readSharedHabit = async () => shared({ server_time: '2026-10-20T11:00:01Z' });
    await restored.send(); assert.equal(restored.calls.filter(c => c[0] === 'post').length, 1);
  }
});

test('corrupt or unreadable journals fail closed', async () => {
  for (const value of [{}, [{ key: 'x', status: 'unknown' }], [{ key: 'x', status: 'unconfirmed', retryAt: 'secret' }]]) {
    const x = setup({ load: async () => value }); await x.load(); await x.send();
    assert.equal(x.calls.length, 0); assert.equal(x.state().loaded, false);
  }
});

test('account change during save prevents old dispatch and isolates state and persisted recovery', async () => {
  const saved = deferred(); const x = setup({ save: () => saved.promise });
  await x.load(); const pending = x.send(); await flush();
  x.service.setSession(session('sender-b')); assert.equal(Object.keys(x.service.snapshot()).length, 0);
  await x.service.load(habit, 'sender-b'); assert.equal(x.state().requests.length, 0);
  saved.resolve(); await pending; assert.equal(x.calls.length, 0); assert.equal(x.state().requests.length, 0);
  await x.service.send(habit, 'sender-a'); assert.equal(x.calls.length, 0, 'captured old account callback blocked');
});

test('late old-account outcome is durable only in its own scope, never visible in the new account', async () => {
  const posted = deferred(); const x = setup({ requestReminder: () => posted.promise });
  await x.load(); const pending = x.send(); await flush();
  x.service.setSession(session('sender-b')); await x.service.load(habit, 'sender-b');
  posted.resolve(result()); await pending; assert.equal(x.state().requests.length, 0);
  x.service.setSession(session()); await x.load(); assert.equal(x.state().requests[0].status, 'provider_accepted');
});

test('permission loss hides outcomes without deleting keys, refreshed authorization can recover them', async () => {
  const x = setup({ requestReminder: async () => result('reserved') }); await x.load(); await x.send();
  const key = x.state().requests[0].key;
  x.deps.readSharedHabit = async () => { throw new ApiError('private', 404, 'habit_not_found'); };
  await x.send(key); assert.equal(x.state().requests.length, 0); assert.equal(x.state().blocked, true);
  assert.ok(x.disk.values().next().value.includes(key));
  x.deps.readSharedHabit = async () => shared(); await x.service.load(habit, 'sender-a', true); await x.send(key);
  assert.equal(x.state().requests[0].status, 'reserved');
});

test('eligibility uses owner date, original deadline, server time plus elapsed latency, and fails closed on clock rollback', () => {
  const start = { wall: 0, monotonic: 0 };
  assert.equal(reminderEligible(shared(), start, start), true);
  for (const state of ['completed', 'missed', 'excused', 'justification_pending']) {
    assert.equal(reminderEligible(shared({ occurrence: { ...shared().occurrence, state } }), start, start), false);
  }
  for (const changes of [{ due_today: false }, { timezone: 'invalid' }, { local_date: '2026-10-19' },
    { occurrence: { ...shared().occurrence, completed: true } }, { server_time: 'garbage' }]) {
    assert.equal(reminderEligible(shared(changes), start, start), false);
  }
  assert.equal(reminderEligible(shared(), start, { wall: 14 * 3600_000, monotonic: 1 }), false);
  assert.equal(reminderEligible(shared(), start, { wall: 1, monotonic: 14 * 3600_000 }), false);
  assert.equal(serverNow(shared().server_time, { wall: 10, monotonic: 10 }, { wall: 0, monotonic: 20 }), null);
  assert.equal(reminderEligible(shared({ timezone: 'Pacific/Kiritimati' }), start, start), false, 'owner date rolled over');
  assert.equal(reminderEligible(shared({ occurrence: { ...shared().occurrence, closes_at: '2026-10-20T10:00:01Z' } }), start, start), false);
});

test('concurrent hydration across account transitions shares one storage read and cannot overwrite a newer key', async () => {
  const storage = deferred(); let reads = 0;
  const x = setup({ load: () => { reads++; return storage.promise; } });
  const first = x.load(); x.service.setSession(null); x.service.setSession(session()); const second = x.load();
  storage.resolve(null); await Promise.all([first, second]); assert.equal(reads, 1);
  await x.send(); assert.equal(x.state().requests.length, 1);
  await x.service.load(habit, 'sender-a', true); assert.equal(x.state().requests.length, 1); assert.equal(reads, 1);
});

test('token renewal during dispatch hides stale results and recovers using newly authenticated credentials', async () => {
  const pending = deferred(); const x = setup({ requestReminder: () => pending.promise });
  await x.load(); const sending = x.send(); await flush();
  x.service.setSession(session('sender-a', 'renewed')); await x.load();
  pending.resolve(result('reserved')); await sending;
  assert.equal(x.state().loaded, false, 'old session result is not exposed directly');
  await x.load();
  x.deps.requestReminder = async (s, _h, key) => { assert.equal(s.access_token, 'renewed'); assert.equal(key, 'key-1'); return result(); };
  await x.send('key-1'); assert.equal(x.state().requests[0].status, 'provider_accepted');
});

for (const status of [401, 403, 404]) test(`dispatch ${status} hides results but never drops the durable original key`, async () => {
  const x = setup({ requestReminder: async () => { throw new ApiError('not displayed', status, 'denied'); } });
  await x.load(); await x.send();
  assert.equal(x.state().blocked, true); assert.equal(x.state().requests.length, 0);
  const restored = setup({}, x.disk); await restored.load();
  assert.equal(restored.state().requests[0].key, 'key-1'); assert.equal(restored.state().requests[0].status, 'unconfirmed');
});

test('habit scope is independent and persistence excludes unexpected server properties', async () => {
  const secondHabit = 'eeeeeeee-5555-4555-8555-555555555555';
  const x = setup({ readSharedHabit: async (_s, id) => shared({ id }), requestReminder: async (_s, id) => result('provider_accepted', { habit_id: id, private: 'never persist me' }) });
  await x.load(); await x.send(); await x.service.load(secondHabit, 'sender-a');
  assert.equal(x.service.snapshot()[secondHabit].requests.length, 0);
  await x.service.send(secondHabit, 'sender-a'); assert.equal(x.disk.size, 2);
  assert.ok([...x.disk.values()].every(value => !value.includes('never persist me')));
});
