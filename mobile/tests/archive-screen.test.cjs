const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual editor and store handlers with host elements and mocked API.
// No React Native runtime, Auth service, or live data is used.
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Error, require: path => load(path.slice(2)), process: { env: {} } });
  return cache[name] = exports;
}
const { EditHabitStore } = load('edit-habit-store');
const { ApiError } = load('api');
const id = '00000000-0000-0000-0000-000000000001';
const habit = (changes = {}) => ({
  id, owner_id: 'a', name: 'Read', description: null, type: 'binary', target: null, unit: null,
  schedule: 'daily', weekdays: [], reminder_times: ['21:00'], archived_at: null,
  created_at: '2026-10-11T12:00:00Z', updated_at: '2026-10-11T12:00:00Z', ...changes,
});
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props.children)];
}
function mount(overrides = {}) {
  let store, cleanup;
  const navigations = [], calls = { read: 0, save: 0, archive: 0, keyboard: 0 };
  let currentSession = { user: { id: 'a' }, access_token: 'a-token' };
  const listeners = new Set();
  const sessions = { snapshot: () => ({ status: 'ready', session: currentSession }),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    react: { useCallback: fn => fn, useState: init => [store ??= init()],
      useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    'expo-router': {
      router: { dismissTo: path => navigations.push(path) },
      useFocusEffect: effect => { if (!cleanup) cleanup = effect(); },
      useLocalSearchParams: () => ({ id }),
    },
    'react-native': { Button: 'Button', Text: 'Text', Keyboard: { dismiss: () => calls.keyboard++ } },
    '../components/form': { Form: 'Form', Loading: 'Loading', Message: 'Message', styles: {} },
    '../components/habit-fields': { HabitFields: 'HabitFields' },
    '../lib/api': {
      readHabit: (...args) => { calls.read++; return (overrides.read ?? (async session => habit({ owner_id: session.user.id })))(...args); },
      updateHabit: (...args) => { calls.save++; return (overrides.save ?? (async () => habit()))(...args); },
      archiveHabit: (...args) => { calls.archive++; return (overrides.archive ?? (async session => habit({ owner_id: session.user.id, archived_at: '2026-10-11T13:00:00Z' })))(...args); },
    },
    '../lib/edit-habit-store': { EditHabitStore },
    '../lib/session': { useSession: () => ({ store: sessions, profile: { timezone: 'UTC' } }) },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../app/edit-habit.tsx`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => {
    assert.ok(modules[name], `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const render = () => nodes(exports.default());
  const button = title => render().find(node => node.type === 'Button' && node.props.title === title);
  const fields = () => render().find(node => node.type === 'HabitFields');
  render();
  return {
    render, button, fields, calls, navigations, state: () => store.snapshot(), leave: () => cleanup(),
    changeAccount: userId => { currentSession = { user: { id: userId }, access_token: `${userId}-token` }; listeners.forEach(listener => listener()); },
    text: () => render().flatMap(node => node.type === 'Text' ? [node.props.children] : node.type === 'Message' ? [node.props.text] : []).filter(value => typeof value === 'string').join(' '),
    press: title => {
      const target = button(title);
      assert.ok(target, `Missing button: ${title}`);
      assert.ok(!target.props.disabled, `Disabled button: ${title}`);
      return target.props.onPress();
    },
  };
}

test('editor confirmation explains preserved obligations and unsaved edits; cancellation retains the draft', async () => {
  const screen = mount();
  await flush();
  assert.ok(screen.button('Archive habit'));
  assert.equal(screen.button('Confirm archive'), undefined);
  screen.fields().props.onChange({ name: ' ', description: 'Private unfinished note' });
  screen.press('Archive habit');
  assert.match(screen.text(), /preserves your history.*does not erase already-created obligations/i);
  assert.match(screen.text(), /unsaved edits.*discard these edits.*last saved configuration/i);
  assert.equal(screen.fields().props.disabled, true);
  assert.equal(screen.button('Save changes').props.disabled, true);
  assert.equal(screen.calls.archive, 0);
  screen.press('Cancel archive');
  assert.equal(screen.calls.archive, 0);
  assert.equal(screen.calls.save, 0);
  assert.equal(screen.state().draft.name, ' ');
  assert.equal(screen.state().draft.description, 'Private unfinished note');
  assert.equal(screen.fields().props.disabled, false);
  screen.press('Archive habit');
  await screen.press('Confirm archive');
  assert.equal(screen.calls.archive, 1);
  assert.equal(screen.calls.save, 0);
  assert.deepEqual(screen.navigations, ['/my-habits']);
});

test('unchanged editor confirms archive without an unsaved-edits warning', async () => {
  const screen = mount();
  await flush();
  screen.press('Archive habit');
  assert.match(screen.text(), /preserves your history/);
  assert.doesNotMatch(screen.text(), /You have unsaved edits/);
  screen.press('Cancel archive');
  assert.equal(screen.calls.archive, 0);
  assert.equal(screen.state().archive, null);
});

test('old Confirm and Cancel handlers cannot affect a replacement confirmation or another account', async () => {
  for (const transition of ['cancel', 'account']) {
    const screen = mount();
    await flush();
    screen.press('Archive habit');
    const oldConfirm = screen.button('Confirm archive').props.onPress;
    const oldCancel = screen.button('Cancel archive').props.onPress;
    if (transition === 'cancel') screen.press('Cancel archive');
    else { screen.changeAccount('b'); await flush(); }
    screen.press('Archive habit');
    const current = screen.state();
    assert.equal(current.archive.phase, 'confirming');
    assert.equal(current.habit.owner_id, transition === 'account' ? 'b' : 'a');
    oldCancel();
    assert.equal(screen.state(), current);
    await oldConfirm();
    assert.equal(screen.state(), current);
    assert.equal(screen.calls.archive, 0);
    assert.deepEqual(screen.navigations, []);
    await screen.press('Confirm archive');
    assert.equal(screen.calls.archive, 1);
    assert.deepEqual(screen.navigations, ['/my-habits']);
  }
});

test('archive controls disable during a save and show loading during a pending archive', async () => {
  const saving = deferred(), archiving = deferred();
  const saveScreen = mount({ save: () => saving.promise });
  await flush();
  saveScreen.fields().props.onChange({ name: 'Updated' });
  saveScreen.press('Save changes');
  assert.equal(saveScreen.button('Archive habit').props.disabled, true);
  assert.equal(saveScreen.button('Saving…').props.disabled, true);
  assert.equal(saveScreen.calls.archive, 0);
  saving.resolve(habit({ name: 'Updated' }));
  await flush();

  const archiveScreen = mount({ archive: () => archiving.promise });
  await flush();
  archiveScreen.press('Archive habit');
  const pending = archiveScreen.press('Confirm archive');
  assert.equal(archiveScreen.button('Archiving…').props.disabled, true);
  assert.equal(archiveScreen.fields().props.disabled, true);
  assert.equal(archiveScreen.button('Save changes').props.disabled, true);
  assert.ok(archiveScreen.render().some(node => node.type === 'Loading'));
  assert.equal(archiveScreen.button('Cancel archive'), undefined);
  archiving.resolve(habit({ archived_at: '2026-10-11T13:00:00Z' }));
  await pending;
  assert.equal(archiveScreen.calls.archive, 1);
});

test('definite archive error is visible, preserves edits, and retries only after new confirmation', async () => {
  let attempts = 0;
  const screen = mount({ archive: async () => {
    if (++attempts === 1) throw new ApiError('Please sign in again.', 401, 'http_401');
    return habit({ archived_at: '2026-10-11T13:00:00Z' });
  } });
  await flush();
  screen.fields().props.onChange({ description: 'Still unfinished' });
  screen.press('Archive habit');
  await screen.press('Confirm archive');
  assert.match(screen.text(), /Unable to archive.*Please sign in again/i);
  assert.equal(screen.state().draft.description, 'Still unfinished');
  assert.equal(screen.fields().props.disabled, false);
  assert.equal(screen.button('Refresh current server state'), undefined);
  assert.equal(screen.calls.archive, 1);
  screen.press('Archive again');
  assert.equal(screen.calls.archive, 1);
  await screen.press('Confirm archive');
  assert.equal(screen.calls.archive, 2);
  assert.deepEqual(screen.navigations, ['/my-habits']);
});

test('a definite archive failure retains server reload after an earlier ambiguous save', async () => {
  const screen = mount({
    save: async () => { throw new ApiError('save timeout', null, 'request_timeout'); },
    archive: async () => { throw new ApiError('Invalid archive request.', 422, 'validation_error'); },
  });
  await flush();
  screen.fields().props.onChange({ name: 'Possibly saved edit' });
  screen.press('Save changes');
  await flush();
  assert.equal(screen.state().ambiguous, true);
  assert.ok(screen.button('Reload saved configuration'));
  screen.press('Archive habit');
  await screen.press('Confirm archive');
  assert.equal(screen.state().ambiguous, true);
  assert.equal(screen.state().archive.ambiguous, false);
  assert.match(screen.text(), /Unable to archive.*Invalid archive request/i);
  assert.ok(screen.button('Reload saved configuration'));
  await screen.press('Reload saved configuration');
  assert.equal(screen.calls.read, 2);
  assert.equal(screen.calls.save, 1);
  assert.equal(screen.calls.archive, 1);
  assert.equal(screen.state().ambiguous, false);
  assert.equal(screen.state().archive, null);
  assert.equal(screen.state().draft.name, 'Read');
  assert.deepEqual(screen.navigations, []);
});

test('uncertain archive offers server refresh before retry and refresh never sends another mutation', async () => {
  for (const archived of [false, true]) {
    const refresh = deferred();
    let reads = 0;
    const screen = mount({ read: () => ++reads === 1 ? Promise.resolve(habit()) : refresh.promise,
      archive: async () => { throw new ApiError('timeout', null, 'request_timeout'); } });
    await flush();
    screen.fields().props.onChange({ description: 'Local draft' });
    screen.press('Archive habit');
    await screen.press('Confirm archive');
    assert.match(screen.text(), /may have succeeded.*Refresh the current server state before deciding to retry/i);
    assert.match(screen.text(), /Refreshing replaces unsaved edits/);
    assert.equal(screen.fields().props.disabled, true);
    assert.equal(screen.button('Save changes').props.disabled, true);
    screen.press('Archive again');
    screen.press('Cancel archive');
    assert.ok(screen.button('Refresh current server state'));
    assert.equal(screen.fields().props.disabled, true);
    assert.equal(screen.calls.archive, 1);
    const pending = screen.press('Refresh current server state');
    assert.equal(screen.button('Refresh current server state').props.disabled, true);
    assert.equal(screen.button('Archive again').props.disabled, true);
    refresh.resolve(habit({ name: 'Current server habit', archived_at: archived ? '2026-10-11T13:00:00Z' : null }));
    await pending;
    assert.equal(screen.calls.archive, 1);
    assert.equal(screen.calls.save, 0);
    assert.equal(screen.calls.read, 2);
    assert.equal(screen.button('Refresh current server state'), undefined);
    if (archived) {
      assert.match(screen.text(), /archived and cannot be edited.*Archived in My habits to restore/i);
      assert.equal(screen.fields(), undefined);
      assert.equal(screen.button('Save changes'), undefined);
      assert.equal(screen.button('Archive habit'), undefined);
      screen.press('Back to My habits');
      assert.deepEqual(screen.navigations, ['/my-habits']);
    } else {
      assert.equal(screen.fields().props.disabled, false);
      assert.equal(screen.state().draft.name, 'Current server habit');
      assert.equal(screen.state().draft.description, '');
      assert.ok(screen.button('Archive habit'));
    }
  }
});

test('editor focus cleanup clears a pending archive and ignores its late navigation', async () => {
  const archive = deferred();
  const screen = mount({ archive: () => archive.promise });
  await flush();
  screen.press('Archive habit');
  const pending = screen.press('Confirm archive');
  screen.leave();
  assert.equal(screen.state().draft, null);
  assert.equal(screen.state().archive, null);
  archive.resolve(habit({ archived_at: '2026-10-11T13:00:00Z' }));
  await pending;
  assert.deepEqual(screen.navigations, []);
  assert.equal(screen.state().draft, null);
});
