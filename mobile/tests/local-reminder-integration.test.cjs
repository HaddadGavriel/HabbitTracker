const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Cross-feature tests execute the production stores and scheduling coordinator.
// Only Auth, HTTP, persistence and the native bridge are replaced. The native
// adapter suite separately verifies actual alarm times, DST and durable cursors.
const cache = {};
function lib(name) {
  if (cache[name]) return cache[name];
  const exports = {};
  cache[name] = exports;
  const source = ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    exports, Error, Date, Promise, performance, process: { env: {} },
    setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout,
    require: path => lib(path.slice(2)),
  });
  return exports;
}
const { SessionStore } = lib('session-store');
const { CreateHabitStore } = lib('create-habit-store');
const { EditHabitStore } = lib('edit-habit-store');
const { HabitsStore } = lib('habits-store');
const { TodayStore } = lib('today-store');
const { LocalReminderService } = lib('local-reminder-service');
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const H = 'dddddddd-4444-4444-8444-444444444444';
const O = 'eeeeeeee-5555-4555-8555-555555555555';
const clone = value => JSON.parse(JSON.stringify(value));
const session = (id = A) => ({ user: { id }, access_token: `${id}-token` });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 12; i++) await flush(); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const draft = (changes = {}) => ({ name: 'Read', description: '', type: 'binary', target: '', unit: '',
  schedule: 'daily', weekdays: [], reminderTimes: '08:00, 18:00', ...changes });

function server() {
  const state = { date: '2026-10-21', time: '2026-10-21T12:00:00.000Z', timezone: 'UTC',
    habit: null, occurrence: null, excuse: null, restoreEligible: true, writes: 0 };
  const profile = owner => ({ user_id: owner, username: owner === A ? 'alice' : 'bob', display_name: null,
    timezone: state.timezone, created_at: state.time, updated_at: state.time });
  function snapshot(habit) {
    const { name, description, type, target, unit, schedule, weekdays, reminder_times } = habit;
    return clone({ name, description, type, target, unit, schedule, weekdays, reminder_times });
  }
  function occurrence(habit) {
    const tomorrow = new Date(`${state.date}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return { id: O, habit_id: habit.id, owner_id: habit.owner_id, local_date: state.date,
      timezone: state.timezone, closes_at: tomorrow.toISOString(), progress: 0, completed: false,
      state: 'in_progress', snapshot: snapshot(habit), created_at: state.time, updated_at: state.time };
  }
  const api = {
    readProfile: async s => profile(s.user.id), createProfile: async s => profile(s.user.id),
    updateProfile: async (s, input) => { state.timezone = input.timezone; state.writes++; return profile(s.user.id); },
    createHabit: async (s, input) => {
      state.writes++;
      state.habit = { id: H, owner_id: s.user.id, ...clone(input), archived_at: null,
        created_at: state.time, updated_at: state.time };
      state.occurrence = occurrence(state.habit);
      return clone(state.habit);
    },
    readHabit: async () => clone(state.habit),
    updateHabit: async (_s, _id, changes) => {
      state.writes++; Object.assign(state.habit, clone(changes)); return clone(state.habit);
    },
    archiveHabit: async () => { state.writes++; state.habit.archived_at = state.time; return clone(state.habit); },
    restoreHabit: async () => { state.writes++; state.habit.archived_at = null; return clone(state.habit); },
    listHabits: async (_s, status) => state.habit && (status === 'archived') === !!state.habit.archived_at ? [clone(state.habit)] : [],
    readToday: async () => ({ local_date: state.date, timezone: state.timezone, server_time: state.time,
      occurrences: state.occurrence && !state.habit.archived_at ? [clone(state.occurrence)] : [] }),
    writeCompletion: async (_s, _id, completed) => {
      state.writes++; Object.assign(state.occurrence, { completed, state: completed ? 'completed' : 'in_progress', updated_at: state.time });
      return clone(state.occurrence);
    },
    writeProgress: async (_s, _id, progress) => {
      state.writes++; const completed = progress >= state.occurrence.snapshot.target;
      Object.assign(state.occurrence, { progress, completed, state: completed ? 'completed' : 'in_progress', updated_at: state.time });
      return clone(state.occurrence);
    },
    submitExcuse: async (_s, _id, explanation) => {
      state.writes++; Object.assign(state.occurrence, { completed: false, state: 'excused', updated_at: state.time });
      state.excuse = { id: 'ffffffff-6666-4666-8666-666666666666', occurrence_id: O, habit_id: H, owner_id: A,
        explanation, status: 'approved', decision_source: 'automatic', decided_by: null,
        decided_at: state.time, created_at: state.time, occurrence: clone(state.occurrence) };
      return clone(state.excuse);
    },
    readExcuse: async () => clone(state.excuse),
    readPlan: async s => {
      const h = state.habit, o = state.occurrence;
      const next = new Date(`${state.date}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
      return { version: 1, owner_id: s.user.id, server_time: state.time, local_date: state.date, timezone: state.timezone,
        effective: h && h.owner_id === s.user.id && !h.archived_at && o && !o.completed && o.state === 'in_progress' && state.restoreEligible
          ? [{ habit_id: H, local_date: o.local_date, timezone: o.timezone, closes_at: o.closes_at, reminder_times: clone(o.snapshot.reminder_times) }] : [],
        future: h && h.owner_id === s.user.id && !h.archived_at
          ? [{ habit_id: H, schedule: h.schedule, weekdays: clone(h.weekdays), reminder_times: clone(h.reminder_times), eligible_from: next.toISOString().slice(0, 10) }] : [] };
    },
  };
  return { state, api, occurrence };
}

