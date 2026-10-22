const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Render the actual field/choice handlers using host-element mocks; no native runtime.
const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
const modules = {
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
  'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: value => value } },
  './form': { Field: 'Field', styles: {} },
};
const exportsForTest = {};
vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, '../components/habit-fields.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports: exportsForTest, require: name => {
  assert.ok(modules[name], `Unexpected dependency: ${name}`);
  return modules[name];
} });
const { HabitFields } = exportsForTest;

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props.children)];
}
const initial = changes => ({
  name: 'Read', description: '', type: 'binary', target: '', unit: '',
  schedule: 'selected', weekdays: [1, 7], reminderTimes: '08:00', ...changes,
});
function form(changes = {}, options = {}) {
  let draft = initial(changes);
  const render = () => nodes(HabitFields({
    draft, disabled: false, timezone: 'Asia/Jerusalem', ...options,
    onChange: patch => { draft = { ...draft, ...patch }; },
  }));
  const choice = label => render().find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label);
  return {
    render, choice, draft: () => draft,
    press(label) { const item = choice(label); assert.ok(item, `Missing choice ${label}`); item.props.onPress(); },
    change(label, text) {
      const item = render().find(node => node.type === 'Field' && node.props.label === label);
      assert.ok(item, `Missing field ${label}`);
      item.props.onChangeText(text);
    },
  };
}

test('rendered schedule handlers preserve selected days across repeated selection and daily switches', () => {
  for (const readOnlyType of [false, true]) {
    const screen = form({}, { readOnlyType });
    screen.press('Selected weekdays');
    assert.deepEqual(Array.from(screen.draft().weekdays), [1, 7]);
    screen.press('Every day');
    assert.equal(screen.draft().schedule, 'daily');
    assert.equal(screen.choice('Monday'), undefined);
    screen.press('Selected weekdays');
    assert.equal(screen.draft().schedule, 'selected');
    assert.deepEqual(Array.from(screen.draft().weekdays), [1, 7]);
    assert.equal(screen.choice('Sunday').props.accessibilityState.checked, true);
    screen.press('Wednesday');
    screen.press('Sunday');
    assert.deepEqual(Array.from(screen.draft().weekdays), [1, 3]);
    assert.equal(screen.choice('Wednesday').props.accessibilityState.checked, true);
    assert.equal(screen.choice('Sunday').props.accessibilityState.checked, false);
  }
});

test('edit fields show immutable type while retaining target and unit input handlers', () => {
  for (const type of ['binary', 'target']) {
    const screen = form({ type, target: '5', unit: 'pages' }, { readOnlyType: true });
    assert.equal(screen.choice('Binary (yes/no)'), undefined);
    assert.equal(screen.choice('Target'), undefined);
    assert.ok(screen.render().some(node => node.type === 'Text' && node.props.children === (type === 'binary' ? 'Binary (yes/no)' : 'Target')));
    if (type === 'target') {
      screen.change('Target (positive whole number)', '10');
      screen.change('Unit (optional)', 'chapters');
      assert.equal(screen.draft().target, '10');
      assert.equal(screen.draft().unit, 'chapters');
    } else {
      assert.ok(!screen.render().some(node => node.type === 'Field' && node.props.label === 'Target (positive whole number)'));
    }
    screen.change('Name', 'Walk');
    screen.change('Description (optional)', 'Outside');
    screen.change('Reminder times (HH:MM, separated by commas)', '09:00, 17:30');
    assert.equal(screen.draft().name, 'Walk');
    assert.equal(screen.draft().description, 'Outside');
    assert.equal(screen.draft().reminderTimes, '09:00, 17:30');
    assert.equal(screen.draft().type, type);
  }
});

test('creation retains its type selector and all field controls respect disabled state', () => {
  const screen = form({ type: 'binary', target: '25', unit: 'pages' });
  screen.press('Target');
  assert.equal(screen.draft().type, 'target');
  assert.equal(screen.draft().target, '25');
  screen.press('Binary (yes/no)');
  assert.equal(screen.draft().type, 'binary');
  assert.equal(screen.draft().unit, 'pages');

  const disabled = form({ type: 'target' }, { disabled: true }).render();
  for (const field of disabled.filter(node => node.type === 'Field')) assert.equal(field.props.editable, false);
  for (const choice of disabled.filter(node => node.type === 'Pressable')) {
    assert.equal(choice.props.disabled, true);
    assert.equal(choice.props.accessibilityState.disabled, true);
  }
});

test('editor load-error retry requests a reload without attempting a save', () => {
  let reads = 0, saves = 0;
  const state = { draft: null, loading: false, saving: false, saved: false,
    error: 'Unable to load this habit.', ambiguous: false, unavailable: null };
  const store = { subscribe() {}, snapshot: () => state,
    reload: () => { reads++; }, save: () => { saves++; } };
  const screenModules = {
    'react/jsx-runtime': modules['react/jsx-runtime'],
    react: { useCallback: fn => fn, useState: () => [store],
      useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    'expo-router': { router: {}, useFocusEffect() {},
      useLocalSearchParams: () => ({ id: '00000000-0000-0000-0000-000000000001' }) },
    'react-native': { Button: 'Button', Text: 'Text', Keyboard: {} },
    '../components/form': { Form: 'Form', Loading: 'Loading', Message: 'Message', styles: {} },
    '../components/habit-fields': { HabitFields: 'HabitFields' },
    '../lib/api': {},
    '../lib/edit-habit-store': {},
    '../lib/local-reminder-runtime': { localReminderService: { changed: async () => {} } },
    '../lib/session': { useSession: () => ({ store: {}, profile: { timezone: 'UTC' } }) },
  };
  const screen = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, '../app/edit-habit.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports: screen, require: name => {
    assert.ok(screenModules[name], `Unexpected dependency: ${name}`);
    return screenModules[name];
  } });
  const retry = nodes(screen.default()).find(node => node.type === 'Button' && node.props.title === 'Retry loading');
  assert.ok(retry);
  assert.equal(retry.props.disabled, false);
  retry.props.onPress();
  assert.equal(reads, 1);
  assert.equal(saves, 0);
});
