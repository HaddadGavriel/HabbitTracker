const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const exportsForTest = {};
vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, '../lib/habit-input.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsForTest });
const { emptyHabitDraft, habitInput } = exportsForTest;
const draft = changes => ({ ...emptyHabitDraft(), name: ' Read ', reminderTimes: '21:30, 08:00', ...changes });
const plain = value => JSON.parse(JSON.stringify(value));

test('binary daily payload trims the name, sorts reminders and omits optional/hidden fields', () => {
  const input = draft({ target: 'not a target', unit: 'x'.repeat(31), weekdays: [7, 1] });
  const before = structuredClone(input);
  assert.deepEqual(plain(habitInput(input)), {
    name: 'Read', type: 'binary', schedule: 'daily', weekdays: [], reminder_times: ['08:00', '21:30'],
  });
  assert.deepEqual(input, before);
});

test('target selected payload saves an integer, optional description/unit and sorted ISO weekdays', () => {
  const input = draft({
    description: ' Keep original spacing ', type: 'target', target: ' 0025 ', unit: ' pages ',
    schedule: 'selected', weekdays: [7, 1, 3],
  });
  const before = structuredClone(input);
  assert.deepEqual(plain(habitInput(input)), {
    name: 'Read', description: ' Keep original spacing ', type: 'target', target: 25, unit: 'pages',
    schedule: 'selected', weekdays: [1, 3, 7], reminder_times: ['08:00', '21:30'],
  });
  assert.deepEqual(input, before);
  assert.equal(Object.hasOwn(habitInput(draft({ type: 'target', target: '1', unit: ' ' })), 'unit'), false);
});

test('each empty form owns its own weekdays and requires name/reminder input', () => {
  const first = emptyHabitDraft();
  first.weekdays.push(1);
  assert.deepEqual(plain(emptyHabitDraft()), {
    name: '', description: '', type: 'binary', target: '', unit: '', schedule: 'daily', weekdays: [], reminderTimes: '',
  });
  assert.throws(() => habitInput(emptyHabitDraft()), /Name must be 1–100 characters/);
  assert.throws(() => habitInput({ ...emptyHabitDraft(), name: 'Read' }), /at least one reminder time/);
});

test('name, description and unit limits count Unicode codepoints like the backend', () => {
  assert.equal(habitInput(draft({ name: ` ${'😀'.repeat(100)} ` })).name, '😀'.repeat(100));
  assert.equal(habitInput(draft({ description: '😀'.repeat(1000) })).description, '😀'.repeat(1000));
  assert.equal(habitInput(draft({ type: 'target', target: '1', unit: ` ${'😀'.repeat(30)} ` })).unit, '😀'.repeat(30));
  for (const name of ['', ' \n\t ', '😀'.repeat(101)]) {
    assert.throws(() => habitInput(draft({ name })), /Name must be 1–100 characters/);
  }
  assert.throws(() => habitInput(draft({ description: '😀'.repeat(1001) })), /Description must be 1,000 characters or fewer/);
  assert.throws(() => habitInput(draft({ type: 'target', target: '1', unit: '😀'.repeat(31) })), /Unit must be 30 characters or fewer/);
});

test('target rejects missing, zero, negative, decimal, exponent and imprecise values', () => {
  for (const target of ['', ' ', '0', '-1', '1.5', '1.0', '1e3', '+1', 'NaN', 'Infinity', '١']) {
    assert.throws(() => habitInput(draft({ type: 'target', target })), /Target must be a positive whole number/);
  }
  assert.throws(() => habitInput(draft({ type: 'target', target: '9007199254740992' })), /save it exactly/);
  assert.throws(() => habitInput(draft({ type: 'target', target: '9007199254740993' })), /save it exactly/);
  assert.equal(habitInput(draft({ type: 'target', target: '9007199254740991' })).target, Number.MAX_SAFE_INTEGER);
});

test('selected schedules require distinct valid ISO weekdays; every weekday is supported', () => {
  assert.throws(() => habitInput(draft({ schedule: 'selected', weekdays: [] })), /Select at least one weekday/);
  for (const weekdays of [[1, 1], [0], [8], [-1], [1.5], ['1'], [NaN]]) {
    assert.throws(() => habitInput(draft({ schedule: 'selected', weekdays })), /distinct weekdays/);
  }
  assert.deepEqual(plain(habitInput(draft({ schedule: 'selected', weekdays: [7, 6, 5, 4, 3, 2, 1] })).weekdays), [1, 2, 3, 4, 5, 6, 7]);
});

test('reminders require at least one distinct strict HH:MM value and reject malformed lists', () => {
  for (const reminderTimes of ['', ' ', '\n']) {
    assert.throws(() => habitInput(draft({ reminderTimes })), /at least one reminder time/);
  }
  for (const reminderTimes of ['8:00', '08:0', '24:00', '23:60', '08:00:00', '08:00,', ',08:00', '08:00;21:30', '08:00,,21:30', '08:00 21:30']) {
    assert.throws(() => habitInput(draft({ reminderTimes })), /24-hour HH:MM/);
  }
  assert.throws(() => habitInput(draft({ reminderTimes: '08:00, 08:00' })), /must be distinct/);
  assert.deepEqual(plain(habitInput(draft({ reminderTimes: '23:59, 00:00' })).reminder_times), ['00:00', '23:59']);
});

test('validation errors preserve entered values without echoing submitted text', () => {
  const input = draft({ name: 'sensitive'.repeat(20), description: 'Remember this draft', weekdays: [3, 1] });
  const before = structuredClone(input);
  assert.throws(() => habitInput(input), error => error.message === 'Name must be 1–100 characters.');
  assert.deepEqual(input, before);
});
