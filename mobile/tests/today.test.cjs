const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Real screens/stores with mocked host elements, Auth, API and app lifecycle.
// No native runtime or network is available here.
function compile(path, modules, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../${path}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, process: { env: {} }, require: modules, ...globals });
  return exports;
}
const cache = {};
const lib = name => cache[name] ??= compile(`lib/${name}.ts`, path => lib(path.slice(2)));
const { SessionStore, routeAccess } = lib('session-store');
const { ApiError } = lib('api');
const session = (id = 'a') => ({ user: { id }, access_token: `${id}-token` });
const profile = id => ({ user_id: id, username: id, timezone: 'UTC' });
const occurrence = (changes = {}) => ({
  id: 'occurrence-a', habit_id: 'habit-a', owner_id: 'a', local_date: '2026-10-10', timezone: 'Asia/Tokyo',
  closes_at: '2026-10-10T15:00:00Z', progress: 0, completed: false, state: 'in_progress',
  snapshot: { name: 'Original name', description: null, type: 'binary', target: null, unit: null,
    schedule: 'selected', weekdays: [1], reminder_times: ['08:00'] },
  created_at: '2026-10-09T15:00:00Z', updated_at: '2026-10-09T15:00:00Z', ...changes,
});
const today = (changes = {}) => ({
  local_date: '2026-10-10', timezone: 'America/Los_Angeles', server_time: '2026-10-11T05:00:00Z',
  occurrences: [occurrence()], ...changes,
});
const openToday = (changes = {}) => today({ server_time: '2026-10-10T12:00:00Z', ...changes });
const completedOccurrence = (changes = {}) => occurrence({ completed: true, state: 'completed', updated_at: '2026-10-10T12:01:00Z', ...changes });
const targetOccurrence = (changes = {}) => occurrence({ snapshot: { ...occurrence().snapshot,
  name: 'Read snapshot', type: 'target', target: 10, unit: 'pages' }, ...changes });
