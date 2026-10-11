const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(name, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, `../lib/${name}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require: dependency => dependencies[dependency] ?? assert.fail(`Unexpected dependency: ${dependency}`),
  });
  return exports;
}
const { habitDraft, habitChanges } = load('habit-edit-input', { './habit-input': load('habit-input') });
const plain = value => JSON.parse(JSON.stringify(value));
const habit = changes => ({
  id: 'habit-id', owner_id: 'owner-id', name: 'Read', description: null,
  type: 'binary', target: null, unit: null, schedule: 'daily', weekdays: [], reminder_times: ['08:00', '21:30'],
  created_at: '2026-10-09T12:00:00Z', updated_at: '2026-10-09T12:00:00Z', archived_at: null,
  ...changes,
});
const target = changes => habit({ type: 'target', target: 25, unit: 'pages', ...changes });

test('editing drafts preload every editable field and own their weekday array', () => {
  const original = target({ description: 'A chapter', schedule: 'selected', weekdays: [1, 3, 7] });
  const draft = habitDraft(original);
  assert.deepEqual(plain(draft), {
    name: 'Read', description: 'A chapter', type: 'target', target: '25', unit: 'pages',
    schedule: 'selected', weekdays: [1, 3, 7], reminderTimes: '08:00, 21:30',
  });
  draft.weekdays.push(2);
  assert.deepEqual(original.weekdays, [1, 3, 7]);
  assert.equal(habitDraft(habit()).target, '');
  assert.equal(habitDraft(habit()).unit, '');
  assert.equal(habitDraft(habit()).description, '');
});

test('untouched forms and normalization-only changes produce no PATCH', () => {
  for (const original of [habit(), habit({ description: '' }), target(), target({ unit: null })]) {
    assert.equal(habitChanges(original, habitDraft(original)), null);
  }
  const original = target({ schedule: 'selected', weekdays: [1, 3, 7] });
  assert.equal(habitChanges(original, {
    ...habitDraft(original), name: ' Read ', target: '0025', unit: ' pages ',
    weekdays: [7, 1, 3], reminderTimes: '21:30,08:00',
  }), null);
});

test('PATCH contains only changed fields and never immutable or unrecognized fields', () => {
  const original = target();
  const draft = {
    ...habitDraft(original), name: ' Read more ', description: 'One extra chapter', target: '30',
    owner_id: 'different-owner', id: 'different-habit', created_at: 'different-time', archived_at: 'now', extra: true,
  };
  const before = structuredClone(draft);
  assert.deepEqual(plain(habitChanges(original, draft)), { name: 'Read more', description: 'One extra chapter', target: 30 });
  assert.deepEqual(plain(draft), before);
  assert.deepEqual(original, target());
});

test('clearing optional description/unit sends null, while untouched null or empty description stays omitted', () => {
  const original = target({ description: 'A chapter' });
  assert.deepEqual(plain(habitChanges(original, { ...habitDraft(original), description: '', unit: ' ' })), {
    description: null, unit: null,
  });
  for (const description of [null, '']) {
    const blank = habit({ description });
    assert.deepEqual(plain(habitChanges(blank, { ...habitDraft(blank), name: 'Walk' })), { name: 'Walk' });
  }
  const blank = target({ unit: null });
  assert.deepEqual(plain(habitChanges(blank, { ...habitDraft(blank), unit: ' chapters ' })), { unit: 'chapters' });
});

test('daily to selected and back send schedule/weekdays together for valid atomic updates', () => {
  const daily = habit();
  const selectedChanges = plain(habitChanges(daily, { ...habitDraft(daily), schedule: 'selected', weekdays: [7, 1] }));
  assert.deepEqual(selectedChanges, { schedule: 'selected', weekdays: [1, 7] });
  const selected = { ...daily, ...selectedChanges };
  const dailyChanges = plain(habitChanges(selected, { ...habitDraft(selected), schedule: 'daily' }));
  assert.deepEqual(dailyChanges, { schedule: 'daily', weekdays: [] });
  const backToDaily = { ...selected, ...dailyChanges };
  assert.equal(habitChanges(backToDaily, habitDraft(backToDaily)), null);
});

test('selected weekday edits send only weekdays, and hidden daily weekdays never leak into a patch', () => {
  const selected = habit({ schedule: 'selected', weekdays: [1, 3] });
  assert.deepEqual(plain(habitChanges(selected, { ...habitDraft(selected), weekdays: [7, 5] })), { weekdays: [5, 7] });
  const daily = habit();
  assert.equal(habitChanges(daily, { ...habitDraft(daily), weekdays: [7, 1] }), null);
  assert.deepEqual(plain(habitChanges(daily, { ...habitDraft(daily), name: 'Walk', weekdays: [7, 1] })), { name: 'Walk' });
});

test('original binary/target type stays immutable and binary patches omit hidden target/unit values', () => {
  const binary = habit();
  assert.deepEqual(plain(habitChanges(binary, {
    ...habitDraft(binary), name: 'Walk', type: 'target', target: 'invalid', unit: 'x'.repeat(31),
  })), { name: 'Walk' });
  const original = target();
  assert.deepEqual(plain(habitChanges(original, { ...habitDraft(original), type: 'binary', target: '30' })), { target: 30 });
  assert.throws(() => habitChanges(original, { ...habitDraft(original), type: 'binary', target: '' }), /positive whole number/);
});

test('reminder edits send sorted settings, require a distinct strict time and preserve other settings', () => {
  const original = habit();
  assert.deepEqual(plain(habitChanges(original, { ...habitDraft(original), reminderTimes: '23:59, 00:00' })), {
    reminder_times: ['00:00', '23:59'],
  });
  for (const reminderTimes of ['', '8:00', '24:00', '08:00, 08:00']) {
    assert.throws(() => habitChanges(original, { ...habitDraft(original), reminderTimes }), /reminder|Reminder/);
  }
});

test('editing reuses creation validation for required fields, Unicode limits, schedules and changed targets', () => {
  const original = target();
  for (const [changes, message] of [
    [{ name: ' ' }, /Name must/],
    [{ name: '😀'.repeat(101) }, /Name must/],
    [{ description: '😀'.repeat(1001) }, /Description must/],
    [{ unit: '😀'.repeat(31) }, /Unit must/],
    [{ target: '0' }, /positive whole number/],
    [{ target: '1.5' }, /positive whole number/],
    [{ target: '9007199254740992' }, /save it exactly/],
    [{ schedule: 'selected', weekdays: [] }, /at least one weekday/],
    [{ schedule: 'selected', weekdays: [1, 1] }, /distinct weekdays/],
  ]) assert.throws(() => habitChanges(original, { ...habitDraft(original), ...changes }), message);
  const draft = { ...habitDraft(original), name: '😀'.repeat(100), unit: '😀'.repeat(30), description: '😀'.repeat(1000) };
  assert.deepEqual(plain(habitChanges(original, draft)), { name: draft.name, description: draft.description, unit: draft.unit });
});

test('large existing targets never block unrelated edits or resend rounded server values', () => {
  for (const largeTarget of [JSON.parse('9007199254740993'), 1e30]) {
    const original = target({ target: largeTarget });
    const draft = habitDraft(original);
    assert.equal(habitChanges(original, draft), null);
    assert.deepEqual(plain(habitChanges(original, { ...draft, name: 'Walk', unit: '' })), { name: 'Walk', unit: null });
    assert.deepEqual(plain(habitChanges(original, { ...draft, target: '50' })), { target: 50 });
    assert.throws(() => habitChanges(original, { ...draft, target: '9007199254740993' }), /save it exactly/);
  }
});
