const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function compile(path, dependencies) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../${path}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Error, process: { env: {} }, require: dependencies });
  return exports;
}
const cache = {};
const lib = name => cache[name] ??= compile(`lib/${name}.ts`, path => lib(path.slice(2)));
const { SharingStore } = lib('sharing-store');
const { SessionStore } = lib('session-store');
const { ApiError } = lib('api');
const alice = 'aaaaaaaa-1111-4111-8111-111111111111';
const bob = 'bbbbbbbb-2222-4222-8222-222222222222';
const charlie = 'cccccccc-3333-4333-8333-333333333333';
const habitId = 'dddddddd-4444-4444-8444-444444444444';
const session = (id = alice, token = `${id}-token`) => ({ user: { id }, access_token: token });
const profile = (id = bob, changes = {}) => ({ user_id: id,
  username: id === alice ? 'alice_1' : id === bob ? 'bob_2' : 'charlie_3',
  display_name: id === alice ? 'Alice' : id === bob ? 'Bob' : 'Charlie', ...changes });
const fullProfile = id => ({ ...profile(id), timezone: 'UTC', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
const friend = (changes = {}) => ({ id: 'friendship-one', direction: 'outgoing', state: 'accepted', profile: profile(),
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', accepted_at: '2026-10-02T00:00:00Z', ...changes });
const habit = (changes = {}) => ({ id: habitId, owner_id: alice, name: 'Read', description: null, type: 'target', target: 10,
  unit: 'pages', schedule: 'daily', weekdays: [], reminder_times: ['18:00'], created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z', archived_at: null, ...changes });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup(overrides = {}, options = {}) {
  let authEvent;
  const calls = [];
  const auth = {
    getSession: async () => ({ data: { session: options.initial ?? session() } }),
    onAuthStateChange: callback => { authEvent = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, { readProfile: options.readProfile ?? (async s => fullProfile(s.user.id)), createProfile: async s => fullProfile(s.user.id) });
  await sessions.start();
  const defaults = {
    readHabit: async s => habit({ owner_id: s.user.id }), listFriends: async () => [friend()],
    listHabitShares: async () => [], grantHabitShare: async () => profile(), revokeHabitShare: async () => {},
  };
  const api = Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => [name, (...args) => {
    calls.push({ name, args });
    return (overrides[name] ?? fallback)(...args);
  }]));
  const store = SharingStore.forSession(sessions, api, habitId);
  return { store, sessions, auth, api, calls, overrides, event: value => authEvent(value ? 'SIGNED_IN' : 'SIGNED_OUT', value) };
}
async function started(overrides, options) {
  const x = await setup(overrides, options);
  x.store.start();
  await flush();
  return x;
}
const count = (x, name) => x.calls.filter(call => call.name === name).length;
function cleared(store) {
  const state = store.snapshot();
  assert.equal(state.habit, null);
  assert.equal(state.friends.length, 0);
  assert.equal(state.grants.length, 0);
  assert.equal(state.hasLoaded, false);
}

module.exports = { compile, SharingStore, ApiError, alice, bob, charlie, habitId, session, profile, fullProfile,
  friend, habit, flush, deferred, setup, started, count, cleared };