function nativeBoundary() {
  const state = { owner: null, lease: null, plan: null, calls: [], failures: [], active: 0, maximumActive: 0, generation: 0 };
  const run = (name, operation) => async (...args) => {
    state.calls.push({ name, args: clone(args) }); state.active++; state.maximumActive = Math.max(state.maximumActive, state.active);
    try { await Promise.resolve(); return await operation(...args); } finally { state.active--; }
  };
  const api = {
    clock: run('clock', () => 1000),
    acquire: run('acquire', owner => {
      if (owner !== state.owner || !state.lease) { state.owner = owner; state.lease = `lease-${++state.generation}`; state.plan = null; }
      return state.lease;
    }),
    reconcile: run('reconcile', (lease, json) => {
      if (lease !== state.lease) return { status: 'stale_lease' };
      state.plan = JSON.parse(json);
      const failure = state.failures.shift();
      if (failure instanceof Error) throw failure;
      return failure ?? { status: 'scheduled_os_limited' };
    }),
    suppress: run('suppress', (lease, habitId, localDate) => {
      if (lease !== state.lease) return { status: 'stale_lease' };
      if (state.plan) {
        state.plan.effective = state.plan.effective.filter(row => row.habit_id !== habitId || (localDate && row.local_date !== localDate));
        if (!localDate) state.plan.future = state.plan.future.filter(row => row.habit_id !== habitId);
      }
      return { status: 'scheduled_os_limited' };
    }),
    cancel: run('cancel', lease => {
      if (lease !== state.lease) return { status: 'stale_lease' };
      state.owner = state.lease = state.plan = null; return { status: 'cancelled' };
    }),
    cancelAll: run('cancelAll', () => { state.owner = state.lease = state.plan = null; return { status: 'cancelled' }; }),
    status: run('status', () => ({ status: state.lease ? 'scheduled_os_limited' : 'cancelled' })),
  };
  return { state, api };
}

async function setup(t, options = {}) {
  const backend = options.backend ?? server(), native = options.native ?? nativeBoundary();
  const storage = options.storage ?? { enabled: null };
  const requests = [], control = { allowed: true, readPlan: null };
  const reminders = new LocalReminderService({ native: native.api,
    readPlan: async s => { requests.push(s.user.id); return (control.readPlan ?? backend.api.readPlan)(s); },
    permission: async () => control.allowed,
    loadEnabled: async () => storage.enabled, saveEnabled: async value => { storage.enabled = value; },
  });
  let authEvent;
  const auth = { getSession: async () => ({ data: { session: options.session === undefined ? session() : options.session } }),
    onAuthStateChange: callback => { authEvent = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }), refreshSession: async () => ({ data: { session: session() }, error: null }) };
  const sessions = new SessionStore(auth, backend.api);
  const sync = () => { void reminders.setSession(sessions.snapshot()); };
  sessions.subscribe(sync); sync(); await sessions.start(); await settle();
  if (options.enable !== false) { await reminders.enable(); await settle(); }
  const stores = [];
  t.after(() => { stores.forEach(store => store.stop()); sessions.stop(); });
  return { backend, native, storage, control, reminders, sessions, requests,
    event: value => authEvent(value ? 'SIGNED_IN' : 'SIGNED_OUT', value),
    create: async (changes = {}) => {
      const store = new CreateHabitStore(sessions, backend.api.createHabit, () => {}, reminders);
      stores.push(store); store.start(); store.update(draft(changes)); await store.submit(); await settle(); return store;
    },
    edit: async () => { const store = new EditHabitStore(sessions, backend.api, H, () => {}, reminders);
      stores.push(store); store.start(); await settle(); return store; },
    habits: async () => { const store = new HabitsStore(sessions, backend.api.listHabits, backend.api.restoreHabit, reminders);
      stores.push(store); store.start(); await settle(); return store; },
    today: async () => { const store = new TodayStore(sessions, backend.api.readToday, backend.api.writeCompletion,
      backend.api.writeProgress, () => 1000, backend.api, reminders);
      stores.push(store); store.start(); await settle(); return store; },
  };
}

