const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Real screens/stores with mocked host elements, Auth, API and app lifecycle.
// No native runtime or network is available here.
function compile(path, modules) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../${path}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, process: { env: {} }, require: modules });
  return exports;
}
const cache = {};
const lib = name => cache[name] ??= compile(`lib/${name}.ts`, path => lib(path.slice(2)));
const { TodayStore } = lib('today-store');
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
async function screen(readToday, readProfile = async s => profile(s.user.id), initial = session()) {
  let authEvent, store, focus, cleanup;
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
      Text: 'Text', View: 'View', StyleSheet: { create: value => value } },
    '../components/form': { styles: {} },
    '../lib/api': { readToday },
    '../lib/today-store': { TodayStore },
    '../lib/session': { useSession: () => ({ store: sessions }) },
  };
  const exports = compile('app/today.tsx', name => { assert.ok(modules[name], `Unexpected module ${name}`); return modules[name]; });
  const render = () => nodes(exports.default());
  render();
  cleanup = focus();
  await flush();
  return {
    render, sessions, auth, store: () => store,
    texts: () => render().filter(node => node.type === 'Text').map(text),
    list: () => render().find(node => node.type === 'FlatList').props,
    button: title => render().find(node => node.type === 'Button' && node.props.title === title),
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
  assert.ok(!ui.render().some(node => ['Button', 'Pressable', 'TextInput', 'Link'].includes(node.type)));
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
    '../components/form': { Form: 'Form', styles: {} },
    '../lib/session-store': { routeAccess },
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
