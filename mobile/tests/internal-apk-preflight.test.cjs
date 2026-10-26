const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../scripts/internal-apk-preflight.cjs');
const env = {
  EXPO_PUBLIC_EAS_PROJECT_ID: '4f31560d-6323-41f7-ae0a-f792a4814c98',
  INTERNAL_TESTING_SUPABASE_REF: 'aaaaaaaaaaaaaaaaaaaa',
  EXPO_PUBLIC_SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
  EXPO_PUBLIC_API_URL: 'https://habit-tracker-pr33-internal.onrender.com',
  INTERNAL_TESTING_API_ORIGIN: 'https://habit-tracker-pr33-internal.onrender.com',
  INTERNAL_TESTING_FIREBASE_PROJECT_ID: 'existing-firebase-fixture',
};
const firebase = { project_info: { project_id: env.INTERNAL_TESTING_FIREBASE_PROJECT_ID },
  client: [{ client_info: { android_client_info: { package_name: 'com.haddadgavriel.habittracker' } } }] };
test('accepts matching isolated endpoints and existing identities without returning keys', () => {
  const result = validate(env, { firebase });
  assert.equal(result.supabaseProjectRef, env.INTERNAL_TESTING_SUPABASE_REF);
  assert.ok(!JSON.stringify(result).includes('sb_publishable_fixture'));
});
for (const [name, patch] of [
  ['production database', { INTERNAL_TESTING_SUPABASE_REF: 'zsqzenswefkjaundwyct' }],
  ['different database', { EXPO_PUBLIC_SUPABASE_URL: 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co' }],
  ['production-like API', { EXPO_PUBLIC_API_URL: 'https://habit-tracker-api.onrender.com', INTERNAL_TESTING_API_ORIGIN: 'https://habit-tracker-api.onrender.com' }],
  ['different API', { EXPO_PUBLIC_API_URL: 'https://habit-tracker-pr33-internal-other.onrender.com' }],
  ['cleartext API', { EXPO_PUBLIC_API_URL: 'http://habit-tracker-pr33-internal.onrender.com' }],
  ['embedded credentials', { EXPO_PUBLIC_API_URL: 'https://user:password@habit-tracker-pr33-internal.onrender.com' }],
  ['replacement EAS project', { EXPO_PUBLIC_EAS_PROJECT_ID: 'replacement' }],
  ['secret in public variable', { EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_fixture' }],
  ['missing Firebase identity', { INTERNAL_TESTING_FIREBASE_PROJECT_ID: '' }],
]) test(`rejects ${name}`, () => assert.throws(() => validate({ ...env, ...patch }, { firebase })));
test('remote build requires the real Firebase client identity and package', () => {
  assert.throws(() => validate(env));
  assert.throws(() => validate(env, { firebase: { ...firebase, private_key: 'fixture' } }));
  assert.throws(() => validate(env, { firebase: { ...firebase, project_info: { project_id: 'different' } } }));
  assert.throws(() => validate(env, { firebase: { ...firebase, client: [] } }));
  assert.doesNotThrow(() => validate(env, { configurationOnly: true }));
});