function clock() {
  let elapsed = 0, nextId = 0;
  const timers = new Map();
  return {
    globals: {
      performance: { now: () => elapsed },
      setTimeout: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, due: elapsed + delay }); return id; },
      clearTimeout: id => timers.delete(id),
    },
    advance: duration => {
      const end = elapsed + duration;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        elapsed = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      elapsed = end;
    },
    timerCount: () => timers.size,
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
const runtime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  const children = tree.type === 'FlatList'
    ? [tree.props.ListHeaderComponent, tree.props.data.length ? tree.props.data.map(item => tree.props.renderItem({ item })) : tree.props.ListEmptyComponent]
    : tree.props.children;
  return [tree, ...nodes(children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree && typeof tree === 'object' ? text(tree.props.children) : '';
}
async function screen(readToday, readProfile = async s => profile(s.user.id), initial = session(),
  setOccurrenceCompletion = async () => assert.fail('Unexpected completion request'),
  setOccurrenceProgress = async () => assert.fail('Unexpected progress request')) {
  let authEvent, store, focus, cleanup;
  const timer = clock();
  const { TodayStore } = compile('lib/today-store.ts', path => lib(path.slice(2)), timer.globals);
  const appListeners = new Set();
  const auth = {
    getSession: async () => ({ data: { session: initial } }),
    onAuthStateChange: cb => { authEvent = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, { readProfile, createProfile: async s => profile(s.user.id) });
  await sessions.start();
  const AppState = {
    currentState: 'active',
    addEventListener: (event, cb) => {
      assert.equal(event, 'change');
      appListeners.add(cb);
      return { remove: () => appListeners.delete(cb) };
    },
  };
  const modules = {
    'react/jsx-runtime': runtime,
    react: { useCallback: fn => fn, useState: initial => [store ??= initial()], useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    'expo-router': { useFocusEffect: callback => { focus = callback; } },
    'react-native': { AppState, ActivityIndicator: 'ActivityIndicator', Button: 'Button', FlatList: 'FlatList',
      Text: 'Text', TextInput: 'TextInput', View: 'View', StyleSheet: { create: value => value } },
    '../components/form': { styles: {} },
    '../components/excuse-view': compile('components/excuse-view.tsx', name => name === 'react/jsx-runtime' ? runtime
      : name === 'react-native' ? { Text: 'Text', View: 'View' } : { styles: {} }),
    '../lib/excuse-input': lib('excuse-input'),
    '../lib/api': { readToday, setOccurrenceCompletion, setOccurrenceProgress },
    '../lib/today-store': { TodayStore },
    '../lib/session': { useSession: () => ({ store: sessions }) },
  };
  const exports = compile('app/today.tsx', name => { assert.ok(modules[name], `Unexpected module ${name}`); return modules[name]; });
  const render = () => nodes(exports.default());
  const list = () => render().find(node => node.type === 'FlatList').props;
  const row = id => {
    const item = list().data.find(item => item.id === id);
    return item ? nodes(list().renderItem({ item })) : [];
  };
  render();
  cleanup = focus();
  await flush();
  return {
    render, sessions, auth, store: () => store, row, advance: timer.advance, timerCount: timer.timerCount,
    texts: () => render().filter(node => node.type === 'Text').map(text),
    list,
    button: (title, id) => (id ? row(id) : render()).find(node => node.type === 'Button' && node.props.title === title),
    input: (id = 'occurrence-a') => row(id).find(node => node.type === 'TextInput'),
    event: value => authEvent('SIGNED_IN', value),
    leave: () => cleanup(),
    focus: () => { cleanup = focus(); },
    appState: value => { AppState.currentState = value; appListeners.forEach(listener => listener(value)); },
    appListeners: () => appListeners.size,
  };
}
function cleared(ui) {
  const state = ui.store().snapshot();
  assert.equal(state.today, null);
  assert.equal(state.error, null);
  assert.equal(state.loading, false);
  assert.equal(state.refreshing, false);
  assert.ok(!ui.texts().some(value => /Date:|Timezone:|Original name/.test(value)));
}

test('initial loading has no client date; success renders the server envelope and snapshot', async () => {
  const read = deferred();
  const ui = await screen(() => read.promise);
  assert.ok(ui.render().some(node => node.type === 'ActivityIndicator' && node.props.accessibilityLabel === 'Loading Today'));
  assert.ok(!ui.texts().some(value => /Date:|Timezone:|No habits/.test(value)));
  assert.equal(ui.list().refreshing, false);
  const result = today();
  read.resolve(result);
  await flush();
  assert.ok(ui.texts().includes('Date: 2026-10-10'));
  assert.ok(ui.texts().includes('Timezone: America/Los_Angeles'));
  assert.ok(ui.texts().includes('Original name'));
  assert.equal(ui.list().data, result.occurrences);
  assert.equal(ui.list().keyExtractor(result.occurrences[0]), 'occurrence-a');
  assert.ok(!ui.render().some(node => node.type === 'ActivityIndicator'));
});

test('cards preserve order, snapshots, all five states, over-target progress and nullable units', async () => {
  const states = ['in_progress', 'completed', 'missed', 'justification_pending', 'excused'];
  const occurrences = states.map((state, i) => occurrence({ id: `row-${i}`, state,
    // Contrary completion/deadline fields prove status is not inferred.
    completed: state !== 'completed', snapshot: { ...occurrence().snapshot, name: `Snapshot ${state}` },
  }));
  occurrences.push(occurrence({ id: 'target', progress: 13, state: 'excused', snapshot: {
    ...occurrence().snapshot, name: 'Read', type: 'target', target: 10, unit: 'pages',
  } }));
  occurrences.push(occurrence({ id: 'unitless', progress: 0, snapshot: {
    ...occurrence().snapshot, name: 'Count', type: 'target', target: 5, unit: null,
  } }));
  const ui = await screen(async () => today({ occurrences }));
  assert.equal(ui.list().data, occurrences);
  for (const state of states) assert.ok(ui.texts().includes(`Snapshot ${state}`));
  assert.deepEqual(ui.texts().filter(value => value.startsWith('Status:')), [
    'Status: In progress', 'Status: Completed', 'Status: Missed', 'Status: Excuse pending',
    'Status: Excused', 'Status: Excused', 'Status: In progress',
  ]);
  assert.deepEqual(ui.texts().filter(value => value.startsWith('Progress:')), ['Progress: 13 / 10 pages', 'Progress: 0 / 5']);
  assert.equal(ui.texts().filter(value => value === 'Binary').length, 5);
  assert.equal(ui.texts().filter(value => value === 'Target').length, 2);
  assert.ok(!ui.render().some(node => ['Pressable', 'TextInput', 'Link'].includes(node.type)
    || (node.type === 'Button' && node.props.title !== 'View excuse')));
});

test('successful empty response displays its server date/timezone and an empty message', async () => {
  const ui = await screen(async () => today({ occurrences: [] }));
  assert.ok(ui.texts().includes('No habits to show for this date.'));
  assert.ok(ui.texts().includes('Date: 2026-10-10'));
  assert.ok(ui.texts().includes('Timezone: America/Los_Angeles'));
  assert.equal(ui.button('Retry loading'), undefined);
});

for (const [error, message] of [
  [new ApiError('private auth detail', 401, 'http_401'), /verify your session/i],
  [new ApiError('private network detail', null, 'network_error'), /connection/i],
  [new ApiError('private timeout detail', null, 'request_timeout'), /timed out/i],
  [new ApiError('private upstream detail', 503, 'http_503'), /unable to load/i],
]) test(`initial ${error.code} has a safe error and functional retry, not an empty date`, async () => {
  let calls = 0;
  const retry = deferred();
  const ui = await screen(async () => { if (++calls === 1) throw error; return retry.promise; });
  assert.match(ui.texts().join(' '), message);
  assert.ok(!ui.texts().some(value => /private|Date:|Timezone:|No habits/.test(value)));
  const action = ui.button('Retry loading').props.onPress;
  const pending = action();
  await action();
  assert.equal(calls, 2);
  assert.ok(ui.render().some(node => node.type === 'ActivityIndicator'));
  retry.resolve(today({ occurrences: [] }));
  await pending;
  assert.ok(ui.texts().includes('No habits to show for this date.'));
  assert.equal(ui.button('Retry loading'), undefined);
});

test('failed pull refresh retains date, timezone and rows until retry replaces all three', async () => {
  const refresh = deferred(), retry = deferred();
  let calls = 0;
  const old = today();
  const ui = await screen(() => [Promise.resolve(old), refresh.promise, retry.promise][calls++]);
  const pending = ui.list().onRefresh();
  await ui.list().onRefresh();
  assert.equal(calls, 2);
  assert.equal(ui.list().refreshing, true);
  assert.equal(ui.store().snapshot().today, old);
  refresh.reject(new ApiError('offline', null, 'network_error'));
  await pending;
  assert.equal(ui.list().refreshing, false);
  assert.ok(ui.texts().includes('Showing the last loaded date and habits.'));
  assert.ok(ui.texts().includes('Date: 2026-10-10'));
  assert.ok(ui.texts().includes('Timezone: America/Los_Angeles'));
  assert.ok(ui.texts().includes('Original name'));
  const retried = ui.button('Retry loading').props.onPress();
  assert.equal(ui.store().snapshot().today, old);
  retry.resolve(today({ local_date: '2026-10-12', timezone: 'UTC', occurrences: [] }));
  await retried;
  assert.ok(ui.texts().includes('Date: 2026-10-12'));
  assert.ok(ui.texts().includes('Timezone: UTC'));
  assert.ok(!ui.texts().includes('Original name'));
  assert.ok(ui.texts().includes('No habits to show for this date.'));
  assert.equal(calls, 3);
});

test('empty snapshot also keeps its original date through a refresh failure', async () => {
  let calls = 0;
  const result = today({ occurrences: [] });
  const ui = await screen(async () => { if (++calls > 1) throw Error('offline'); return result; });
  await ui.list().onRefresh();
  assert.equal(ui.store().snapshot().today, result);
  assert.ok(ui.texts().includes('Date: 2026-10-10'));
  assert.ok(ui.texts().includes('Showing the last loaded date and habits.'));
  assert.equal(ui.list().ListEmptyComponent, null);
});

for (const outcome of ['success', 'failure']) test(`navigation clears data and ignores late ${outcome} after refocus`, async () => {
  const oldRead = deferred(), newRead = deferred();
  let calls = 0;
  const ui = await screen(() => [Promise.resolve(today()), oldRead.promise, newRead.promise][calls++]);
  const pending = ui.list().onRefresh();
  const capturedRefresh = ui.list().onRefresh;
  ui.leave();
  cleared(ui);
  assert.equal(ui.appListeners(), 0);
  await capturedRefresh();
  ui.appState('background');
  ui.appState('active');
  assert.equal(calls, 2);
  ui.focus();
  assert.equal(calls, 3);
  assert.equal(ui.appListeners(), 1);
  const current = ui.store().snapshot();
  assert.equal(current.loading, true);
  if (outcome === 'success') oldRead.resolve(today());
  else oldRead.reject(new Error('old failure'));
  await pending;
  assert.equal(ui.store().snapshot(), current);
  newRead.resolve(today({ local_date: '2026-10-11', occurrences: [] }));
  await flush();
  assert.ok(ui.texts().includes('Date: 2026-10-11'));
});

test('foreground refresh runs only on return to active while Today has focus', async () => {
  let calls = 0;
  const ui = await screen(async () => { calls++; return today(); });
  ui.appState('active');
  ui.appState('inactive');
  ui.appState('background');
  assert.equal(calls, 1);
  ui.appState('active');
  await flush();
  assert.equal(calls, 2);
  ui.appState('active');
  assert.equal(calls, 2);
  ui.leave();
  ui.appState('background');
  ui.appState('active');
  assert.equal(calls, 2);
  ui.focus();
  await flush();
  assert.equal(calls, 3);
  ui.appState('inactive');
  ui.appState('active');
  await flush();
  assert.equal(calls, 4);
});

for (const outcome of ['success', 'failure']) test(`foreground refresh supersedes an older pending ${outcome}`, async () => {
  const oldRead = deferred(), latest = deferred();
  let calls = 0;
  const ui = await screen(() => ++calls === 1 ? oldRead.promise : latest.promise);
  ui.appState('background');
  ui.appState('active');
  assert.equal(calls, 2);
  latest.resolve(today({ local_date: '2026-10-11' }));
  await flush();
  const accepted = ui.store().snapshot();
  if (outcome === 'success') oldRead.resolve(today());
  else oldRead.reject(new Error('old error'));
  await flush();
  assert.equal(ui.store().snapshot(), accepted);
  assert.ok(ui.texts().includes('Date: 2026-10-11'));
});

for (const outcome of ['success', 'failure']) test(`account switch clears the envelope and ignores old account ${outcome}`, async () => {
  const oldRead = deferred(), nextProfile = deferred();
  let callsA = 0;
  const ui = await screen(s => s.user.id === 'b'
    ? Promise.resolve(today({ local_date: '2026-10-12', occurrences: [occurrence({ owner_id: 'b', snapshot: { ...occurrence().snapshot, name: 'B habit' } })] }))
    : ++callsA === 1 ? Promise.resolve(today()) : oldRead.promise,
  s => s.user.id === 'b' ? nextProfile.promise : Promise.resolve(profile('a')));
  const pending = ui.list().onRefresh();
  ui.event(session('b'));
  cleared(ui);
  assert.equal(ui.sessions.snapshot().status, 'loading');
  nextProfile.resolve(profile('b'));
  await flush();
  const accepted = ui.store().snapshot();
  assert.ok(ui.texts().includes('B habit'));
  if (outcome === 'success') oldRead.resolve(today());
  else oldRead.reject(new ApiError('expired previous account', 401, 'http_401'));
  await pending;
  assert.equal(ui.store().snapshot(), accepted);
  assert.ok(!ui.texts().includes('Original name'));
});

test('sign-out clears data before Auth settles and ignores a late response', async () => {
  const oldRead = deferred(), logout = deferred();
  let calls = 0;
  const ui = await screen(() => ++calls === 1 ? Promise.resolve(today()) : oldRead.promise);
  const pending = ui.list().onRefresh();
  ui.auth.signOut = () => logout.promise;
  const signingOut = ui.sessions.signOut();
  cleared(ui);
  oldRead.resolve(today());
  await pending;
  cleared(ui);
  logout.resolve({ error: null });
  await signingOut;
  await ui.list().onRefresh();
  ui.appState('background');
  ui.appState('active');
  assert.equal(calls, 2);
  cleared(ui);
});

test('token renewal preserves data and supersedes old requests with current credentials', async () => {
  const oldRead = deferred(), renewedRead = deferred();
  const supplied = [];
  const old = today();
  const ui = await screen(s => { supplied.push(s); return [Promise.resolve(old), oldRead.promise, renewedRead.promise][supplied.length - 1]; });
  const pending = ui.list().onRefresh();
  const renewed = { ...session(), access_token: 'renewed-token' };
  ui.event(renewed);
  assert.equal(supplied[2], renewed);
  assert.equal(ui.store().snapshot().today, old);
  assert.equal(ui.list().refreshing, true);
  renewedRead.resolve(today({ occurrences: [] }));
  await flush();
  const accepted = ui.store().snapshot();
  oldRead.reject(new ApiError('expired', 401, 'http_401'));
  await pending;
  assert.equal(ui.store().snapshot(), accepted);
});

test('signed-out session never fetches Today through refresh or foreground events', async () => {
  const ui = await screen(() => assert.fail('must not request'), undefined, null);
  await ui.list().onRefresh();
  ui.appState('background');
  ui.appState('active');
  cleared(ui);
});

test('owner mismatch becomes an error without displaying another account data', async () => {
  const ui = await screen(async () => today({ occurrences: [occurrence({ owner_id: 'b' })] }));
  assert.equal(ui.store().snapshot().today, null);
  assert.ok(ui.button('Retry loading'));
  assert.ok(!ui.texts().includes('Original name'));
});

test('Complete and Undo controls send explicit values and render confirmed results before refreshing', async () => {
  const complete = deferred(), undo = deferred(), completedRead = deferred(), undoneRead = deferred();
  const writes = [];
  let reads = 0;
  const original = openToday();
  const ui = await screen(() => [Promise.resolve(original), completedRead.promise, undoneRead.promise][reads++], undefined, undefined,
    (s, id, completed) => { writes.push({ s, id, completed }); return completed ? complete.promise : undo.promise; });
  const completeButton = ui.button('Complete').props;
  assert.equal(completeButton.accessibilityLabel, 'Complete Original name');
  const pending = completeButton.onPress();
  await completeButton.onPress();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].s.access_token, 'a-token');
  assert.equal(writes[0].id, 'occurrence-a');
  assert.equal(writes[0].completed, true);
  assert.equal(ui.button('Complete').props.disabled, true);
  assert.ok(ui.render().some(node => node.type === 'ActivityIndicator' && node.props.accessibilityLabel === 'Updating Original name'));
  assert.ok(ui.texts().includes('Status: In progress'));
  const confirmed = completedOccurrence();
  complete.resolve(confirmed);
  await flush();
  assert.equal(ui.list().data[0], confirmed);
  assert.ok(ui.texts().includes('Status: Completed'));
  assert.ok(ui.button('Undo'));
  assert.ok(ui.texts().includes('Date: 2026-10-10'));
  assert.ok(ui.texts().includes('Timezone: America/Los_Angeles'));
  assert.equal(ui.store().snapshot().today.server_time, original.server_time);
  assert.equal(reads, 2);
  completedRead.resolve(openToday({ occurrences: [confirmed], server_time: '2026-10-10T12:01:00Z' }));
  await pending;
  await flush();
  assert.ok(!ui.render().some(node => node.type === 'ActivityIndicator'));
  const undoPending = ui.button('Undo').props.onPress();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].completed, false);
  const undone = occurrence({ updated_at: '2026-10-10T12:02:00Z' });
  undo.resolve(undone);
  await flush();
  assert.equal(ui.list().data[0], undone);
  assert.ok(ui.texts().includes('Status: In progress'));
  assert.ok(ui.button('Complete'));
  assert.equal(reads, 3);
  undoneRead.resolve(openToday({ occurrences: [undone] }));
  await undoPending;
});

