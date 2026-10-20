const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile } = require('./sharing-test-support.cjs');
const { localReminderDestination, localReminders } = compile('lib/local-reminders.ts', path => {
  assert.equal(path, 'expo-modules-core');
  return { requireOptionalNativeModule: name => { assert.equal(name, 'LocalReminders'); return null; } };
});
const owner = 'aaaaaaaa-1111-4111-8111-111111111111';
test('local metadata permits only the active owner and constant Today target', () => {
  const data = { type: 'local_habit_reminder', owner_id: owner, target: 'today' };
  assert.equal(localReminderDestination(data, owner), '/today');
  for (const bad of [null, {}, { ...data, owner_id: 'other' }, { ...data, type: 'habit_reminder' }, { ...data, target: 'https://evil.example' }]) {
    assert.equal(localReminderDestination(bad, owner), null);
  }
  assert.equal(localReminderDestination(data, 'bbbbbbbb-2222-4222-8222-222222222222'), null);
  assert.equal(localReminders, null); // unsupported builds load safely
});
