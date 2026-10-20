const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Render the actual route, view, and store. Native elements and Auth/API are
// substituted; confirmation handlers still run the production state machine.
function compile(path, dependencies) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../${path}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Error, process: { env: {} }, require: dependencies });
  return exports;
}
const cache = {};
const lib = name => cache[name] ??= compile(`lib/${name}.ts`, path => lib(path.slice(2)));
const { PendingExcusesStore } = lib('pending-excuses-store');
const { ApiError } = lib('api');
const jsx = (type, props, key) => typeof type === 'function' ? type(props) : { type, props, key };
const runtime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
const native = { ActivityIndicator: 'ActivityIndicator', Button: 'Button', RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: value => value } };
const form = { styles: {} };
const view = compile('components/excuse-view.tsx', name => ({
  'react/jsx-runtime': runtime, 'react-native': native, './form': form,
})[name]);
const flush = () => new Promise(resolve => setImmediate(resolve));
const pending = () => ({ id: 'excuse-1', occurrence_id: 'occurrence-1', habit_id: 'habit-1', owner_id: 'owner',
  explanation: 'Recovering from an injury', status: 'pending', decision_source: null, decided_by: null, decided_at: null,
  created_at: '2026-10-17T22:00:00Z', occurrence: {
    id: 'occurrence-1', habit_id: 'habit-1', owner_id: 'owner', local_date: '2026-10-17',
    timezone: 'America/Los_Angeles', closes_at: '2026-10-18T07:00:00Z', snapshot: {
      name: 'Stored reading plan', type: 'target', target: 20, unit: 'pages', schedule: 'daily', weekdays: [], reminder_times: [],
    }, state: 'justification_pending', progress: 3, completed: false,
  } });