test('eligibility uses original deadline and server time for both habit types, leaving locked states read-only', async () => {
  const rows = [
    occurrence({ id: 'open' }),
    completedOccurrence({ id: 'done' }),
    occurrence({ id: 'target', snapshot: { ...occurrence().snapshot, type: 'target', target: 5, unit: 'pages' } }),
    completedOccurrence({ id: 'target-done', snapshot: { ...occurrence().snapshot, type: 'target', target: 5, unit: null } }),
    ...['missed', 'excused', 'justification_pending'].map(state => occurrence({ id: state, state })),
    occurrence({ id: 'closed', closes_at: '2026-10-10T11:59:59Z' }),
    completedOccurrence({ id: 'closed-done', closes_at: '2026-10-10T12:00:00Z' }),
    occurrence({ id: 'invalid-deadline', closes_at: 'invalid' }),
  ];
  const ui = await screen(async () => openToday({ occurrences: rows }));
  assert.ok(ui.button('Complete', 'open'));
  assert.ok(ui.button('Undo', 'done'));
  // The device is not set to this fixture date; the current profile and original occurrence timezone also differ.
  assert.equal(ui.store().snapshot().today.timezone, 'America/Los_Angeles');
  assert.equal(rows[0].timezone, 'Asia/Tokyo');
  for (const item of rows.slice(2)) {
    if (item.snapshot.type === 'target') assert.ok(ui.button('Save progress', item.id));
    else assert.ok(!ui.row(item.id).some(node => node.type === 'Button' && node.props.title !== 'View excuse'), `${item.id} must be read-only`);
    await ui.store().setCompletion(item, item.state !== 'completed');
  }
  assert.equal(ui.render().filter(node => node.type === 'Button' && !['View excuse', 'Submit excuse'].includes(node.props.title)).length, 4);
});

test('deadline timer hides actions at the exact server deadline and rejects an already captured control', async () => {
  const ui = await screen(async () => openToday({ server_time: '2026-10-10T14:59:59Z' }));
  let changes = 0;
  ui.store().subscribe(() => changes++);
  const press = ui.button('Complete').props.onPress;
  ui.advance(999);
  assert.ok(ui.button('Complete'));
  ui.advance(1);
  assert.ok(changes > 0, 'deadline must notify the real screen subscription');
  assert.equal(ui.button('Complete'), undefined);
  await press();
  ui.leave();
  assert.equal(ui.timerCount(), 0);
});

test('invalid server time cannot enable a mutation', async () => {
  const ui = await screen(async () => openToday({ server_time: 'invalid' }));
  assert.equal(ui.button('Complete'), undefined);
  await ui.store().setCompletion(ui.list().data[0], true);
});

test('pending state is per occurrence and repeated captured taps do not duplicate requests', async () => {
  const first = deferred(), second = deferred();
  const calls = [];
  const rows = [occurrence(), occurrence({ id: 'occurrence-b', habit_id: 'habit-b', snapshot: { ...occurrence().snapshot, name: 'Second habit' } })];
  const ui = await screen(async () => openToday({ occurrences: rows }), undefined, undefined,
    (_s, id) => { calls.push(id); return id === 'occurrence-a' ? first.promise : second.promise; });
  const firstPress = ui.button('Complete', 'occurrence-a').props.onPress;
  const pending = firstPress();
  await firstPress();
  assert.equal(ui.button('Complete', 'occurrence-a').props.disabled, true);
  assert.ok(!ui.button('Complete', 'occurrence-b').props.disabled);
  assert.equal(ui.row('occurrence-b').filter(node => node.type === 'ActivityIndicator').length, 0);
  const next = ui.button('Complete', 'occurrence-b').props.onPress();
  assert.deepEqual(calls, ['occurrence-a', 'occurrence-b']);
  first.reject(new ApiError('bad input', 422, 'validation_error'));
  second.reject(new ApiError('bad input', 422, 'validation_error'));
  await Promise.all([pending, next]);
  assert.ok(!ui.button('Complete', 'occurrence-a').props.disabled);
  assert.ok(!ui.button('Complete', 'occurrence-b').props.disabled);
});

for (const [failure, expected] of [
  [new ApiError('private auth detail', 401, 'http_401'), /session|sign in/i],
  [new ApiError('private validation detail', 422, 'validation_error'), /unable|try|failed/i],
]) test(`definite ${failure.code} is a safe row error and allows an explicit retry`, async () => {
  let writes = 0, reads = 0;
  const retry = deferred();
  const ui = await screen(async () => { reads++; return openToday(); }, undefined, undefined,
    () => { if (++writes === 1) return Promise.reject(failure); return retry.promise; });
  await ui.button('Complete').props.onPress();
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.ok(ui.texts().includes('Status: In progress'));
  assert.equal(ui.store().snapshot().error, null);
  const rowText = ui.row('occurrence-a').filter(node => node.type === 'Text').map(text).join(' ');
  assert.match(rowText, expected);
  assert.doesNotMatch(rowText, /private/);
  assert.ok(!ui.button('Complete').props.disabled);
  assert.equal(ui.button('Refresh Today'), undefined);
  const pending = ui.button('Complete').props.onPress();
  assert.equal(writes, 2);
  assert.equal(ui.store().snapshot().completions['occurrence-a'].error, null);
  retry.reject(failure);
  await pending;
});

