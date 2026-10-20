const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Actual routes, view component and stores; only native elements, Auth and the
// shared read API are substituted. This is UI coverage, not server enforcement.
function compile(path, dependencies) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../${path}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Error, process: { env: {} }, require: dependencies });
  return exports;
}
const cache = {};
const lib = name => cache[name] ??= compile(`lib/${name}.ts`, path => lib(path.slice(2)));
const { SharedHabitsStore } = lib('shared-habits-store');
const { SessionStore, routeAccess } = lib('session-store');
const { ApiError } = lib('api');
const habitId = 'aaaaaaaa-1111-4111-8111-111111111111';
const secondHabitId = 'bbbbbbbb-2222-4222-8222-222222222222';
const session = (id = 'recipient-a', token = `${id}-token`) => ({ user: { id }, access_token: token });
const profile = id => ({ user_id: id, username: id, display_name: id, timezone: 'America/Los_Angeles' });
const snapshot = (changes = {}) => ({ name: 'Read chapter', description: 'Original reading plan', type: 'target', target: 10,
  unit: 'pages', schedule: 'selected', weekdays: [2], reminder_times: ['19:00'], ...changes });
const occurrence = (changes = {}) => ({ id: 'original-occurrence', local_date: '2026-10-19', timezone: 'Pacific/Honolulu',
  closes_at: '2026-10-20T10:00:00Z', snapshot: snapshot(), progress: 10, completed: true, state: 'completed', ...changes });
const shared = (changes = {}) => ({ id: habitId,
  owner: { user_id: 'owner-a', username: 'book_friend', display_name: 'Book Friend' },
  configuration: snapshot({ name: 'Current training', description: 'Current description', target: 20, unit: 'minutes',
    schedule: 'daily', weekdays: [], reminder_times: ['09:00', '21:00'] }),
  local_date: '2026-10-19', timezone: 'Asia/Tokyo', server_time: '2026-10-19T14:00:00Z',
  due_today: true, occurrence: occurrence(), current_streak: 7, provisional: true, calculated_at: '2026-10-19T14:00:00Z', ...changes });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const jsx = (type, props, key) => typeof type === 'function' ? type(props) : { type, props, key };
const runtime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
const native = { ActivityIndicator: 'ActivityIndicator', Button: 'Button', FlatList: 'FlatList',
  RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: value => value } };
