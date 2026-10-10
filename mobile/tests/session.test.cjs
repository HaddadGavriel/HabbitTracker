const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const exports = {};
  const source = ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: path => load(path.slice(2)), process: { env: {} } });
  return cache[name] = exports;
}
const { SessionStore, routeAccess } = load('session-store');
const { ApiError } = load('api');
const session = id => ({ user: { id }, access_token: id });
const profile = id => ({ user_id: id, username: id });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(readProfile, createProfile = async s => profile(s.user.id), initial = session('a')) {
  let callback, cleaned = 0;
  const auth = { getSession: async () => ({ data: { session: initial } }), onAuthStateChange: cb => { callback = cb; return { data: { subscription: { unsubscribe: () => cleaned++ } } }; }, signOut: async () => ({ error: null }) };
  const store = new SessionStore(auth, { readProfile, createProfile });
  return { store, event: s => callback('SIGNED_IN', s), cleaned: () => cleaned, auth };
}
const flush = () => new Promise(r => setImmediate(r));
test('restores persisted session and cleans up subscription', async () => {
  const x = setup(async s => profile(s.user.id)); await x.store.start();
  assert.equal(x.store.state.status, 'ready'); assert.equal(x.store.state.profile.user_id, 'a');
  x.store.stop(); assert.equal(x.cleaned(), 1);
});
test('only profile_not_found enters onboarding; network/server errors retry', async () => {
  for (const code of ['profile_not_found', 'network_error', 'http_503']) {
    let fail = true; const x = setup(async s => { if (fail) throw new ApiError('failure', 404, code); return profile(s.user.id); });
    await x.store.start(); assert.equal(x.store.state.status, code === 'profile_not_found' ? 'profile_required' : 'failure');
    fail = false; await x.store.retry(); assert.equal(x.store.state.status, 'ready');
  }
});
test('route gates are mutually exclusive and block protected content while pending', () => {
  for (const status of ['startup', 'loading', 'failure', 'signed_out', 'profile_required', 'ready']) {
    const gates = routeAccess(status); assert.equal(Object.values(gates).filter(Boolean).length, 1);
    assert.equal(gates.home, status === 'ready'); assert.equal(gates.auth, status === 'signed_out');
  }
});
test('late restoration cannot overwrite an auth event', async () => {
  const restored = deferred(); const x = setup(async s => profile(s.user.id));
  x.auth.getSession = () => restored.promise; const start = x.store.start();
  x.event(session('b')); await flush(); restored.resolve({ data: { session: session('a') } }); await start;
  assert.equal(x.store.state.profile.user_id, 'b');
});
test('account switch clears identity immediately and ignores stale profile reads', async () => {
  const a = deferred(); const x = setup(s => s.user.id === 'a' ? a.promise : Promise.resolve(profile('b')));
  const start = x.store.start(); await flush(); x.event(session('b'));
  assert.equal(x.store.state.profile, null); await flush(); a.resolve(profile('a')); await start;
  assert.equal(x.store.state.profile.user_id, 'b');
});
test('sign-out invalidates late reads and back route access', async () => {
  const read = deferred(); const x = setup(() => read.promise); const start = x.store.start(); await flush();
  await x.store.signOut(); read.resolve(profile('a')); await start;
  assert.equal(x.store.state.status, 'signed_out'); assert.equal(x.store.state.profile, null); assert.equal(routeAccess(x.store.state.status).home, false);
});
test('profile conflicts reload existing profile or explain username conflict without retrying mutation', async () => {
  for (const code of ['profile_already_exists', 'username_taken', 'request_timeout']) {
    let reads = 0, creates = 0;
    const x = setup(async s => { if (++reads === 1) throw new ApiError('missing', 404, 'profile_not_found'); return profile(s.user.id); }, async () => { creates++; throw new ApiError(code, 409, code); });
    await x.store.start();
    if (code === 'profile_already_exists') { await x.store.create({}); assert.equal(x.store.state.status, 'ready'); }
    else { await assert.rejects(x.store.create({}), e => e.code === code); assert.equal(reads, 1); }
    assert.equal(creates, 1);
  }
});
test('late profile creation cannot restore the old account; duplicate submissions share one mutation', async () => {
  const created = deferred(); let calls = 0;
  const x = setup(async () => { throw new ApiError('missing', 404, 'profile_not_found'); }, () => { calls++; return created.promise; });
  await x.store.start(); const first = x.store.create({}); const second = x.store.create({});
  assert.equal(first, second); x.event(session('b')); await flush(); created.resolve(profile('a')); await first;
  assert.equal(calls, 1); assert.equal(x.store.state.session.user.id, 'b'); assert.equal(x.store.state.profile, null);
});
test('normalizes username and Unicode display name with backend limits', () => {
  const { profileInput } = load('profile-input');
  assert.equal(profileInput({ username: ' Alice_1 ', display_name: ' 😀 ', timezone: 'UTC' }).username, 'alice_1');
  assert.throws(() => profileInput({ username: 'ab', display_name: 'A', timezone: 'UTC' }));
  assert.throws(() => profileInput({ username: 'abc', display_name: 'x'.repeat(81), timezone: 'UTC' }));
});
test('restoration failures are recoverable and signed-out restoration opens authentication', async () => {
  const x = setup(async s => profile(s.user.id), undefined, null);
  x.auth.getSession = async () => ({ data: { session: null }, error: new Error('storage') });
  await x.store.start(); assert.equal(x.store.state.status, 'failure');
  x.auth.getSession = async () => ({ data: { session: null }, error: null });
  await x.store.retry(); assert.equal(x.store.state.status, 'signed_out');
});
test('token refresh uses the new session without clearing a ready profile', async () => {
  let reads = 0; const x = setup(async s => { reads++; return profile(s.user.id); }); await x.store.start();
  x.event({ ...session('a'), access_token: 'refreshed' }); await flush();
  assert.equal(x.store.state.status, 'ready'); assert.equal(x.store.state.session.access_token, 'refreshed'); assert.equal(reads, 1);
});
test('late sign-out completion cannot clear a newly switched account', async () => {
  const logout = deferred(); const x = setup(async s => profile(s.user.id)); await x.store.start();
  x.auth.signOut = () => logout.promise; const pending = x.store.signOut();
  x.event(session('b')); await flush(); logout.resolve({ error: null }); await pending;
  assert.equal(x.store.state.profile.user_id, 'b');
});