for (const [code, nextState, expected] of [
  ['occurrence_closed', 'missed', /closed|deadline/i],
  ['occurrence_locked', 'justification_pending', /locked|excuse/i],
]) test(`${code} explains the rejection and refreshes the server state`, async () => {
  const refresh = deferred();
  let reads = 0, writes = 0;
  const ui = await screen(() => ++reads === 1 ? Promise.resolve(openToday()) : refresh.promise, undefined, undefined,
    async () => { writes++; throw new ApiError('private domain detail', 409, code); });
  const pending = ui.button('Complete').props.onPress();
  await flush();
  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.match(ui.texts().join(' '), expected);
  assert.doesNotMatch(ui.texts().join(' '), /private/);
  assert.equal(ui.button('Complete').props.disabled, true);
  assert.equal(ui.button('Refresh Today').props.disabled, true);
  refresh.resolve(openToday({ occurrences: [occurrence({ state: nextState })] }));
  await pending;
  await flush();
  assert.equal(ui.button('Complete'), undefined);
  assert.equal(ui.button('Undo'), undefined);
  assert.equal(ui.list().data[0].state, nextState);
});

for (const failure of [
  new ApiError('private timeout', null, 'request_timeout'),
  new ApiError('private connection', null, 'network_error'),
  new ApiError('private upstream', 503, 'http_503'),
  new ApiError('private invalid response', 200, 'invalid_response'),
  new Error('private unknown error'),
]) test(`uncertain ${failure.code ?? 'unknown'} requires a successful Refresh Today before another action`, async () => {
  let reads = 0, writes = 0;
  const retryRead = deferred();
  const ui = await screen(() => {
    reads++;
    if (reads === 1) return Promise.resolve(openToday());
    if (reads === 2) return Promise.reject(new ApiError('offline', null, 'network_error'));
    return retryRead.promise;
  }, undefined, undefined, async () => { writes++; throw failure; });
  const captured = ui.button('Complete').props.onPress;
  await captured();
  assert.equal(writes, 1);
  assert.equal(reads, 1, 'uncertain outcomes offer a refresh without retrying the write');
  assert.match(ui.texts().join(' '), /refresh/i);
  assert.doesNotMatch(ui.texts().join(' '), /private/);
  assert.equal(ui.button('Complete').props.disabled, true);
  await captured();
  assert.equal(writes, 1);
  await ui.button('Refresh Today').props.onPress();
  assert.equal(reads, 2);
  assert.equal(ui.button('Complete').props.disabled, true);
  assert.ok(ui.button('Refresh Today'));
  await captured();
  assert.equal(writes, 1);
  const refreshed = ui.button('Refresh Today').props.onPress();
  assert.equal(ui.button('Refresh Today').props.disabled, true);
  retryRead.resolve(openToday({ occurrences: [completedOccurrence()] }));
  await refreshed;
  assert.equal(ui.button('Complete'), undefined);
  assert.ok(!ui.button('Undo').props.disabled);
  assert.equal(ui.button('Refresh Today'), undefined);
  assert.equal(writes, 1);
});

test('a read started before an uncertain mutation outcome cannot clear the refresh requirement', async () => {
  const mutation = deferred(), oldRead = deferred();
  let reads = 0, writes = 0;
  const ui = await screen(() => ++reads === 1 ? Promise.resolve(openToday()) : oldRead.promise, undefined, undefined,
    () => { writes++; return mutation.promise; });
  const pending = ui.button('Complete').props.onPress();
  const refresh = ui.list().onRefresh();
  mutation.reject(new ApiError('timed out', null, 'request_timeout'));
  await pending;
  oldRead.resolve(openToday());
  await refresh;
  assert.equal(ui.button('Complete').props.disabled, true);
  assert.ok(ui.button('Refresh Today'));
  await ui.button('Complete').props.onPress();
  assert.equal(writes, 1);
});

for (const completed of [true, false]) for (const outcome of ['success', 'failure']) test(`confirmed ${completed ? 'completion' : 'undo'} survives an older refresh ${outcome}`, async () => {
  const mutation = deferred(), oldRead = deferred(), latestRead = deferred();
  let reads = 0;
  const initial = openToday({ occurrences: [completed ? occurrence() : completedOccurrence()] });
  const ui = await screen(() => [Promise.resolve(initial), oldRead.promise, latestRead.promise][reads++], undefined, undefined,
    () => mutation.promise);
  const refreshing = ui.list().onRefresh();
  const pending = ui.button(completed ? 'Complete' : 'Undo').props.onPress();
  const confirmed = completed ? completedOccurrence() : occurrence({ updated_at: '2026-10-10T12:02:00Z' });
  mutation.resolve(confirmed);
  await flush();
  assert.equal(reads, 3, 'confirmed change starts a new authoritative refresh');
  assert.equal(ui.list().data[0], confirmed);
  const accepted = ui.store().snapshot();
  if (outcome === 'success') oldRead.resolve(initial);
  else oldRead.reject(new Error('older refresh failure'));
  await refreshing;
  assert.equal(ui.store().snapshot(), accepted);
  latestRead.resolve(openToday({ occurrences: [confirmed] }));
  await pending;
  await flush();
  assert.ok(ui.button(completed ? 'Undo' : 'Complete'));
  assert.equal(ui.store().snapshot().error, null);
});

test('failed post-completion refresh preserves the confirmed row and original envelope for retry', async () => {
  let reads = 0;
  const confirmed = completedOccurrence();
  const ui = await screen(async () => {
    if (++reads === 2) throw new ApiError('offline', null, 'network_error');
    return openToday({ occurrences: reads === 1 ? [occurrence()] : [confirmed] });
  }, undefined, undefined, async () => confirmed);
  await ui.button('Complete').props.onPress();
  await flush();
  assert.equal(ui.list().data[0], confirmed);
  assert.ok(ui.texts().includes('Date: 2026-10-10'));
  assert.ok(ui.texts().includes('Timezone: America/Los_Angeles'));
  assert.ok(ui.texts().includes('Showing the last loaded date and habits.'));
  await ui.button('Retry loading').props.onPress();
  assert.equal(reads, 3);
  assert.equal(ui.store().snapshot().error, null);
  assert.ok(ui.button('Undo'));
});

test('a same-day refresh during a pending completion keeps its row busy and accepts the confirmed result', async () => {
  const mutation = deferred();
  let reads = 0, writes = 0;
  const confirmed = completedOccurrence();
  const ui = await screen(async () => {
    reads++;
    return openToday({ occurrences: [reads > 2 ? confirmed : occurrence()] });
  }, undefined, undefined, () => { writes++; return mutation.promise; });
  const pending = ui.button('Complete').props.onPress();
  await ui.list().onRefresh();
  assert.equal(ui.button('Complete').props.disabled, true);
  await ui.button('Complete').props.onPress();
  assert.equal(writes, 1);
  mutation.resolve(confirmed);
  await pending;
  await flush();
  assert.equal(reads, 3);
  assert.equal(ui.list().data[0], confirmed);
  assert.ok(ui.button('Undo'));
});

for (const acknowledgementIsNewer of [false, true]) test(`microsecond timestamps ${acknowledgementIsNewer ? 'allow a newer completion to replace an accepted read' : 'keep a newer accepted read over a late completion'}`, async () => {
  const mutation = deferred(), nextRead = deferred(), followupRead = deferred();
  let reads = 0;
  const refreshedRow = occurrence({ updated_at: `2026-10-10T12:01:00.${acknowledgementIsNewer ? '123100' : '123900'}Z` });
  const confirmed = completedOccurrence({ updated_at: `2026-10-10T12:01:00.${acknowledgementIsNewer ? '123900' : '123100'}Z` });
  assert.equal(Date.parse(refreshedRow.updated_at), Date.parse(confirmed.updated_at), 'fixture differences are below JavaScript millisecond precision');
  const ui = await screen(() => [Promise.resolve(openToday()), nextRead.promise, followupRead.promise][reads++],
    undefined, undefined, () => mutation.promise);
  const pending = ui.button('Complete').props.onPress();
  const refresh = ui.list().onRefresh();
  nextRead.resolve(openToday({ server_time: '2026-10-10T12:01:01Z', occurrences: [refreshedRow] }));
  await refresh;
  assert.equal(ui.list().data[0], refreshedRow);
  assert.equal(ui.button('Complete').props.disabled, true);
  mutation.resolve(confirmed);
  await flush();
  const expected = acknowledgementIsNewer ? confirmed : refreshedRow;
  assert.equal(reads, 3);
  assert.equal(ui.list().refreshing, true);
  assert.equal(ui.list().data[0], expected);
  assert.ok(ui.texts().includes(`Status: ${acknowledgementIsNewer ? 'Completed' : 'In progress'}`));
  assert.ok(ui.button(acknowledgementIsNewer ? 'Undo' : 'Complete'));
  assert.equal(ui.store().snapshot().today.server_time, '2026-10-10T12:01:01Z');
  followupRead.resolve(openToday({ occurrences: [expected] }));
  await pending;
});