const form = { Form: 'Form', Message: ({ text }) => jsx('Text', { children: text }), styles: {} };
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
const viewModules = { 'react/jsx-runtime': runtime, 'react-native': native, './form': form };
const view = compile('components/shared-habit-view.tsx', name => {
  assert.ok(viewModules[name], `Unexpected view dependency: ${name}`); return viewModules[name];
});
async function screen({ mode = 'list', id = habitId, api = {}, readProfile = async s => profile(s.user.id) } = {}) {
  let authEvent, store, focus, cleanup, detailKey;
  const calls = [], navigation = [], appStateListeners = new Set();
  const appState = { currentState: 'active', addEventListener: (_event, callback) => {
    appStateListeners.add(callback); return { remove: () => appStateListeners.delete(callback) };
  } };
  const auth = {
    getSession: async () => ({ data: { session: session() } }),
    onAuthStateChange: callback => { authEvent = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, { readProfile, createProfile: async s => profile(s.user.id) });
  await sessions.start();
  const defaults = { listSharedHabits: async () => [], readSharedHabit: async () => shared() };
  const mockedAPI = Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => [name, (...args) => {
    calls.push({ name, args }); return (api[name] ?? fallback)(...args);
  }]));
  // React remounts the keyed Detail subtree on route-id changes. Model that
  // boundary explicitly so a new id receives a new store and cleans up the old.
  const routeJSX = (type, props, key) => {
    if (typeof type === 'function' && type.name === 'Detail' && key !== detailKey) {
      cleanup?.(); store = undefined; focus = undefined; detailKey = key;
    }
    return jsx(type, props, key);
  };
  const modules = {
    'react/jsx-runtime': { jsx: routeJSX, jsxs: routeJSX, Fragment: 'Fragment' },
    react: { useCallback: fn => fn, useState: initial => [store ??= initial()], useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    'expo-router': { Link: 'Link', useFocusEffect: callback => { focus = callback; }, useLocalSearchParams: () => ({ id }),
      router: { dismissTo: target => navigation.push(target) } },
    'react-native': { ...native, AppState: appState },
    '../components/form': form,
    '../components/shared-habit-view': view,
    '../components/reminder-controls': { ReminderControls: 'ReminderControls' },
    '../lib/api': mockedAPI,
    '../lib/shared-habits-store': { SharedHabitsStore },
    '../lib/session': { useSession: () => ({ ...sessions.snapshot(), store: sessions }) },
  };
  const Component = compile(`app/${mode === 'detail' ? 'shared-habit' : 'shared-habits'}.tsx`, name => {
    assert.ok(modules[name], `Unexpected screen dependency: ${name}`); return modules[name];
  }).default;
  const render = () => nodes(Component());
  render();
  cleanup = focus?.();
  await flush();
  const ui = {
    render, calls, navigation, sessions, auth, state: () => store?.snapshot(),
    texts: () => render().filter(node => node.type === 'Text').map(text),
    text: () => ui.texts().join(' '),
    button: title => render().find(node => node.type === 'Button' && node.props.title === title),
    list: () => render().find(node => node.type === 'FlatList')?.props,
    row: value => {
      const list = ui.list(), item = list.data.find(item => item.id === value);
      return item ? nodes(list.renderItem({ item })) : [];
    },
    refresh: () => mode === 'list' ? ui.list().onRefresh() : render().find(node => node.type === 'ScrollView').props.refreshControl.props.onRefresh(),
    press: title => {
      const button = ui.button(title);
      assert.ok(button, `Missing button: ${title}`);
      assert.ok(!button.props.disabled, `Disabled button: ${title}`);
      return button.props.onPress();
    },
    appState: next => { appState.currentState = next; appStateListeners.forEach(callback => callback(next)); },
    event: value => authEvent(value ? 'SIGNED_IN' : 'SIGNED_OUT', value),
    leave: () => cleanup?.(),
    focus: () => { cleanup = focus?.(); },
    changeId: value => { id = value; render(); cleanup = focus?.(); },
  };
  return ui;
}
const count = (ui, name) => ui.calls.filter(call => call.name === name).length;
function noOwnerControls(ui) {
  for (const node of ui.render()) {
    if (node.type === 'Button') assert.match(node.props.title, /^(Refresh|Retry loading|Back to Friends’ habits)$/);
    if (node.type === 'Link') assert.ok(['/home', '/friends', '/shared-habit', '/pending-excuses', '/excuse-detail'].includes(
      typeof node.props.href === 'string' ? node.props.href : node.props.href.pathname));
    assert.ok(!['TextInput', 'Field'].includes(node.type));
  }
  assert.ok(ui.calls.every(call => ['listSharedHabits', 'readSharedHabit'].includes(call.name)));
}

for (const mode of ['list', 'detail']) test(`${mode}: current configuration is distinct from snapshot progress, owner-local time and server streak`, async () => {
  const value = shared({ owner: { ...shared().owner, email: 'secret@example.test', auth_metadata: 'secret metadata', created_at: 'private timestamp' } });
  const ui = await screen({ mode, api: { listSharedHabits: async () => [value], readSharedHabit: async () => value } });
  const rendered = ui.text();
  for (const expected of ['Owner: Book Friend', '@book_friend', 'Current configuration', 'Current training',
    'Current description', 'Target: 20 minutes', 'Schedule: Every day', 'Saved reminder times: 09:00, 21:00',
    'Owner’s today: 2026-10-19', 'Owner timezone: Asia/Tokyo', 'Due today', 'Today’s occurrence: Read chapter',
    'Original reading plan', 'Progress: 10 / 10 pages', 'State: Completed', 'Occurrence date: 2026-10-19 · Pacific/Honolulu',
    'Original deadline: 2026-10-20T10:00:00Z', 'Current streak: 7 occurrences', 'Provisional',
    'Calculated by the server at 2026-10-19T14:00:00Z']) assert.ok(rendered.includes(expected), expected);
  assert.doesNotMatch(rendered, /Progress: 10 \/ 20|Progress: 10 \/ 10 minutes|secret|private timestamp|owner-a|America\/Los_Angeles/);
  assert.equal(count(ui, mode === 'list' ? 'listSharedHabits' : 'readSharedHabit'), 1);
  assert.equal(count(ui, mode === 'list' ? 'readSharedHabit' : 'listSharedHabits'), 0);
  noOwnerControls(ui);
});