test('create, edit, archive and restore reconcile through real stores while preserving today snapshots', async t => {
  const x = await setup(t);
  const create = await x.create();
  assert.equal(create.snapshot().created, true);
  assert.deepEqual(x.native.state.plan.effective[0].reminder_times, ['08:00', '18:00']);
  const edit = await x.edit();
  edit.update({ reminderTimes: '09:00, 19:00' }); await edit.save(); await settle();
  assert.equal(edit.snapshot().saved, true);
  assert.deepEqual(x.native.state.plan.effective[0].reminder_times, ['08:00', '18:00']);
  assert.deepEqual(x.native.state.plan.future[0].reminder_times, ['09:00', '19:00']);
  const archive = await x.edit(); archive.requestArchive(); await archive.confirmArchive(); await settle();
  assert.deepEqual(x.native.state.plan.effective, []); assert.deepEqual(x.native.state.plan.future, []);
  assert.ok(x.native.state.calls.some(call => call.name === 'suppress' && call.args[1] === H && !call.args[2]));
  const list = await x.habits(); list.setStatus('archived'); await settle();
  const archived = list.snapshot().habits[0]; list.requestRestore(archived); await list.confirmRestore(archived); await settle();
  assert.equal(list.snapshot().restoreError, null);
  assert.deepEqual(x.native.state.plan.effective[0].reminder_times, ['08:00', '18:00']);
  assert.deepEqual(x.native.state.plan.future[0].reminder_times, ['09:00', '19:00']);
  assert.equal(x.native.state.maximumActive, 1);
});

test('complete suppresses only the confirmed date even offline; undo obtains current server eligibility', async t => {
  const x = await setup(t); await x.create(); const today = await x.today();
  x.control.readPlan = async () => { throw new Error('offline'); };
  await today.setCompletion(today.snapshot().today.occurrences[0], true); await settle();
  assert.equal(today.snapshot().today.occurrences[0].completed, true);
  assert.deepEqual(x.native.state.plan.effective, []);
  assert.equal(x.native.state.plan.future[0].habit_id, H);
  assert.ok(x.native.state.calls.some(call => call.name === 'suppress' && call.args[1] === H && call.args[2] === '2026-10-21'));
  assert.equal(today.snapshot().completions[O]?.error ?? null, null);
  x.backend.state.time = '2026-10-21T17:00:00.000Z'; x.control.readPlan = null;
  await today.setCompletion(today.snapshot().today.occurrences[0], false); await settle();
  assert.equal(today.snapshot().today.occurrences[0].completed, false);
  assert.equal(x.native.state.plan.server_time, x.backend.state.time);
  assert.equal(x.native.state.plan.effective[0].local_date, '2026-10-21');
});

test('target completion and reduction use the occurrence snapshot, not an edited future target', async t => {
  const x = await setup(t); await x.create({ type: 'target', target: '10', unit: 'pages' });
  const edit = await x.edit(); edit.update({ target: '5' }); await edit.save(); await settle();
  const today = await x.today();
  assert.equal(today.snapshot().today.occurrences[0].snapshot.target, 10);
  today.setProgressDraft(today.snapshot().today.occurrences[0], '10'); await today.setProgress(today.snapshot().today.occurrences[0]); await settle();
  assert.deepEqual(x.native.state.plan.effective, []); assert.equal(x.native.state.plan.future.length, 1);
  today.setProgressDraft(today.snapshot().today.occurrences[0], '6'); await today.setProgress(today.snapshot().today.occurrences[0]); await settle();
  assert.equal(today.snapshot().today.occurrences[0].completed, false);
  assert.equal(x.native.state.plan.effective.length, 1);
});