test('token renewal keeps a pending completion guarded and uses renewed credentials for its refresh and next action', async () => {
  const mutation = deferred(), secondMutation = deferred();
  const readSessions = [], writeSessions = [];
  const confirmed = completedOccurrence();
  const ui = await screen(async s => {
    readSessions.push(s);
    return openToday({ occurrences: [readSessions.length > 2 ? confirmed : occurrence()] });
  }, undefined, undefined, (s, _id, completed) => {
    writeSessions.push(s);
    return completed ? mutation.promise : secondMutation.promise;
  });
  const pending = ui.button('Complete').props.onPress();
  const renewed = { ...session(), access_token: 'renewed-token' };
  ui.event(renewed);
  await flush();
  assert.equal(readSessions[1], renewed);
  assert.equal(ui.button('Complete').props.disabled, true);
  await ui.button('Complete').props.onPress();
  assert.equal(writeSessions.length, 1);
  assert.equal(writeSessions[0].access_token, 'a-token');
  mutation.resolve(confirmed);
  await pending;
  assert.equal(readSessions.length, 3);
  assert.equal(readSessions[2], renewed);
  const undo = ui.button('Undo').props.onPress();
  assert.equal(writeSessions[1], renewed);
  secondMutation.reject(new ApiError('validation', 422, 'validation_error'));
  await undo;
});

test('two concurrent row completions preserve both confirmations across interleaved refreshes', async () => {
  const first = deferred(), second = deferred(), oldRead = deferred(), latestRead = deferred();
  let reads = 0;
  const rows = [occurrence(), occurrence({ id: 'occurrence-b', habit_id: 'habit-b' })];
  const completed = [completedOccurrence(), completedOccurrence({ id: 'occurrence-b', habit_id: 'habit-b' })];
  const ui = await screen(() => [Promise.resolve(openToday({ occurrences: rows })), oldRead.promise, latestRead.promise][reads++],
    undefined, undefined, (_s, id) => id === 'occurrence-a' ? first.promise : second.promise);
  const firstPending = ui.button('Complete', 'occurrence-a').props.onPress();
  const secondPending = ui.button('Complete', 'occurrence-b').props.onPress();
  first.resolve(completed[0]);
  await flush();
  assert.equal(reads, 2);
  assert.ok(ui.button('Undo', 'occurrence-a'));
  assert.equal(ui.button('Complete', 'occurrence-b').props.disabled, true);
  second.resolve(completed[1]);
  await flush();
  assert.equal(reads, 3);
  assert.ok(ui.button('Undo', 'occurrence-a'));
  assert.ok(ui.button('Undo', 'occurrence-b'));
  const accepted = ui.store().snapshot();
  oldRead.resolve(openToday({ occurrences: [completed[0], rows[1]] }));
  await firstPending;
  assert.equal(ui.store().snapshot(), accepted);
  latestRead.resolve(openToday({ occurrences: completed }));
  await secondPending;
  assert.ok(ui.button('Undo', 'occurrence-a'));
  assert.ok(ui.button('Undo', 'occurrence-b'));
  assert.ok(!ui.render().some(node => node.type === 'ActivityIndicator'));
});

test('mismatched successful responses never replace the row and require refresh before another action', async () => {
  for (const changes of [
    { id: 'another-row' }, { owner_id: 'b' }, { habit_id: 'another-habit' }, { local_date: '2026-10-11' },
    { timezone: 'UTC' }, { closes_at: '2026-10-12T00:00:00Z' }, { completed: false },
    { state: 'excused' }, { snapshot: { ...occurrence().snapshot, type: 'target', target: 10 } },
    { updated_at: 'invalid' },
  ]) {
    let writes = 0, reads = 0;
    const initial = openToday();
    const ui = await screen(async () => { reads++; return initial; }, undefined, undefined,
      async () => { writes++; return completedOccurrence(changes); });
    await ui.button('Complete').props.onPress();
    assert.equal(ui.list().data, initial.occurrences, JSON.stringify(changes));
    assert.equal(ui.button('Complete').props.disabled, true);
    assert.ok(ui.button('Refresh Today'));
    await ui.button('Complete').props.onPress();
    assert.equal(writes, 1);
    assert.equal(reads, 1);
    ui.leave();
  }
});

test('a failed automatic refresh after a locked response keeps the action blocked until manual refresh succeeds', async () => {
  let reads = 0, writes = 0;
  const ui = await screen(async () => {
    reads++;
    if (reads === 2) throw new ApiError('offline', null, 'network_error');
    return openToday({ occurrences: [occurrence({ state: reads === 1 ? 'in_progress' : 'excused' })] });
  }, undefined, undefined, async () => { writes++; throw new ApiError('locked', 409, 'occurrence_locked'); });
  await ui.button('Complete').props.onPress();
  assert.equal(reads, 2);
  assert.equal(ui.button('Complete').props.disabled, true);
  assert.match(ui.texts().join(' '), /locked/i);
  await ui.button('Complete').props.onPress();
  assert.equal(writes, 1);
  await ui.button('Refresh Today').props.onPress();
  assert.equal(reads, 3);
  assert.equal(ui.button('Complete'), undefined);
  assert.ok(ui.texts().includes('Status: Excused'));
});

test('sign-out clears pending completion state immediately and ignores the response', async () => {
  const mutation = deferred(), logout = deferred();
  let reads = 0;
  const ui = await screen(async () => { reads++; return openToday(); }, undefined, undefined, () => mutation.promise);
  const pending = ui.button('Complete').props.onPress();
  ui.auth.signOut = () => logout.promise;
  const signingOut = ui.sessions.signOut();
  cleared(ui);
  assert.equal(Object.keys(ui.store().snapshot().completions).length, 0);
  mutation.resolve(completedOccurrence());
  await pending;
  cleared(ui);
  assert.equal(reads, 1);
  logout.resolve({ error: null });
  await signingOut;
});

for (const outcome of ['success', 'failure']) test(`navigation ignores stale completion ${outcome}, including after refocus`, async () => {
  const mutation = deferred();
  let reads = 0, writes = 0;
  const ui = await screen(async () => { reads++; return openToday(); }, undefined, undefined,
    () => { writes++; return mutation.promise; });
  const captured = ui.button('Complete').props.onPress;
  const pending = captured();
  ui.leave();
  cleared(ui);
  assert.equal(Object.keys(ui.store().snapshot().completions).length, 0);
  await captured();
  assert.equal(writes, 1);
  ui.focus();
  await flush();
  const accepted = ui.store().snapshot();
  assert.equal(ui.button('Complete').props.disabled, true);
  await ui.button('Complete').props.onPress();
  assert.equal(writes, 1);
  if (outcome === 'success') mutation.resolve(completedOccurrence());
  else mutation.reject(new ApiError('old failure', 409, 'occurrence_locked'));
  await pending;
  assert.equal(ui.store().snapshot().today, accepted.today);
  assert.equal(ui.store().snapshot().error, accepted.error);
  assert.equal(reads, 2);
  assert.equal(ui.button('Complete').props.disabled, true);
  assert.equal(ui.button('Undo'), undefined);
  assert.ok(ui.button('Refresh Today'));
  assert.doesNotMatch(ui.texts().join(' '), /old failure|locked by an excuse/);
  await ui.button('Complete').props.onPress();
  assert.equal(writes, 1);
  await ui.button('Refresh Today').props.onPress();
  assert.equal(reads, 3);
  assert.ok(!ui.button('Complete').props.disabled);
  assert.equal(ui.button('Refresh Today'), undefined);
});

for (const outcome of ['success', 'failure']) test(`account change ignores stale completion ${outcome} even with a repeated occurrence ID`, async () => {
  const mutation = deferred();
  let reads = 0, writes = 0;
  const ui = await screen(async s => {
    reads++;
    return openToday({ occurrences: [occurrence({ owner_id: s.user.id, snapshot: { ...occurrence().snapshot, name: `${s.user.id} habit` } })] });
  }, undefined, undefined, () => { writes++; return mutation.promise; });
  const captured = ui.button('Complete').props.onPress;
  const pending = captured();
  ui.event(session('b'));
  await flush();
  const accepted = ui.store().snapshot();
  assert.ok(ui.texts().includes('b habit'));
  await captured();
  assert.equal(writes, 1);
  if (outcome === 'success') mutation.resolve(completedOccurrence());
  else mutation.reject(new ApiError('old failure', 401, 'http_401'));
  await pending;
  assert.equal(ui.store().snapshot(), accepted);
  assert.equal(reads, 2);
  assert.equal(Object.keys(ui.store().snapshot().completions).length, 0);
});