test('list evaluates each owner’s date separately, displays null unscheduled occurrences and keeps their server streak', async () => {
  const rows = [shared(), shared({ id: secondHabitId,
    owner: { user_id: 'owner-b', username: 'night_friend', display_name: 'Night Friend' },
    local_date: '2026-10-18', timezone: 'Pacific/Honolulu', due_today: false, occurrence: null,
    configuration: snapshot({ name: 'Rest day', type: 'binary', target: null, unit: null, reminder_times: [] }),
    current_streak: 1, provisional: false })];
  const ui = await screen({ api: { listSharedHabits: async () => rows } });
  assert.equal(ui.list().data, rows);
  assert.equal(ui.list().keyExtractor(rows[1]), secondHabitId);
  const first = ui.row(habitId).filter(node => node.type === 'Text').map(text).join(' ');
  const second = ui.row(secondHabitId).filter(node => node.type === 'Text').map(text).join(' ');
  assert.match(first, /Owner’s today: 2026-10-19.*Owner timezone: Asia\/Tokyo/);
  assert.match(second, /Owner: Night Friend.*Owner’s today: 2026-10-18.*Owner timezone: Pacific\/Honolulu/);
  assert.match(second, /Not due today.*Current streak: 1 occurrence/);
  assert.match(second, /Binary \(yes\/no\).*Schedule: Tuesday.*Saved reminder times: None/);
  assert.doesNotMatch(second, /Today’s occurrence:|Progress:|Original deadline:|Occurrence date:|Provisional/);
  assert.equal(ui.row(secondHabitId).find(node => node.type === 'Link').props.href.params.id, secondHabitId);
  noOwnerControls(ui);
});

test('binary and all occurrence states are rendered from the server snapshot without inferring state from progress or deadline', async () => {
  const states = ['in_progress', 'completed', 'missed', 'justification_pending', 'excused'];
  const rows = states.map((state, i) => shared({ id: `habit-${i}`, current_streak: 42, provisional: false,
    occurrence: occurrence({ state, completed: state === 'excused', progress: 0,
      snapshot: snapshot({ name: `Binary ${state}`, type: 'binary', target: null, unit: null }) }) }));
  rows.push(shared({ id: 'over-target', occurrence: occurrence({ state: 'excused', completed: false, progress: 13,
    snapshot: snapshot({ unit: null }) }) }));
  const ui = await screen({ api: { listSharedHabits: async () => rows } });
  assert.deepEqual(ui.texts().filter(value => value.startsWith('State:')), [
    'State: In progress', 'State: Completed', 'State: Missed', 'State: Excuse pending', 'State: Excused', 'State: Excused',
  ]);
  assert.equal(ui.texts().filter(value => value === 'Binary: Not completed').length, 4);
  assert.equal(ui.texts().filter(value => value === 'Binary: Completed').length, 1);
  assert.ok(ui.texts().includes('Progress: 13 / 10'));
  assert.equal(ui.texts().filter(value => value === 'Current streak: 42 occurrences').length, 5);
  noOwnerControls(ui);
});