function settled(row, decision) {
  return { ...row, status: decision === 'approve' ? 'approved' : 'rejected', decision_source: 'friend',
    decided_by: 'friend', decided_at: '2026-10-19T18:00:00Z',
    occurrence: { ...row.occurrence, state: decision === 'approve' ? 'excused' : 'missed' } };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree && typeof tree === 'object' ? text(tree.props.children) : '';
}
async function screen(overrides = {}) {
  let store, focus, cleanup;
  let row = pending();
  const calls = [];
  const session = { user: { id: 'friend' }, access_token: 'friend-token' };
  const sessions = { snapshot: () => ({ status: 'ready', session }), subscribe: () => () => {} };
  const appStateListeners = new Set();
  const AppState = { currentState: 'active', addEventListener: (_event, callback) => {
    appStateListeners.add(callback); return { remove: () => appStateListeners.delete(callback) };
  } };
  const api = {
    listPendingExcuses: async () => overrides.list ? overrides.list() : row.status === 'pending' ? [row] : [],
    readExcuse: async () => overrides.read ? overrides.read() : row,
    decideExcuse: async (s, id, decision) => {
      calls.push({ session: s, id, decision });
      return overrides.decide ? overrides.decide(s, id, decision) : row = settled(row, decision);
    },
  };
  const dependencies = {
    'react/jsx-runtime': runtime,
    react: { useCallback: fn => fn, useState: initial => [store ??= initial()], useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    'expo-router': { Link: 'Link', useFocusEffect: callback => { focus = callback; } },
    'react-native': { ...native, AppState }, '../components/form': form, '../components/excuse-view': view,
    '../lib/api': api, '../lib/pending-excuses-store': { PendingExcusesStore },
    '../lib/session': { useSession: () => ({ store: sessions }) },
  };
  const Component = compile('app/pending-excuses.tsx', name => {
    assert.ok(dependencies[name], `Unexpected dependency: ${name}`); return dependencies[name];
  }).default;
  const render = () => nodes(Component());
  render(); cleanup = focus(); await flush();
  const ui = {
    calls, render, state: () => store.snapshot(),
    text: () => render().filter(node => node.type === 'Text').map(text).join(' '),
    button: title => render().find(node => node.type === 'Button' && node.props.title === title),
    press: title => {
      const button = ui.button(title);
      assert.ok(button, `Missing button: ${title}`);
      assert.ok(!button.props.disabled, `Disabled button: ${title}`);
      return button.props.onPress();
    },
    refresh: () => render().find(node => node.type === 'ScrollView').props.refreshControl.props.onRefresh(),
    appState: next => { AppState.currentState = next; appStateListeners.forEach(listener => listener(next)); },
    leave: () => cleanup(),
  };
  return ui;
}

for (const decision of ['approve', 'reject']) {
  test(`pending screen displays stored older occurrence and requires explicit ${decision} confirmation`, async () => {
    const ui = await screen();
    for (const expected of ['Stored reading plan', '2026-10-17', 'America/Los_Angeles', '2026-10-18T07:00:00Z',
      'Progress: 3 / 20 pages', 'Recovering from an injury', 'Submitted: 2026-10-17T22:00:00Z',
      'Decisions have no midnight deadline', 'first valid approval or rejection is final']) {
      assert.ok(ui.text().includes(expected), expected);
    }
    const action = decision === 'approve' ? 'Approve excuse' : 'Reject excuse';
    const confirmation = decision === 'approve' ? 'Confirm approval' : 'Confirm rejection';
    assert.equal(ui.button(confirmation), undefined);
    ui.press(action);
    assert.equal(ui.calls.length, 0, 'The initial button must not mutate');
    assert.match(ui.text(), /permanent and cannot be changed by you, another friend, or the owner/);
    assert.match(ui.text(), decision === 'approve' ? /occurrence will be excused/ : /occurrence will be missed/);
    const staleConfirm = ui.button(confirmation).props.onPress;
    ui.press('Cancel decision');
    assert.equal(ui.button(confirmation), undefined);
    assert.ok(ui.button(action));
    await staleConfirm();
    assert.equal(ui.calls.length, 0, 'A captured cancelled confirmation must be harmless');
    ui.press(action);
    await ui.press(confirmation);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].decision, decision);
    assert.equal(ui.calls[0].id, 'excuse-1');
    assert.equal(ui.button('Approve excuse'), undefined);
    assert.equal(ui.button('Reject excuse'), undefined);
    assert.equal(ui.button(confirmation), undefined);
    assert.match(ui.text(), decision === 'approve' ? /current server decision is approved/ : /current server decision is rejected/);
    assert.match(ui.text(), /Progress: 3 \/ 20 pages/);
    assert.match(ui.text(), /Decision: Friend.*Decided at: 2026-10-19T18:00:00Z/);
  });
}

test('access loss at confirmation clears rendered explanation and every actionable decision button', async () => {
  let denied = false;
  const ui = await screen({ list: async () => denied ? [] : [pending()],
    decide: async () => { denied = true; throw new ApiError('Excuse not found', 404, 'excuse_not_found'); },
    read: async () => { throw new ApiError('Excuse not found', 404, 'excuse_not_found'); } });
  ui.press('Approve excuse');
  const staleConfirm = ui.button('Confirm approval').props.onPress;
  await ui.press('Confirm approval');
  assert.doesNotMatch(ui.text(), /Recovering from an injury|Stored reading plan|approval was saved/);
  assert.match(ui.text(), /no longer accessible/);
  for (const title of ['Approve excuse', 'Reject excuse', 'Confirm approval', 'Confirm rejection', 'Cancel decision']) {
    assert.equal(ui.button(title), undefined, title);
  }
  await staleConfirm();
  assert.equal(ui.calls.length, 1);
});

test('backgrounding clears an open confirmation; foreground access denial cannot revive its controls', async () => {
  let denied = false;
  const ui = await screen({ list: async () => denied ? [] : [pending()] });
  ui.press('Reject excuse');
  const staleConfirm = ui.button('Confirm rejection').props.onPress;
  ui.appState('background');
  assert.doesNotMatch(ui.text(), /Recovering from an injury|Stored reading plan/);
  assert.equal(ui.button('Confirm rejection'), undefined);
  denied = true;
  ui.appState('active'); await flush();
  await staleConfirm();
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.button('Approve excuse'), undefined);
  assert.equal(ui.button('Reject excuse'), undefined);
  assert.match(ui.text(), /No excuses currently need your decision/);
});