for (const outcome of ['success', 'failure']) test(`displayed date change ignores stale completion ${outcome} without inserting the old occurrence`, async () => {
  const mutation = deferred();
  let reads = 0, writes = 0;
  const nextDay = openToday({ local_date: '2026-10-11', timezone: 'UTC', server_time: '2026-10-11T12:00:00Z',
    occurrences: [occurrence({ id: 'next-day-row', local_date: '2026-10-11', closes_at: '2026-10-12T00:00:00Z' })] });
  const ui = await screen(async () => ++reads === 1 ? openToday() : nextDay, undefined, undefined,
    () => { writes++; return mutation.promise; });
  const captured = ui.button('Complete').props.onPress;
  const pending = captured();
  await ui.list().onRefresh();
  const accepted = ui.store().snapshot();
  await captured();
  assert.equal(writes, 1);
  if (outcome === 'success') mutation.resolve(completedOccurrence());
  else mutation.reject(new ApiError('old failure', null, 'network_error'));
  await pending;
  assert.equal(ui.store().snapshot(), accepted);
  assert.equal(reads, 2);
  assert.equal(ui.list().data.length, 1);
  assert.equal(ui.list().data[0].id, 'next-day-row');
  assert.equal(Object.keys(ui.store().snapshot().completions).length, 0);
});

test('a refreshed same-day list that drops an occurrence cannot be repopulated by its pending completion', async () => {
  const mutation = deferred();
  let reads = 0;
  const ui = await screen(async () => ++reads === 1 ? openToday() : openToday({ occurrences: [] }), undefined, undefined,
    () => mutation.promise);
  const pending = ui.button('Complete').props.onPress();
  await ui.list().onRefresh();
  mutation.resolve(completedOccurrence());
  await pending;
  assert.equal(ui.list().data.length, 0);
  assert.equal(reads, 2);
  assert.equal(Object.keys(ui.store().snapshot().completions).length, 0);
});

test('progress input accepts exact nonnegative integers and rejects fractions, signs, exponents and unsafe integers', () => {
  const { parseProgress } = lib('today-store');
  for (const [value, expected] of [['0', 0], [' 0008 ', 8], ['9007199254740991', Number.MAX_SAFE_INTEGER]]) {
    assert.equal(parseProgress(value), expected);
  }
  for (const value of ['', ' ', '-1', '+1', '1.0', '1.5', '1e3', '0x10', 'NaN', 'Infinity', 'true', '1,000',
    '9007199254740992', '9007199254740993', '9'.repeat(400)]) {
    assert.throws(() => parseProgress(value), /nonnegative whole number|save it exactly/, value);
  }
});

test('target controls save absolute over-target progress then reduce to zero and reopen, using snapshot target and unit', async () => {
  const first = deferred(), second = deferred(), firstRead = deferred(), secondRead = deferred();
  const writes = [];
  let reads = 0;
  const row = targetOccurrence({ progress: 3 });
  const ui = await screen(() => [Promise.resolve(openToday({ occurrences: [row] })), firstRead.promise, secondRead.promise][reads++],
    undefined, undefined, undefined, (s, id, progress) => { writes.push({ s, id, progress }); return writes.length === 1 ? first.promise : second.promise; });
  assert.equal(ui.input().props.value, '3');
  assert.equal(ui.input().props.accessibilityLabel, 'Total progress for Read snapshot');
  assert.equal(ui.list().keyboardShouldPersistTaps, 'handled');
  assert.ok(ui.texts().includes('Progress: 3 / 10 pages'));
  ui.input().props.onChangeText('15');
  const action = ui.button('Save progress').props.onPress;
  const pending = action();
  await action();
  assert.deepEqual(writes.map(({ id, progress }) => [id, progress]), [['occurrence-a', 15]]);
  assert.equal(writes[0].s.access_token, 'a-token');
  assert.equal(ui.input().props.value, '15');
  assert.equal(ui.input().props.editable, false);
  assert.equal(ui.button('Save progress').props.disabled, true);
  ui.input().props.onChangeText('999');
  assert.equal(ui.input().props.value, '15');
  assert.ok(ui.render().some(node => node.type === 'ActivityIndicator' && node.props.accessibilityLabel === 'Updating Read snapshot'));
  const completed = targetOccurrence({ progress: 15, completed: true, state: 'completed', updated_at: '2026-10-10T12:01:00Z' });
  first.resolve(completed);
  await flush();
  assert.equal(ui.list().data[0], completed);
  assert.ok(ui.texts().includes('Status: Completed'));
  assert.equal(ui.input().props.value, '15');
  assert.equal(ui.button('Undo'), undefined);
  assert.equal(reads, 2);
  firstRead.resolve(openToday({ occurrences: [completed] }));
  await pending;
  ui.input().props.onChangeText('0');
  const reducing = ui.button('Save progress').props.onPress();
  assert.equal(writes[1].progress, 0);
  const reopened = targetOccurrence({ updated_at: '2026-10-10T12:02:00Z' });
  second.resolve(reopened);
  await flush();
  assert.equal(ui.list().data[0], reopened);
  assert.ok(ui.texts().includes('Status: In progress'));
  assert.ok(ui.texts().includes('Progress: 0 / 10 pages'));
  secondRead.resolve(openToday({ occurrences: [reopened] }));
  await reducing;
  assert.equal(reads, 3);
  assert.equal(ui.input().props.editable, true);
});

test('invalid target drafts stay visible with per-occurrence errors and cannot reach the API', async () => {
  let writes = 0;
  const rows = [targetOccurrence(), targetOccurrence({ id: 'second', habit_id: 'habit-b' })];
  const ui = await screen(async () => openToday({ occurrences: rows }), undefined, undefined, undefined,
    async () => { writes++; throw new ApiError('private validation detail', 422, 'validation_error'); });
  for (const value of ['-1', '1.5', '', '9007199254740993']) {
    ui.input().props.onChangeText(value);
    await ui.button('Save progress').props.onPress();
    assert.equal(ui.input().props.value, value);
    assert.equal(writes, 0);
    assert.match(ui.row('occurrence-a').map(text).join(' '), /nonnegative whole number|save it exactly/);
    assert.doesNotMatch(ui.row('second').map(text).join(' '), /nonnegative whole number|save it exactly/);
    assert.ok(!ui.button('Save progress', 'second').props.disabled);
  }
  ui.input().props.onChangeText('8');
  assert.doesNotMatch(ui.row('occurrence-a').map(text).join(' '), /save it exactly/);
  await ui.button('Save progress').props.onPress();
  assert.equal(writes, 1);
  assert.equal(ui.input().props.value, '8');
  assert.equal(ui.input().props.editable, true);
  assert.match(ui.texts().join(' '), /Unable to change/);
  assert.doesNotMatch(ui.texts().join(' '), /private/);
  assert.equal(ui.button('Refresh Today'), undefined);
  await ui.button('Save progress').props.onPress();
  assert.equal(writes, 2, 'definite validation failures allow an explicit retry');
});

test('unsafe existing progress is never prefilled or silently resubmitted', async () => {
  let writes = 0;
  const row = targetOccurrence({ progress: Number.MAX_SAFE_INTEGER + 1, completed: true, state: 'completed' });
  const ui = await screen(async () => openToday({ occurrences: [row] }), undefined, undefined, undefined,
    async () => { writes++; assert.fail('No progress assignment expected'); });
  assert.equal(ui.input().props.value, '');
  await ui.button('Save progress').props.onPress();
  assert.equal(writes, 0);
  assert.match(ui.texts().join(' '), /nonnegative whole number/);
});

test('locked and closed targets have no progress controls and captured controls expire at the original deadline', async () => {
  const rows = [targetOccurrence(),
    ...['missed', 'excused', 'justification_pending'].map(state => targetOccurrence({ id: state, state })),
    targetOccurrence({ id: 'closed', closes_at: '2026-10-10T14:59:59Z' }),
    targetOccurrence({ id: 'closed-completed', completed: true, state: 'completed', progress: 10, closes_at: '2026-10-10T14:59:59Z' }),
    targetOccurrence({ id: 'invalid-deadline', closes_at: 'invalid' }),
  ];
  const ui = await screen(async () => openToday({ occurrences: rows, server_time: '2026-10-10T14:59:59Z' }));
  for (const row of rows.slice(1)) {
    assert.equal(ui.input(row.id), undefined);
    assert.equal(ui.button('Save progress', row.id), undefined);
    ui.store().setProgressDraft(row, '3');
    await ui.store().setProgress(row);
  }
  const input = ui.input().props.onChangeText, press = ui.button('Save progress').props.onPress;
  input('4');
  ui.advance(999);
  assert.ok(ui.button('Save progress'));
  ui.advance(1);
  assert.equal(ui.button('Save progress'), undefined);
  assert.equal(ui.input(), undefined);
  await press();
  input('5');
  assert.equal(ui.store().snapshot().progressDrafts['occurrence-a'], '4');
  assert.ok(ui.texts().includes('Entered progress: 4'));
  ui.leave();
  assert.equal(ui.timerCount(), 0);
});