test('recipient UI follows private, grant, archive, restore, revoke, and re-friending responses only after refresh', async () => {
  let granted = false, archived = false, friends = true;
  const authorized = () => granted && !archived && friends;
  const api = {
    listSharedHabits: async () => authorized() ? [shared()] : [],
    readSharedHabit: async () => { if (!authorized()) throw new ApiError('Habit not found', 404, 'habit_not_found'); return shared(); },
  };
  const list = await screen({ api });
  assert.match(list.text(), /Friendship alone does not grant access.*No habits are currently shared/);
  assert.equal(list.list().data.length, 0);
  granted = true;
  await list.press('Refresh');
  assert.equal(list.list().data.length, 1);
  const detail = await screen({ mode: 'detail', api });
  assert.match(detail.text(), /Book Friend/);
  archived = true;
  await Promise.all([list.refresh(), detail.refresh()]);
  assert.equal(list.list().data.length, 0);
  assert.doesNotMatch(detail.text(), /Book Friend|Read chapter|Current streak:/);
  assert.match(detail.text(), /no longer available/);
  assert.ok(detail.button('Back to Friends’ habits'));
  assert.equal(granted, true, 'Archival response did not remove the retained server grant');
  archived = false;
  await Promise.all([list.press('Refresh'), detail.press('Retry loading')]);
  assert.equal(list.list().data.length, 1);
  assert.match(detail.text(), /Book Friend/);
  granted = false;
  await Promise.all([list.refresh(), detail.refresh()]);
  assert.equal(list.list().data.length, 0);
  assert.equal(detail.state().habit, null);
  granted = true;
  await detail.press('Retry loading');
  friends = false; granted = false; // The server deletes grants with friendship.
  await detail.refresh();
  friends = true;
  await Promise.all([list.refresh(), detail.press('Retry loading')]);
  assert.equal(list.list().data.length, 0);
  assert.equal(detail.state().habit, null);
  assert.match(detail.text(), /no longer available/);
  noOwnerControls(list);
  noOwnerControls(detail);
});

for (const mode of ['list', 'detail']) test(`${mode}: focus, explicit refresh and failed-read retry recheck authorization without displaying cached identities`, async () => {
  let reads = 0;
  const refreshing = deferred();
  const read = async () => { reads++; if (reads === 2) return refreshing.promise; return mode === 'list' ? [shared()] : shared(); };
  const ui = await screen({ mode, api: { listSharedHabits: read, readSharedHabit: read } });
  const pending = ui.press('Refresh');
  assert.doesNotMatch(ui.text(), /Book Friend|Read chapter|Current streak:/);
  assert.equal(ui.button('Refresh').props.disabled, true);
  assert.ok(ui.render().some(node => node.type === 'ActivityIndicator'));
  await ui.refresh();
  assert.equal(reads, 2);
  refreshing.reject(new ApiError('private diagnostic', null, 'network_error'));
  await pending;
  assert.match(ui.text(), /connection.*retry/);
  assert.doesNotMatch(ui.text(), /private diagnostic|Book Friend|Read chapter|Current streak:/);
  await ui.press('Retry loading');
  assert.match(ui.text(), /Book Friend/);
  assert.equal(reads, 3);
  ui.leave();
  assert.doesNotMatch(ui.text(), /Book Friend|Read chapter/);
  ui.focus();
  await flush();
  assert.equal(reads, 4);
  assert.match(ui.text(), /Book Friend/);
});

for (const status of [401, 403, 404]) test(`detail HTTP ${status} removes cached data and keeps safe return and recovery controls`, async () => {
  let denied = false;
  const ui = await screen({ mode: 'detail', api: { readSharedHabit: async () => {
    if (denied) throw new ApiError('private backend detail', status, status === 404 ? 'habit_not_found' : `http_${status}`);
    return shared();
  } } });
  denied = true;
  await ui.refresh();
  assert.equal(ui.state().habit, null);
  assert.doesNotMatch(ui.text(), /Book Friend|Read chapter|Current streak:|private backend detail/);
  assert.ok(ui.button('Retry loading'));
  ui.press('Back to Friends’ habits');
  assert.deepEqual(ui.navigation, ['/shared-habits']);
  assert.ok(ui.render().some(node => node.type === 'Link' && node.props.href === '/home'));
});

for (const invalid of [undefined, '', '../habit-history', ['one', 'two'], 'not-a-uuid']) test(`invalid detail id ${JSON.stringify(invalid)} makes no API request and returns safely`, async () => {
  // Passing undefined explicitly requires replacing the harness default id.
  const ui = await screen({ mode: 'detail', id: invalid === undefined ? null : invalid });
  assert.equal(ui.calls.length, 0);
  assert.match(ui.text(), /link is invalid/);
  ui.press('Back to Friends’ habits');
  assert.deepEqual(ui.navigation, ['/shared-habits']);
});