test('confirmed excuse submission locks today without dropping future reminder rules', async t => {
  const x = await setup(t); await x.create(); const today = await x.today();
  const row = today.snapshot().today.occurrences[0]; today.openExcuse(row); today.setExplanation(row, 'Recovering today');
  x.control.readPlan = async () => { throw new Error('connection lost after successful save'); };
  await today.submitExplanation(row); await settle();
  assert.equal(today.snapshot().today.occurrences[0].state, 'excused');
  assert.equal(today.snapshot().excuses[O].result.status, 'approved');
  assert.deepEqual(x.native.state.plan.effective, []); assert.equal(x.native.state.plan.future.length, 1);
  assert.equal(today.completionAction(today.snapshot().today.occurrences[0]), null);
});

test('successful creation remains successful after a partial native scheduling failure and retry never recreates it', async t => {
  const x = await setup(t);
  x.native.state.failures.push({ status: 'repair_required' });
  const create = await x.create();
  assert.equal(create.snapshot().created, true); assert.equal(create.snapshot().ambiguous, false); assert.equal(create.snapshot().error, null);
  const writes = x.backend.state.writes; await create.submit(); assert.equal(x.backend.state.writes, writes);
  assert.match(JSON.stringify(x.reminders.snapshot()), /repair|fail|retry|error/i);
  await x.reminders.refresh(); await settle();
  assert.equal(x.backend.state.writes, writes); assert.equal(x.native.state.plan.effective.length, 1);
});

test('notification denial cancels local work but never blocks habit creation or progress', async t => {
  const x = await setup(t, { enable: false }); x.control.allowed = false;
  await x.reminders.enable(); await settle();
  const create = await x.create({ type: 'target', target: '10', unit: 'pages' }); const today = await x.today();
  today.setProgressDraft(today.snapshot().today.occurrences[0], '4'); await today.setProgress(today.snapshot().today.occurrences[0]); await settle();
  assert.equal(create.snapshot().created, true); assert.equal(today.snapshot().today.occurrences[0].progress, 4);
  assert.equal(x.native.state.plan, null); assert.match(JSON.stringify(x.reminders.snapshot()), /denied|blocked/);
});

test('restoration uses server eligibility and cannot invent an absent same-day occurrence', async t => {
  const x = await setup(t); await x.create();
  const edit = await x.edit(); edit.requestArchive(); await edit.confirmArchive(); await settle();
  x.backend.state.restoreEligible = false;
  const list = await x.habits(); list.setStatus('archived'); await settle();
  const row = list.snapshot().habits[0]; list.requestRestore(row); await list.confirmRestore(row); await settle();
  assert.deepEqual(x.native.state.plan.effective, []); assert.equal(x.native.state.plan.future[0].eligible_from, '2026-10-22');
});

test('midnight reconciliation replaces yesterday eligibility and carries server DST/timezone snapshots unchanged', async t => {
  const x = await setup(t); await x.create(); const today = await x.today();
  await today.setCompletion(today.snapshot().today.occurrences[0], true); await settle();
  x.backend.state.date = '2026-10-22'; x.backend.state.time = '2026-10-22T00:01:00.000Z';
  x.backend.state.occurrence = x.backend.occurrence(x.backend.state.habit);
  await today.refresh(); await x.reminders.refresh(); await settle();
  assert.equal(x.native.state.plan.effective[0].local_date, '2026-10-22');
  const original = clone(x.native.state.plan.effective[0]);
  await x.sessions.update({ username: 'alice', display_name: null, timezone: 'America/New_York' }); await settle();
  assert.equal(x.native.state.plan.timezone, 'America/New_York');
  assert.deepEqual(x.native.state.plan.effective[0], original);
  // These authoritative inputs reach the production native adapter unchanged;
  // its Java/Android tests, rather than a second JS planner, assert gap/overlap times.
  for (const [date, time] of [['2027-03-14', '2027-03-14T06:00:00.000Z'], ['2027-11-07', '2027-11-07T04:00:00.000Z']]) {
    x.backend.state.date = date; x.backend.state.time = time;
    x.backend.state.habit.reminder_times = ['01:30', '02:30']; x.backend.state.occurrence = x.backend.occurrence(x.backend.state.habit);
    await x.reminders.refresh(); await settle();
    assert.equal(x.native.state.plan.effective[0].timezone, 'America/New_York');
    assert.equal(x.native.state.plan.effective[0].local_date, date);
    assert.deepEqual(x.native.state.plan.effective[0].reminder_times, ['01:30', '02:30']);
  }
});