for (const [code, state, message] of [['occurrence_closed', 'missed', /deadline has passed/],
  ['occurrence_locked', 'excused', /locked by an excuse/]]) {
  test(`target ${code} preserves the draft through failed automatic refresh and blocks another assignment`, async () => {
    let reads = 0, writes = 0;
    const ui = await screen(async () => {
      reads++;
      if (reads === 2) throw new ApiError('offline', null, 'network_error');
      return openToday({ occurrences: [targetOccurrence({ state: reads > 2 ? state : 'in_progress' })] });
    }, undefined, undefined, undefined, async () => { writes++; throw new ApiError('private reason', 409, code); });
    ui.input().props.onChangeText('7');
    const press = ui.button('Save progress').props.onPress;
    await press();
    assert.equal(reads, 2);
    assert.equal(writes, 1);
    assert.equal(ui.input().props.value, '7');
    assert.equal(ui.input().props.editable, false);
    assert.match(ui.texts().join(' '), message);
    assert.doesNotMatch(ui.texts().join(' '), /private reason/);
    await press();
    assert.equal(writes, 1);
    await ui.button('Refresh Today').props.onPress();
    assert.equal(ui.button('Save progress'), undefined);
    assert.equal(ui.list().data[0].state, state);
    assert.equal(ui.store().snapshot().progressDrafts['occurrence-a'], '7');
    assert.ok(ui.texts().includes('Entered progress: 7'));
  });
}

for (const failure of [new ApiError('private timeout', null, 'request_timeout'), new ApiError('private network', null, 'network_error'),
  new ApiError('private server', 503, 'http_503'), new ApiError('private response', 200, 'invalid_response')]) {
  test(`ambiguous target ${failure.code} keeps the draft and requires a successful refresh without repeating the assignment`, async () => {
    let reads = 0, writes = 0;
    const refreshed = targetOccurrence({ progress: 7, updated_at: '2026-10-10T12:01:00Z' });
    const ui = await screen(async () => {
      reads++;
      if (reads === 2) throw new ApiError('offline', null, 'network_error');
      return openToday({ occurrences: [reads > 2 ? refreshed : targetOccurrence()] });
    }, undefined, undefined, undefined, async () => { writes++; throw failure; });
    ui.input().props.onChangeText('007');
    const press = ui.button('Save progress').props.onPress;
    await press();
    assert.equal(reads, 1, 'an ambiguous write offers refresh rather than automatically reading or repeating');
    assert.match(ui.texts().join(' '), /may have succeeded/);
    assert.doesNotMatch(ui.texts().join(' '), /private/);
    assert.equal(ui.input().props.value, '007');
    assert.equal(ui.input().props.editable, false);
    await press();
    ui.input().props.onChangeText('3');
    assert.equal(ui.input().props.value, '007');
    await ui.button('Refresh Today').props.onPress();
    assert.equal(ui.button('Save progress').props.disabled, true);
    assert.equal(ui.input().props.value, '007');
    await press();
    await ui.button('Refresh Today').props.onPress();
    assert.equal(reads, 3);
    assert.equal(writes, 1);
    assert.equal(ui.list().data[0], refreshed);
    assert.equal(ui.input().props.value, '007');
    assert.equal(ui.input().props.editable, true);
    assert.equal(ui.button('Refresh Today'), undefined);
  });
}

test('a target read started before an ambiguous outcome cannot release its guard or erase its draft', async () => {
  const mutation = deferred(), oldRead = deferred();
  let reads = 0, writes = 0;
  const ui = await screen(() => ++reads === 1 ? Promise.resolve(openToday({ occurrences: [targetOccurrence()] })) : oldRead.promise,
    undefined, undefined, undefined, () => { writes++; return mutation.promise; });
  ui.input().props.onChangeText('9');
  const pending = ui.button('Save progress').props.onPress();
  const refresh = ui.list().onRefresh();
  mutation.reject(new ApiError('timeout', null, 'request_timeout'));
  await pending;
  oldRead.resolve(openToday({ occurrences: [targetOccurrence()] }));
  await refresh;
  assert.equal(ui.button('Save progress').props.disabled, true);
  assert.equal(ui.input().props.value, '9');
  await ui.button('Save progress').props.onPress();
  assert.equal(writes, 1);
});

for (const outcome of ['success', 'failure']) test(`confirmed target reduction survives an older read ${outcome} and failed subsequent refresh`, async () => {
  const mutation = deferred(), oldRead = deferred(), latestRead = deferred();
  let reads = 0;
  const initial = openToday({ occurrences: [targetOccurrence({ progress: 12, completed: true, state: 'completed' })] });
  const confirmed = targetOccurrence({ progress: 4, updated_at: '2026-10-10T12:01:00Z' });
  const ui = await screen(() => [Promise.resolve(initial), oldRead.promise, latestRead.promise][reads++],
    undefined, undefined, undefined, () => mutation.promise);
  ui.input().props.onChangeText('4');
  const refreshing = ui.list().onRefresh();
  const pending = ui.button('Save progress').props.onPress();
  mutation.resolve(confirmed);
  await flush();
  assert.equal(ui.list().data[0], confirmed);
  assert.equal(ui.input().props.value, '4');
  const accepted = ui.store().snapshot();
  if (outcome === 'success') oldRead.resolve(initial);
  else oldRead.reject(new Error('old failure'));
  await refreshing;
  assert.equal(ui.store().snapshot(), accepted);
  latestRead.reject(new ApiError('offline', null, 'network_error'));
  await pending;
  assert.equal(reads, 3);
  assert.equal(ui.list().data[0], confirmed);
  assert.ok(ui.texts().includes('Status: In progress'));
  assert.ok(ui.texts().includes('Showing the last loaded date and habits.'));
  assert.ok(ui.button('Retry loading'));
});

test('a same-day token refresh keeps the target draft and write guard while next requests use renewed credentials', async () => {
  const mutation = deferred();
  const readSessions = [], writeSessions = [];
  const confirmed = targetOccurrence({ progress: 4, updated_at: '2026-10-10T12:01:00Z' });
  const ui = await screen(async s => {
    readSessions.push(s);
    return openToday({ occurrences: [readSessions.length > 2 ? confirmed : targetOccurrence()] });
  }, undefined, undefined, undefined, s => { writeSessions.push(s); return mutation.promise; });
  ui.input().props.onChangeText('4');
  const pending = ui.button('Save progress').props.onPress();
  const renewed = { ...session(), access_token: 'renewed-token' };
  ui.event(renewed);
  await flush();
  assert.equal(readSessions[1], renewed);
  assert.equal(ui.input().props.value, '4');
  assert.equal(ui.button('Save progress').props.disabled, true);
  await ui.button('Save progress').props.onPress();
  assert.equal(writeSessions.length, 1);
  mutation.resolve(confirmed);
  await pending;
  assert.equal(readSessions[2], renewed);
  assert.equal(ui.input().props.editable, true);
});

test('concurrent binary and target writes keep each row isolated across interleaved confirmation refreshes', async () => {
  const binaryWrite = deferred(), targetWrite = deferred(), oldRead = deferred(), latestRead = deferred();
  let reads = 0;
  const rows = [occurrence(), targetOccurrence({ id: 'target-row', habit_id: 'target-habit' })];
  const confirmed = [completedOccurrence(), targetOccurrence({ id: 'target-row', habit_id: 'target-habit',
    progress: 12, completed: true, state: 'completed', updated_at: '2026-10-10T12:01:00Z' })];
  const ui = await screen(() => [Promise.resolve(openToday({ occurrences: rows })), oldRead.promise, latestRead.promise][reads++],
    undefined, undefined, () => binaryWrite.promise, () => targetWrite.promise);
  ui.input('target-row').props.onChangeText('12');
  const targetPending = ui.button('Save progress', 'target-row').props.onPress();
  assert.ok(!ui.button('Complete', 'occurrence-a').props.disabled);
  const binaryPending = ui.button('Complete', 'occurrence-a').props.onPress();
  binaryWrite.resolve(confirmed[0]);
  await flush();
  assert.ok(ui.button('Undo', 'occurrence-a'));
  assert.equal(ui.input('target-row').props.value, '12');
  assert.equal(ui.button('Save progress', 'target-row').props.disabled, true);
  targetWrite.resolve(confirmed[1]);
  await flush();
  assert.equal(reads, 3);
  const accepted = ui.store().snapshot();
  oldRead.resolve(openToday({ occurrences: [confirmed[0], rows[1]] }));
  await binaryPending;
  assert.equal(ui.store().snapshot(), accepted);
  latestRead.resolve(openToday({ occurrences: confirmed }));
  await targetPending;
  assert.equal(ui.list().data[0], confirmed[0]);
  assert.equal(ui.list().data[1], confirmed[1]);
  assert.equal(ui.input('target-row').props.value, '12');
  assert.equal(ui.input('target-row').props.editable, true);
});

