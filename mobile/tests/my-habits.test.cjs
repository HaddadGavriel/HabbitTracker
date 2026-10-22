const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Render real screen handlers and the real store with host elements and fake API/auth.
const cache = {};
function lib(name) {
  if (cache[name]) return cache[name];
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: path => lib(path.slice(2)), process: { env: {} } });
  return cache[name] = exports;
}
const { HabitsStore } = lib('habits-store');
const { ApiError } = lib('api');
const habit = (changes = {}) => ({
  id: 'habit-a', owner_id: 'a', name: 'Read', type: 'binary', target: null, unit: null,
  description: null, schedule: 'daily', weekdays: [], reminder_times: ['08:00'], archived_at: null,
  created_at: '2026-10-10T12:00:00Z', updated_at: '2026-10-10T12:00:00Z', ...changes,
});
const archived = () => habit({ archived_at: '2026-10-10T13:00:00Z' });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
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
  if (typeof tree === 'string') return tree;
  return tree && typeof tree === 'object' ? text(tree.props.children) : '';
}
async function screen(listHabits, restoreHabit = async () => habit()) {
  let store, focus, cleanup;
  const listeners = new Set();
  let current = { status: 'ready', session: { user: { id: 'a' }, access_token: 'a-token' } };
  const sessions = { snapshot: () => current, subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); } };
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    react: { useCallback: fn => fn, useState: initial => [store ??= initial()], useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    'expo-router': { Link: 'Link', useFocusEffect: callback => { focus = callback; } },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Button: 'Button', FlatList: 'FlatList',
      Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: value => value } },
    '../components/form': { styles: {} },
    '../lib/api': { listHabits, restoreHabit },
    '../lib/habit-labels': lib('habit-labels'),
    '../lib/habits-store': { HabitsStore },
    '../lib/local-reminder-runtime': { localReminderService: { changed: async () => {} } },
    '../lib/session': { useSession: () => ({ store: sessions }) },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../app/my-habits.tsx`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => { assert.ok(modules[name], `Unexpected module ${name}`); return modules[name]; } });
  const render = () => nodes(exports.default());
  render();
  cleanup = focus();
  await flush();
  const result = {
    render, store: () => store,
    button(title) { return render().find(node => node.type === 'Button' && node.props.title === title); },
    tab(label) { return render().find(node => node.type === 'Pressable' && node.props.accessibilityRole === 'tab' && text(node) === label); },
    press(title) { const button = result.button(title); assert.ok(button, `Missing button ${title}`); return button.props.onPress(); },
    leave() { cleanup(); },
    account(id) { current = { status: 'ready', session: { user: { id }, access_token: `${id}-token` } }; listeners.forEach(listener => listener()); },
  };
  return result;
}

test('My habits renders Active as the selected backend filter and retains creation/edit links', async () => {
  const statuses = [];
  const ui = await screen(async (_s, status) => { statuses.push(status); return [habit()]; });
  assert.deepEqual(statuses, ['active']);
  assert.equal(ui.tab('Active').props.accessibilityState.selected, true);
  assert.equal(ui.tab('Archived').props.accessibilityState.selected, false);
  assert.ok(ui.render().some(node => node.type === 'Link' && node.props.href === '/create-habit'));
  assert.ok(ui.render().some(node => node.type === 'Link' && node.props.href.pathname === '/edit-habit'));
  assert.ok(ui.render().some(node => node.type === 'Pressable' && node.props.accessibilityLabel === 'Edit Read'));
  assert.equal(ui.button('Restore'), undefined);
});

test('active and archived owned cards link directly to history and sharing without restoring', async () => {
  let restores = 0;
  const ui = await screen(async (_session, status) => status === 'active'
    ? [habit({ id: 'active-id', name: 'Active habit' })]
    : [habit({ id: 'archived-id', name: 'Archived habit', archived_at: '2026-10-10T13:00:00Z' })],
  async () => { restores++; return habit(); });
  for (const status of ['active', 'archived']) {
    if (status === 'archived') {
      ui.tab('Archived').props.onPress();
      await flush();
    }
    const links = ui.render().filter(node => node.type === 'Link' && node.props.href.pathname === '/habit-history');
    assert.equal(links.length, 1);
    assert.equal(links[0].props.href.params.id, `${status}-id`);
    assert.equal(links[0].props.accessibilityLabel, `View history for ${status === 'active' ? 'Active' : 'Archived'} habit`);
    assert.equal(text(links[0]), 'View history');
    const sharing = ui.render().filter(node => node.type === 'Link' && node.props.href.pathname === '/manage-sharing');
    assert.equal(sharing.length, 1);
    assert.equal(sharing[0].props.href.params.id, `${status}-id`);
    assert.equal(sharing[0].props.accessibilityLabel, `Manage sharing for ${status === 'active' ? 'Active' : 'Archived'} habit`);
    assert.equal(text(sharing[0]), 'Manage sharing');
    assert.equal(ui.button('Confirm restore'), undefined);
    assert.equal(restores, 0);
  }
});

test('Archived cards are noneditable and restore needs confirmation with a working Cancel button', async () => {
  let restores = 0;
  const statuses = [];
  const ui = await screen(async (_s, status) => { statuses.push(status); return [archived()]; }, async () => { restores++; return habit(); });
  ui.tab('Archived').props.onPress();
  await flush();
  assert.deepEqual(statuses, ['active', 'archived']);
  assert.equal(ui.tab('Archived').props.accessibilityState.selected, true);
  assert.ok(!ui.render().some(node => node.type === 'Link' && node.props.href.pathname === '/edit-habit'));
  assert.ok(!ui.render().some(node => node.type === 'Pressable' && node.props.accessibilityLabel === 'Edit Read'));
  assert.equal(ui.button('Restore').props.disabled, false);
  ui.press('Restore');
  assert.equal(restores, 0);
  assert.ok(ui.render().some(node => node.type === 'Text' && /Restore.*Read.*history preserved/.test(text(node))));
  ui.press('Cancel restore');
  assert.equal(ui.button('Confirm restore'), undefined);
  assert.equal(restores, 0);
});

test('confirm restore disables repeat actions, shows loading, and refreshes the archived list after success', async () => {
  const mutation = deferred(), refreshed = deferred();
  let restores = 0, reads = 0;
  const ui = await screen(async () => ++reads > 2 ? refreshed.promise : [archived()], async () => { restores++; return mutation.promise; });
  ui.tab('Archived').props.onPress();
  await flush();
  ui.press('Restore');
  const confirm = ui.button('Confirm restore');
  const pending = confirm.props.onPress();
  await confirm.props.onPress();
  assert.equal(restores, 1);
  assert.equal(ui.button('Restoring…').props.disabled, true);
  assert.ok(ui.render().some(node => node.type === 'ActivityIndicator' && node.props.accessibilityLabel === 'Restoring Read'));
  mutation.resolve(habit());
  await flush();
  assert.equal(reads, 3);
  assert.equal(ui.render().find(node => node.type === 'FlatList').props.refreshing, true);
  refreshed.resolve([]);
  await pending;
  assert.ok(ui.render().some(node => node.type === 'Text' && text(node) === 'No archived habits.'));
  assert.equal(ui.button('Restore'), undefined);
});

test('ambiguous restore exposes current-state refresh and disables retry until that read succeeds', async () => {
  const refreshed = deferred();
  let restores = 0, reads = 0;
  const ui = await screen(async () => ++reads > 2 ? refreshed.promise : [archived()], async () => {
    restores++;
    throw new ApiError('Deadline', null, 'request_timeout');
  });
  ui.tab('Archived').props.onPress();
  await flush();
  ui.press('Restore');
  await ui.press('Confirm restore');
  assert.ok(ui.render().some(node => node.type === 'Text' && /may have succeeded.*Refresh current server state/.test(text(node))));
  assert.equal(ui.button('Restore').props.disabled, true);
  assert.equal(restores, 1);
  const recovery = ui.button('Refresh current server state');
  const pending = recovery.props.onPress();
  await recovery.props.onPress();
  assert.equal(reads, 3);
  assert.equal(ui.button('Refresh current server state').props.disabled, true);
  assert.equal(ui.button('Restore').props.disabled, true);
  refreshed.resolve([archived()]);
  await pending;
  assert.equal(ui.button('Refresh current server state'), undefined);
  assert.equal(ui.button('Restore').props.disabled, false);
  assert.equal(restores, 1);
});

test('list failures render retry and retain the relevant empty/loading state', async () => {
  let reads = 0;
  const loading = deferred();
  const ui = await screen(async () => { if (++reads === 1) throw new ApiError('Offline', null, 'network_error'); return loading.promise; });
  assert.ok(ui.render().some(node => node.type === 'Text' && /connection.*retry/i.test(text(node))));
  assert.ok(!ui.render().some(node => node.type === 'Text' && text(node) === 'No active habits yet.'));
  const retry = ui.button('Retry loading');
  const pending = retry.props.onPress();
  await retry.props.onPress();
  assert.equal(reads, 2);
  assert.ok(ui.render().some(node => node.type === 'ActivityIndicator' && node.props.accessibilityLabel === 'Loading habits'));
  loading.resolve([]);
  await pending;
  assert.ok(ui.render().some(node => node.type === 'Text' && text(node) === 'No active habits yet.'));
});

test('captured confirmation handlers cannot restore after filter, account, or navigation changes', async () => {
  for (const change of ['filter', 'account', 'navigation']) {
    let restores = 0;
    const ui = await screen(async s => [archived(), habit({ owner_id: s.user.id })].filter(item => item.owner_id === s.user.id), async () => { restores++; return habit(); });
    ui.tab('Archived').props.onPress();
    await flush();
    ui.press('Restore');
    const confirm = ui.button('Confirm restore');
    if (change === 'filter') ui.tab('Active').props.onPress();
    if (change === 'account') ui.account('b');
    if (change === 'navigation') ui.leave();
    await confirm.props.onPress();
    await flush();
    assert.equal(restores, 0);
    assert.equal(ui.button('Confirm restore'), undefined);
    assert.equal(ui.button('Restore'), undefined);
  }
});