for (const outcome of ['success', 'failure']) test(`changing detail route ids ignores the previous habit’s late ${outcome}`, async () => {
  const previous = deferred();
  const ui = await screen({ mode: 'detail', api: { readSharedHabit: async (_s, id) => id === habitId
    ? previous.promise : shared({ id: secondHabitId, owner: { user_id: 'owner-b', username: 'next_owner', display_name: 'Next Owner' } }) } });
  ui.changeId(secondHabitId.toUpperCase());
  await flush();
  assert.match(ui.text(), /Next Owner/);
  const current = ui.state();
  if (outcome === 'success') previous.resolve(shared());
  else previous.reject(new ApiError('late denial', 404, 'habit_not_found'));
  await flush();
  assert.equal(ui.state(), current);
  assert.doesNotMatch(ui.text(), /Book Friend|late denial|no longer available/);
  assert.equal(ui.calls.at(-1).args[1], secondHabitId);
});

test('normal navigation reaches the shared list and both shared routes require a ready account', () => {
  let state = { status: 'ready', session: session(), profile: profile('recipient-a'), store: { signOut() {} } };
  const Stack = { Screen: 'Screen', Protected: 'Protected' };
  const modules = {
    'react/jsx-runtime': runtime, 'expo-router': { Link: 'Link', Stack }, 'react-native': native,
    'expo-notifications': { setNotificationHandler() {} },
    '../components/notification-tap-gate': { NotificationTapGate: 'NotificationTapGate' },
    '../lib/notification-runtime': { notificationService: { canPresent: () => false } }, '../components/form': form,
    '../lib/session-store': { routeAccess },
    '../lib/auth-link-context': { AuthLinkProvider: props => props.children, useAuthLink: () => ({ phase: 'idle' }) },
    '../lib/session': { SessionProvider: props => props.children, useSession: () => state },
  };
  const load = path => compile(path, name => { assert.ok(modules[name], `Unexpected navigation dependency: ${name}`); return modules[name]; }).default;
  const Home = load('app/home.tsx'), Layout = load('app/_layout.tsx');
  assert.ok(nodes(Home()).some(node => node.type === 'Link' && node.props.href === '/shared-habits' && text(node) === 'Friends’ habits'));
  assert.ok(nodes(Home()).some(node => node.type === 'Link' && node.props.href === '/pending-excuses'));
  for (const status of ['ready', 'startup', 'loading', 'signed_out', 'profile_required', 'failure']) {
    state = { ...state, status };
    for (const route of ['shared-habits', 'shared-habit', 'pending-excuses', 'excuse-detail']) {
      const groups = nodes(Layout()).filter(node => node.type === 'Protected'
        && nodes(node.props.children).some(child => child.type === 'Screen' && child.props.name === route));
      assert.equal(groups.length, 1);
      assert.equal(groups[0].props.guard, status === 'ready', `${route} for ${status}`);
    }
  }
  const before = nodes(Layout()).find(node => node.type === Stack).key;
  state = { ...state, status: 'ready', session: session('recipient-b'), profile: profile('recipient-b') };
  assert.notEqual(nodes(Layout()).find(node => node.type === Stack).key, before, 'Switching accounts remounts the protected stack');
});


test('shared detail links the stored occurrence to its excuse only while authorization is current', async () => {
  let denied = false;
  const ui = await screen({ mode: 'detail', api: { readSharedHabit: async () => {
    if (denied) throw new ApiError('Habit not found', 404, 'habit_not_found');
    return shared({ occurrence: occurrence({ state: 'justification_pending', completed: false, progress: 3 }) });
  } } });
  const links = () => ui.render().filter(node => node.type === 'Link' && node.props.href.pathname === '/excuse-detail');
  assert.equal(links().length, 1);
  assert.equal(links()[0].props.href.params.occurrenceId, 'original-occurrence');
  ui.appState('background');
  assert.equal(links().length, 0);
  assert.doesNotMatch(ui.text(), /Book Friend|Read chapter/);
  denied = true;
  ui.appState('active'); await flush();
  assert.equal(count(ui, 'readSharedHabit'), 2);
  assert.equal(links().length, 0);
  assert.match(ui.text(), /no longer available/);
  denied = false;
  await ui.refresh();
  assert.equal(links().length, 1);
  const refresh = ui.refresh();
  assert.equal(links().length, 0, 'A cached occurrence cannot link to a private explanation while rechecking access');
  await refresh;
  assert.equal(links().length, 1);
});