test('mismatched target confirmations preserve the draft and require refresh without changing the row', async () => {
  for (const changes of [{ progress: 8 }, { completed: true }, { state: 'excused' },
    { snapshot: { ...targetOccurrence().snapshot, target: 20 } }, { snapshot: { ...targetOccurrence().snapshot, unit: 'minutes' } },
    { owner_id: 'another-owner' }, { local_date: '2026-10-11' }, { updated_at: 'invalid' }]) {
    let writes = 0;
    const original = targetOccurrence();
    const ui = await screen(async () => openToday({ occurrences: [original] }), undefined, undefined, undefined,
      async () => { writes++; return targetOccurrence({ progress: 7, updated_at: '2026-10-10T12:01:00Z', ...changes }); });
    ui.input().props.onChangeText('7');
    await ui.button('Save progress').props.onPress();
    assert.equal(ui.list().data[0], original, JSON.stringify(changes));
    assert.equal(ui.input().props.value, '7');
    assert.equal(ui.button('Save progress').props.disabled, true);
    assert.ok(ui.button('Refresh Today'));
    await ui.button('Save progress').props.onPress();
    assert.equal(writes, 1);
    ui.leave();
  }
});

for (const outcome of ['success', 'failure']) test(`navigation clears target drafts and ignores late ${outcome} while preserving a returned write guard`, async () => {
  const mutation = deferred();
  let reads = 0, writes = 0;
  const ui = await screen(async () => { reads++; return openToday({ occurrences: [targetOccurrence()] }); },
    undefined, undefined, undefined, () => { writes++; return mutation.promise; });
  ui.input().props.onChangeText('6');
  const input = ui.input().props.onChangeText, press = ui.button('Save progress').props.onPress;
  const pending = press();
  ui.leave();
  cleared(ui);
  assert.equal(Object.keys(ui.store().snapshot().progressDrafts).length, 0);
  input('99');
  await press();
  assert.equal(writes, 1);
  ui.focus();
  await flush();
  assert.equal(ui.input().props.value, '0');
  assert.equal(ui.button('Save progress').props.disabled, true);
  if (outcome === 'success') mutation.resolve(targetOccurrence({ progress: 6, updated_at: '2026-10-10T12:01:00Z' }));
  else mutation.reject(new ApiError('old failure', 409, 'occurrence_locked'));
  await pending;
  assert.equal(ui.list().data[0].progress, 0);
  assert.equal(ui.button('Save progress').props.disabled, true);
  assert.doesNotMatch(ui.texts().join(' '), /old failure|locked by an excuse/);
  await ui.button('Refresh Today').props.onPress();
  assert.equal(reads, 3);
  assert.equal(writes, 1);
  assert.equal(ui.input().props.editable, true);
});

for (const outcome of ['success', 'failure']) test(`account switch clears target drafts and rejects stale ${outcome} with a repeated occurrence ID`, async () => {
  const mutation = deferred();
  let writes = 0;
  const ui = await screen(async s => openToday({ occurrences: [targetOccurrence({ owner_id: s.user.id,
    snapshot: { ...targetOccurrence().snapshot, name: `${s.user.id} target` } })] }),
  undefined, undefined, undefined, () => { writes++; return mutation.promise; });
  ui.input().props.onChangeText('7');
  const input = ui.input().props.onChangeText, press = ui.button('Save progress').props.onPress;
  const pending = press();
  ui.event(session('b'));
  assert.equal(Object.keys(ui.store().snapshot().progressDrafts).length, 0);
  await flush();
  assert.equal(ui.input().props.value, '0');
  assert.equal(ui.input().props.editable, true);
  assert.ok(ui.texts().includes('b target'));
  input('55');
  await press();
  const accepted = ui.store().snapshot();
  if (outcome === 'success') mutation.resolve(targetOccurrence({ progress: 7, updated_at: '2026-10-10T12:01:00Z' }));
  else mutation.reject(new ApiError('old failure', null, 'network_error'));
  await pending;
  assert.equal(ui.store().snapshot(), accepted);
  assert.equal(writes, 1);
  assert.equal(Object.keys(ui.store().snapshot().completions).length, 0);
});

for (const outcome of ['success', 'failure']) test(`midnight refresh clears target drafts and ignores previous-date ${outcome}`, async () => {
  const mutation = deferred();
  let reads = 0, writes = 0;
  const nextDay = openToday({ local_date: '2026-10-11', server_time: '2026-10-11T12:00:00Z',
    occurrences: [targetOccurrence({ id: 'next-day', local_date: '2026-10-11', closes_at: '2026-10-12T00:00:00Z' })] });
  const ui = await screen(async () => ++reads === 1 ? openToday({ occurrences: [targetOccurrence()] }) : nextDay,
    undefined, undefined, undefined, () => { writes++; return mutation.promise; });
  ui.input().props.onChangeText('5');
  const press = ui.button('Save progress').props.onPress;
  const pending = press();
  await ui.list().onRefresh();
  assert.equal(Object.keys(ui.store().snapshot().progressDrafts).length, 0);
  const accepted = ui.store().snapshot();
  await press();
  if (outcome === 'success') mutation.resolve(targetOccurrence({ progress: 5, updated_at: '2026-10-10T12:01:00Z' }));
  else mutation.reject(new ApiError('old failure', null, 'network_error'));
  await pending;
  assert.equal(ui.store().snapshot(), accepted);
  assert.equal(writes, 1);
  assert.equal(ui.input('next-day').props.value, '0');
});

test('sign-out clears target drafts immediately and late progress cannot restore them', async () => {
  const mutation = deferred(), logout = deferred();
  const ui = await screen(async () => openToday({ occurrences: [targetOccurrence()] }),
    undefined, undefined, undefined, () => mutation.promise);
  ui.input().props.onChangeText('9');
  const pending = ui.button('Save progress').props.onPress();
  ui.auth.signOut = () => logout.promise;
  const signingOut = ui.sessions.signOut();
  cleared(ui);
  assert.equal(Object.keys(ui.store().snapshot().progressDrafts).length, 0);
  mutation.resolve(targetOccurrence({ progress: 9, updated_at: '2026-10-10T12:01:00Z' }));
  await pending;
  cleared(ui);
  logout.resolve({ error: null });
  await signingOut;
});

test('Home links to Today and its route is protected for ready accounts only', () => {
  let status = 'ready';
  const Stack = props => ({ type: 'Stack', props });
  Stack.Screen = 'Screen';
  Stack.Protected = 'Protected';
  const modules = {
    'react/jsx-runtime': runtime,
    'expo-router': { Link: 'Link', Stack },
    'react-native': { Button: 'Button', Text: 'Text' },
    'expo-notifications': { setNotificationHandler() {} },
    '../lib/notification-runtime': { notificationService: { canPresent: () => false } },
    '../components/form': { Form: 'Form', styles: {} },
    '../lib/session-store': { routeAccess },
    '../lib/auth-link-context': { AuthLinkProvider: props => props.children, useAuthLink: () => ({ phase: 'idle' }) },
    '../lib/session': { SessionProvider: props => props.children,
      useSession: () => ({ status, session: session(), profile: profile('a'), store: { signOut() {} } }) },
  };
  const load = path => compile(path, name => { assert.ok(modules[name], `Unexpected module ${name}`); return modules[name]; });
  const Home = load('app/home.tsx').default;
  assert.ok(nodes(Home()).some(node => node.type === 'Link' && node.props.href === '/today' && text(node) === 'Today'));
  const Layout = load('app/_layout.tsx').default;
  for (status of ['ready', 'startup', 'loading', 'signed_out', 'profile_required', 'failure']) {
    const guards = nodes(Layout()).filter(node => node.type === 'Protected' && nodes(node.props.children).some(child => child.type === 'Screen' && child.props.name === 'today'));
    assert.equal(guards.length, 1);
    assert.equal(guards[0].props.guard, status === 'ready');
  }
});