test('late account-A plan cannot install after account B signs in', async t => {
  const x = await setup(t); await x.create(); const delayed = deferred();
  x.control.readPlan = s => s.user.id === A ? delayed.promise : x.backend.api.readPlan(s);
  const refresh = x.reminders.refresh(); await settle();
  const before = x.native.state.calls.length; x.event(session(B)); await settle();
  const enabling = x.reminders.enable(); await settle();
  delayed.resolve(await x.backend.api.readPlan(session(A))); await Promise.all([refresh, enabling]); await settle();
  assert.equal(x.native.state.owner, B);
  assert.equal(x.native.state.plan.owner_id, B);
  assert.ok(x.native.state.calls.slice(before).filter(call => call.name === 'reconcile').every(call => JSON.parse(call.args[1]).owner_id === B));
});

test('concurrent refreshes serialize native writes and disable fences any in-flight server result', async t => {
  const x = await setup(t); await x.create();
  await Promise.all([x.reminders.refresh(), x.reminders.refresh(), x.reminders.refresh()]); await settle();
  assert.equal(x.native.state.maximumActive, 1);
  const delayed = deferred(); x.control.readPlan = () => delayed.promise;
  const pending = x.reminders.refresh(); await settle();
  const disabling = x.reminders.disable(); await settle();
  assert.equal(x.native.state.plan, null);
  delayed.resolve(await x.backend.api.readPlan(session())); await Promise.all([pending, disabling]); await settle();
  assert.equal(x.native.state.plan, null); assert.equal(x.storage.enabled, null);
});

test('process recovery reuses durable native ownership and reconciles once without duplicate creation', async t => {
  const x = await setup(t); await x.create();
  const writes = x.backend.state.writes;
  const lease = x.native.state.lease;
  const cancellations = x.native.state.calls.filter(call => call.name === 'cancelAll').length;
  const y = await setup(t, { backend: x.backend, native: x.native, storage: x.storage, enable: false });
  await y.reminders.refresh(); await settle();
  assert.equal(y.native.state.owner, A); assert.equal(y.native.state.plan.effective.length, 1);
  assert.equal(y.native.state.lease, lease);
  assert.equal(y.native.state.calls.filter(call => call.name === 'cancelAll').length, cancellations);
  assert.equal(y.backend.state.writes, writes);
  assert.equal(y.native.state.plan.owner_id, A);
});

test('live sign-out cancels immediately while an old authenticated reconciliation is still reading', async t => {
  const x = await setup(t); await x.create(); const delayed = deferred();
  x.control.readPlan = () => delayed.promise;
  const refresh = x.reminders.refresh(); await settle();
  await x.sessions.signOut(); await settle();
  assert.equal(x.sessions.snapshot().status, 'signed_out');
  assert.equal(x.native.state.plan, null); assert.equal(x.storage.enabled, null);
  delayed.resolve(await x.backend.api.readPlan(session())); await refresh; await settle();
  assert.equal(x.native.state.plan, null);
});

test('a completion acknowledgement from an earlier A session cannot suppress a later A login after A to B to A', async t => {
  const x = await setup(t); await x.create(); const delayed = deferred();
  x.backend.api.writeCompletion = () => delayed.promise;
  const today = await x.today(); const previous = clone(today.snapshot().today.occurrences[0]);
  const pending = today.setCompletion(today.snapshot().today.occurrences[0], true); await settle();
  x.event(session(B)); await settle(); await x.reminders.enable(); await settle();
  x.event(session(A)); await settle(); await x.reminders.enable(); await settle();
  const suppressions = x.native.state.calls.filter(call => call.name === 'suppress').length;
  delayed.resolve({ ...previous, completed: true, state: 'completed' }); await pending; await settle();
  assert.equal(x.native.state.owner, A);
  assert.equal(x.native.state.calls.filter(call => call.name === 'suppress').length, suppressions);
  assert.equal(x.native.state.plan.effective.length, 1);
});

test('sign-out cancels persisted local reminders even after a process restart without an in-memory lease', async t => {
  const x = await setup(t); await x.create();
  const y = await setup(t, { backend: x.backend, native: x.native, storage: x.storage, session: null, enable: false });
  await settle();
  assert.equal(y.native.state.plan, null); assert.equal(y.storage.enabled, null);
  assert.ok(y.native.state.calls.some(call => call.name === 'cancelAll'));
});
