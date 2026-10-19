const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Real stores and validation, without a native runtime or a live account.
const cache = {};
function lib(name) {
  if (cache[name]) return cache[name];
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: path => lib(path.slice(2)), process: { env: {} } });
  return cache[name] = exports;
}
const { FriendsStore } = lib('friends-store');
const { SessionStore } = lib('session-store');
const { ApiError } = lib('api');
const session = (id = 'a', token = `${id}-token`) => ({ user: { id }, access_token: token });
const identity = (id = 'b', changes = {}) => ({ user_id: id, username: `user_${id}`, display_name: `Person ${id}`, ...changes });
const relationship = (changes = {}) => ({ id: 'relationship-b', direction: 'incoming', state: 'pending', profile: identity(),
  created_at: '2026-10-18T12:00:00Z', updated_at: '2026-10-18T12:00:00Z', accepted_at: null, ...changes });
const accepted = (changes = {}) => relationship({ state: 'accepted', accepted_at: '2026-10-18T12:01:00Z', ...changes });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup(overrides = {}, readProfile = async s => identity(s.user.id)) {
  let callback;
  const auth = {
    getSession: async () => ({ data: { session: session() } }),
    onAuthStateChange: cb => { callback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, { readProfile, createProfile: async s => identity(s.user.id) });
  await sessions.start();
  const api = {
    listFriends: async () => [], listFriendRequests: async () => ({ incoming: [], outgoing: [] }),
    searchProfile: async () => identity(),
    sendFriendRequest: async () => relationship({ direction: 'outgoing' }),
    acceptFriendRequest: async () => accepted(), rejectFriendRequest: async () => {}, removeFriend: async () => {},
    ...overrides,
  };
  const store = new FriendsStore(sessions, api);
  return { store, sessions, auth, api, event: s => callback('SIGNED_IN', s) };
}
async function started(overrides, readProfile) {
  const x = await setup(overrides, readProfile);
  x.store.start();
  await flush();
  return x;
}
async function search(store, query = 'user_b') { store.setQuery(query); await store.search(); return store.snapshot().searchResult; }
function cleared(store) {
  const s = store.snapshot();
  for (const name of ['friends', 'incoming', 'outgoing']) assert.equal(s[name].length, 0);
  for (const name of ['error', 'searchResult', 'searchError', 'pendingAction', 'actionError', 'notice', 'removeConfirmation']) assert.equal(s[name], null);
  assert.equal(s.query, '');
  assert.equal(s.searchLoading, false);
  assert.equal(s.searchComplete, false);
  assert.equal(s.refreshRequired, false);
}

test('loads accepted, incoming and outgoing together, exposes empty only after both complete, and refreshes current identities', async () => {
  const friends = deferred(), requests = deferred();
  const x = await setup({ listFriends: () => friends.promise, listFriendRequests: () => requests.promise });
  x.store.start();
  assert.equal(x.store.snapshot().loading, true);
  friends.resolve([accepted()]);
  await flush();
  assert.equal(x.store.snapshot().hasLoaded, false);
  assert.equal(x.store.snapshot().friends.length, 0);
  requests.resolve({ incoming: [relationship({ profile: identity('c') })], outgoing: [relationship({ direction: 'outgoing', profile: identity('d') })] });
  await flush();
  assert.equal(x.store.snapshot().friends[0].profile.display_name, 'Person b');
  assert.equal(x.store.relationshipFor('b'), 'friend');
  assert.equal(x.store.relationshipFor('c'), 'incoming');
  assert.equal(x.store.relationshipFor('d'), 'outgoing');
  assert.equal(x.store.canMutate(), true);
  x.api.listFriends = async () => [accepted({ profile: identity('b', { username: 'new_name', display_name: 'Renamed' }) })];
  await x.store.refresh();
  assert.equal(x.store.snapshot().friends[0].profile.username, 'new_name');
  assert.equal(x.store.snapshot().friends[0].profile.display_name, 'Renamed');
  x.api.listFriends = async () => [];
  x.api.listFriendRequests = async () => ({ incoming: [], outgoing: [] });
  await x.store.refresh();
  assert.equal(x.store.snapshot().hasLoaded, true);
  assert.equal(x.store.snapshot().friends.length, 0);
  assert.equal(x.store.snapshot().incoming.length, 0);
  assert.equal(x.store.snapshot().outgoing.length, 0);
});

test('list failures preserve snapshots, distinguish missing profiles, and retry both endpoints once', async () => {
  for (const [error, message] of [
    [new ApiError('expired', 401, 'http_401'), /verify your session/],
    [new ApiError('offline', null, 'network_error'), /connection/],
    [new ApiError('timeout', null, 'request_timeout'), /timed out/],
    [new ApiError('missing', 404, 'profile_not_found'), /complete onboarding/],
    [new Error('private detail'), /Unable to load/],
  ]) {
    let friends = 0, requests = 0, failure = false;
    const retry = deferred();
    const x = await started({
      listFriends: async () => { friends++; if (failure) throw error; return [accepted()]; },
      listFriendRequests: async () => { requests++; return { incoming: [], outgoing: [] }; },
    });
    await search(x.store);
    failure = true;
    await x.store.refresh();
    assert.match(x.store.snapshot().error, message);
    assert.ok(!x.store.snapshot().error.includes('private detail'));
    assert.equal(x.store.canMutate(), false);
    assert.equal(x.store.snapshot().friends.length, error.code === 'profile_not_found' ? 0 : 1);
    if (error.code === 'profile_not_found') assert.equal(x.store.snapshot().searchResult, null);
    x.api.listFriends = () => { friends++; return retry.promise; };
    const pending = x.store.refresh();
    await x.store.refresh();
    assert.equal(friends, 3);
    assert.equal(requests, 3);
    retry.resolve([]);
    await pending;
    assert.equal(x.store.snapshot().error, null);
    assert.equal(x.store.canMutate(), true);
  }
});

test('overlapping list reads ignore older successes and failures without mixing snapshots', async () => {
  for (const outcome of ['success', 'error']) {
    const older = deferred(), newer = deferred();
    let calls = 0;
    const x = await setup({ listFriends: () => ++calls === 1 ? older.promise : newer.promise });
    x.store.start();
    const pending = x.store.reload();
    newer.resolve([accepted({ profile: identity('c') })]);
    await pending;
    const state = x.store.snapshot();
    if (outcome === 'success') older.resolve([accepted()]);
    else older.reject(new ApiError('old failure', 401, 'http_401'));
    await flush();
    assert.equal(x.store.snapshot(), state);
    assert.equal(state.friends[0].profile.user_id, 'c');
  }
});

test('search normalizes exactly, validates before requests, and handles absent/self without exposing upstream errors', async () => {
  const queries = [];
  const x = await started({ searchProfile: async (_s, query) => { queries.push(query); return identity(); } });
  await search(x.store, '\u001c USER_B \u0085');
  assert.deepEqual(queries, ['user_b']);
  assert.equal(x.store.snapshot().searchResult.username, 'user_b');
  for (const query of ['', 'ab', 'a-b', 'ééé', '\ufeffuser_b']) {
    await search(x.store, query);
    assert.match(x.store.snapshot().searchError, /3–30 ASCII/);
    assert.equal(x.store.snapshot().searchComplete, false);
  }
  assert.equal(queries.length, 1);
  x.api.searchProfile = async () => { throw new ApiError('private detail', 404, 'profile_not_found'); };
  await search(x.store);
  assert.equal(x.store.snapshot().searchComplete, true);
  assert.equal(x.store.snapshot().searchResult, null);
  assert.equal(x.store.snapshot().searchError, null);
  for (const error of [new ApiError('expired', 401, 'http_401'), new ApiError('offline', null, 'network_error')]) {
    x.api.searchProfile = async () => { throw error; };
    await x.store.search();
    assert.match(x.store.snapshot().searchError, /session|connection/);
    assert.equal(x.store.snapshot().searchComplete, false);
  }
});

test('query edits invalidate an in-flight search immediately, and reverse-order responses never replace a newer query', async () => {
  for (const outcome of ['success', 'error']) {
    const old = deferred(), current = deferred();
    let calls = 0;
    const x = await started({ searchProfile: () => ++calls === 1 ? old.promise : current.promise });
    x.store.setQuery('user_b');
    const pending = x.store.search();
    await x.store.search();
    assert.equal(calls, 1);
    x.store.setQuery('user_c');
    assert.equal(x.store.snapshot().searchResult, null);
    assert.equal(x.store.snapshot().searchLoading, false);
    const latest = x.store.search();
    current.resolve(identity('c'));
    await latest;
    const accepted = x.store.snapshot();
    if (outcome === 'success') old.resolve(identity());
    else old.reject(new ApiError('stale token', 401, 'http_401'));
    await pending;
    assert.equal(x.store.snapshot(), accepted);
    assert.equal(accepted.searchResult.username, 'user_c');
  }
});

test('edited but unsubmitted queries cannot receive old search data; invalid/self responses fail closed', async () => {
  const old = deferred();
  const x = await started({ searchProfile: () => old.promise });
  x.store.setQuery('user_b');
  const pending = x.store.search();
  x.store.setQuery('x');
  old.resolve(identity());
  await pending;
  assert.equal(x.store.snapshot().searchResult, null);
  assert.equal(x.store.snapshot().query, 'x');
  for (const result of [identity('c'), identity('a', { username: 'user_b' })]) {
    x.api.searchProfile = async () => result;
    await search(x.store);
    assert.equal(x.store.snapshot().searchResult, null);
    assert.match(x.store.snapshot().searchError, /Unable to search/);
  }
});

test('refresh updates a search display name but clears renamed usernames that no longer match the query', async () => {
  const x = await started();
  await search(x.store);
  x.api.listFriends = async () => [accepted({ profile: identity('b', { display_name: 'Current name' }) })];
  await x.store.refresh();
  assert.equal(x.store.snapshot().searchResult.display_name, 'Current name');
  x.api.listFriends = async () => [accepted({ profile: identity('b', { username: 'renamed_b' }) })];
  await x.store.refresh();
  assert.equal(x.store.snapshot().searchResult, null);
  assert.equal(x.store.snapshot().searchComplete, false);
  assert.match(x.store.snapshot().searchError, /username changed/);
});

test('send, accept, reject and confirmed remove use their contract identifiers and refresh both lists', async () => {
  for (const kind of ['send', 'accept', 'reject', 'remove']) {
    const calls = [], mutation = deferred(), refresh = deferred();
    let friendReads = 0, requestReads = 0;
    const row = kind === 'remove' ? accepted() : relationship();
    const x = await started({
      listFriends: async () => ++friendReads > 1 ? refresh.promise : kind === 'remove' ? [row] : [],
      listFriendRequests: async () => { requestReads++; return { incoming: ['accept', 'reject'].includes(kind) ? [row] : [], outgoing: [] }; },
      [`${kind === 'send' ? 'sendFriendRequest' : kind === 'accept' ? 'acceptFriendRequest' : kind === 'reject' ? 'rejectFriendRequest' : 'removeFriend'}`]:
        (s, id) => { calls.push([s.user.id, id]); return mutation.promise; },
    });
    let target = kind === 'send' ? await search(x.store) : row;
    if (kind === 'remove') { x.store.requestRemove(row); target = x.store.snapshot().removeConfirmation; }
    const action = kind === 'remove' ? 'confirmRemove' : kind;
    const pending = x.store[action](target);
    await x.store[action](target);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['a', ['send', 'remove'].includes(kind) ? 'b' : row.id]);
    assert.equal(x.store.snapshot().pendingAction.kind, kind);
    assert.equal(x.store.canMutate(), false);
    mutation.resolve(kind === 'send' ? relationship({ direction: 'outgoing' }) : kind === 'accept' ? accepted() : undefined);
    await flush();
    assert.equal(friendReads, 2);
    assert.equal(requestReads, 2);
    assert.equal(x.store.snapshot().refreshRequired, true);
    await x.store[action](target);
    assert.equal(calls.length, 1);
    refresh.resolve(kind === 'accept' ? [accepted()] : []);
    await pending;
    assert.equal(x.store.snapshot().pendingAction, null);
    assert.equal(x.store.snapshot().refreshRequired, false);
    assert.match(x.store.snapshot().notice, /sent|accepted|rejected|removed/);
  }
});

test('outgoing requests expose no accept, reject or removal action; known relationships cannot be sent again', async () => {
  for (const state of ['friend', 'incoming', 'outgoing']) {
    let writes = 0;
    const row = state === 'friend' ? accepted() : relationship({ direction: state });
    const x = await started({
      listFriends: async () => state === 'friend' ? [row] : [],
      listFriendRequests: async () => ({ incoming: state === 'incoming' ? [row] : [], outgoing: state === 'outgoing' ? [row] : [] }),
      sendFriendRequest: async () => { writes++; }, acceptFriendRequest: async () => { writes++; },
      rejectFriendRequest: async () => { writes++; }, removeFriend: async () => { writes++; },
    });
    await x.store.send(await search(x.store));
    if (state === 'outgoing') {
      await x.store.accept(row); await x.store.reject(row); x.store.requestRemove(row); await x.store.confirmRemove(row);
    }
    assert.equal(writes, 0);
  }
});

test('removal requires exact current confirmation and cancel, refresh, navigation and account changes invalidate captured handlers', async () => {
  for (const transition of ['cancel', 'refresh', 'navigation', 'account']) {
    let writes = 0;
    const x = await started({ listFriends: async () => [accepted()], removeFriend: async () => { writes++; } });
    const old = x.store.snapshot().friends[0];
    await x.store.confirmRemove(old);
    assert.equal(writes, 0);
    x.store.requestRemove(old);
    const confirmation = x.store.snapshot().removeConfirmation;
    assert.equal(confirmation.id, old.id);
    if (transition === 'cancel') x.store.cancelRemove(confirmation);
    if (transition === 'refresh') await x.store.refresh();
    if (transition === 'navigation') { x.store.stop(); x.store.start(); await flush(); }
    if (transition === 'account') { x.event(session('c')); await flush(); }
    await x.store.confirmRemove(confirmation);
    assert.equal(writes, 0);
    assert.equal(x.store.snapshot().removeConfirmation, null);
    if (transition !== 'cancel') x.store.requestRemove(old);
    assert.equal(x.store.snapshot().removeConfirmation, null);
  }
});

test('all duplicate/reverse/stale conflicts explain the result, reconcile both lists, and never resend automatically', async () => {
  for (const [kind, code, message] of [
    ['send', 'outgoing_request_exists', /outgoing request/], ['send', 'incoming_request_exists', /already sent/],
    ['send', 'friendship_exists', /already friends/], ['accept', 'friend_request_not_found', /already been processed/],
    ['reject', 'friend_request_not_found', /already been processed/], ['remove', 'friendship_not_found', /already been removed/],
  ]) {
    let writes = 0, friends = 0, requests = 0;
    const row = kind === 'remove' ? accepted() : relationship();
    const x = await started({
      listFriends: async () => { friends++; return kind === 'remove' && friends === 1 ? [row]
        : code === 'friendship_exists' && friends > 1 ? [accepted()] : []; },
      listFriendRequests: async () => { requests++; return {
        incoming: (['accept', 'reject'].includes(kind) && requests === 1) || (code === 'incoming_request_exists' && requests > 1) ? [row] : [],
        outgoing: code === 'outgoing_request_exists' && requests > 1 ? [relationship({ direction: 'outgoing' })] : [],
      }; },
      [kind === 'send' ? 'sendFriendRequest' : kind === 'accept' ? 'acceptFriendRequest' : kind === 'reject' ? 'rejectFriendRequest' : 'removeFriend']:
        async () => { writes++; throw new ApiError('Private database information', code.includes('exists') ? 409 : 404, code); },
    });
    if (kind === 'send') await x.store.send(await search(x.store));
    else if (kind === 'remove') { x.store.requestRemove(row); await x.store.confirmRemove(x.store.snapshot().removeConfirmation); }
    else await x.store[kind](row);
    assert.equal(writes, 1);
    assert.equal(friends, 2);
    assert.equal(requests, 2);
    assert.equal(x.store.snapshot().refreshRequired, false);
    assert.match(x.store.snapshot().actionError, message);
    assert.ok(!x.store.snapshot().actionError.includes('Private database'));
    assert.equal(x.store.relationshipFor('b'), code === 'outgoing_request_exists' ? 'outgoing'
      : code === 'incoming_request_exists' ? 'incoming' : code === 'friendship_exists' ? 'friend' : null);
  }
});

test('ambiguous mutations reconcile automatically and remain blocked until both fresh reads succeed', async () => {
  for (const error of [new ApiError('timeout', null, 'request_timeout'), new ApiError('timeout', 408, 'http_408'),
    new ApiError('offline', null, 'network_error'), new ApiError('upstream', 503, 'http_503'), new Error('Unknown')]) {
    let writes = 0, friends = 0, requests = 0, failRead = true;
    const x = await started({
      listFriends: async () => { friends++; return []; },
      listFriendRequests: async () => { if (++requests > 1 && failRead) throw new ApiError('offline', null, 'network_error'); return { incoming: [], outgoing: [] }; },
      sendFriendRequest: async () => { writes++; throw error; },
    });
    const person = await search(x.store);
    await x.store.send(person);
    assert.equal(writes, 1);
    assert.equal(friends, 2);
    assert.equal(requests, 2);
    assert.equal(x.store.snapshot().refreshRequired, true);
    assert.match(x.store.snapshot().actionError, /may have succeeded/);
    await x.store.send(person);
    assert.equal(writes, 1);
    failRead = false;
    await x.store.refresh();
    assert.equal(x.store.snapshot().refreshRequired, false);
    assert.equal(x.store.snapshot().actionError, null);
    assert.equal(writes, 1);
  }
});

test('an ambiguous send that committed is reconciled as outgoing and cannot be sent twice', async () => {
  let writes = 0;
  const x = await started({
    listFriendRequests: async () => ({ incoming: [], outgoing: writes ? [relationship({ direction: 'outgoing' })] : [] }),
    sendFriendRequest: async () => { writes++; throw new ApiError('timeout', null, 'request_timeout'); },
  });
  await x.store.send(await search(x.store));
  assert.equal(x.store.relationshipFor('b'), 'outgoing');
  await x.store.send(x.store.snapshot().searchResult);
  assert.equal(writes, 1);
  assert.equal(x.store.snapshot().refreshRequired, false);
});

test('wrong mutation response identities and states are ambiguous and reconciled without displaying them', async () => {
  for (const result of [relationship({ profile: identity('c'), direction: 'outgoing' }), accepted(), undefined]) {
    let reads = 0;
    const x = await started({ listFriends: async () => { reads++; return []; }, sendFriendRequest: async () => result });
    await x.store.send(await search(x.store));
    assert.equal(reads, 2);
    assert.equal(x.store.snapshot().outgoing.length, 0);
    assert.match(x.store.snapshot().notice, /Current friendship state refreshed/);
  }
});

test('missing recipients clear search identity; missing own profiles clear lists and explain onboarding recovery', async () => {
  for (const code of ['recipient_not_found', 'profile_not_found']) {
    let writes = 0;
    const x = await started({
      listFriends: async () => { if (writes && code === 'profile_not_found') throw new ApiError('missing', 404, code); return []; },
      sendFriendRequest: async () => { writes++; throw new ApiError('missing', 404, code); },
    });
    const person = await search(x.store);
    await x.store.send(person);
    assert.equal(x.store.snapshot().searchResult, null);
    assert.match(x.store.snapshot().actionError, code === 'recipient_not_found' ? /no longer available/ : /complete onboarding/);
    await x.store.send(person);
    assert.equal(writes, 1);
    if (code === 'profile_not_found') assert.equal(x.store.canMutate(), false);
  }
});

test('expired authentication and definite validation errors expose retry without performing extra mutations', async () => {
  for (const error of [new ApiError('expired', 401, 'http_401'), new ApiError('private detail', 422, 'http_422')]) {
    let reads = 0, writes = 0;
    const x = await started({ listFriends: async () => { reads++; return []; }, sendFriendRequest: async () => { writes++; throw error; } });
    const person = await search(x.store);
    await x.store.send(person);
    assert.equal(writes, 1);
    assert.equal(reads, 1);
    assert.equal(x.store.snapshot().refreshRequired, false);
    assert.match(x.store.snapshot().actionError, /session|try again/);
    assert.ok(!x.store.snapshot().actionError.includes('private detail'));
  }
});

test('reads begun before a mutation settles cannot release its uncertainty or overwrite newer reconciliation', async () => {
  const mutation = deferred(), before = deferred(), after = deferred();
  let reads = 0, writes = 0;
  const x = await started({
    listFriends: () => ++reads === 1 ? Promise.resolve([]) : reads === 2 ? before.promise : after.promise,
    sendFriendRequest: () => { writes++; return mutation.promise; },
  });
  const person = await search(x.store);
  const pending = x.store.send(person);
  const oldRead = x.store.refresh();
  mutation.reject(new ApiError('offline', null, 'network_error'));
  await flush();
  before.resolve([accepted({ profile: identity('c') })]);
  await oldRead;
  assert.equal(x.store.snapshot().refreshRequired, true);
  assert.equal(x.store.snapshot().friends.length, 0);
  await x.store.send(person);
  assert.equal(writes, 1);
  after.resolve([accepted()]);
  await pending;
  assert.equal(x.store.snapshot().friends[0].profile.user_id, 'b');
  assert.equal(x.store.snapshot().refreshRequired, false);
});

test('account switching clears populated state before profile loading; late search, read and mutation results never leak', async () => {
  for (const outcome of ['success', 'error']) {
    const oldRead = deferred(), oldSearch = deferred(), oldMutation = deferred(), nextProfile = deferred();
    let aReads = 0;
    const x = await started({
      listFriends: s => s.user.id === 'c' ? Promise.resolve([accepted({ profile: identity('d') })])
        : ++aReads === 1 ? Promise.resolve([]) : oldRead.promise,
      searchProfile: () => oldSearch.promise,
      acceptFriendRequest: () => oldMutation.promise,
      listFriendRequests: async s => ({ incoming: s.user.id === 'a' ? [relationship()] : [], outgoing: [] }),
    }, s => s.user.id === 'c' ? nextProfile.promise : Promise.resolve(identity(s.user.id)));
    x.store.setQuery('user_b');
    const searching = x.store.search();
    const writing = x.store.accept(x.store.snapshot().incoming[0]);
    const reading = x.store.refresh();
    x.event(session('c'));
    assert.equal(x.sessions.snapshot().status, 'loading');
    cleared(x.store);
    nextProfile.resolve(identity('c'));
    await flush();
    const current = x.store.snapshot();
    if (outcome === 'success') { oldRead.resolve([accepted()]); oldSearch.resolve(identity()); oldMutation.resolve(accepted()); }
    else { const error = new ApiError('old error', null, 'network_error'); oldRead.reject(error); oldSearch.reject(error); oldMutation.reject(error); }
    await Promise.all([searching, writing, reading]);
    assert.equal(x.store.snapshot(), current);
    assert.equal(current.friends[0].profile.user_id, 'd');
    assert.equal(current.query, '');
  }
});

test('sign-out clears data immediately before auth completes and rejects captured actions and late reads', async () => {
  const logout = deferred(), oldSearch = deferred();
  let writes = 0;
  const x = await started({ listFriends: async () => [accepted()], searchProfile: () => oldSearch.promise,
    removeFriend: async () => { writes++; } });
  const row = x.store.snapshot().friends[0];
  x.store.requestRemove(row);
  x.store.setQuery('user_b');
  const searching = x.store.search();
  x.auth.signOut = () => logout.promise;
  const pending = x.sessions.signOut();
  cleared(x.store);
  oldSearch.resolve(identity());
  await searching;
  await x.store.confirmRemove(row);
  assert.equal(writes, 0);
  cleared(x.store);
  logout.resolve({ error: null });
  await pending;
  cleared(x.store);
});

test('navigation and account round-trips retain pending guards until settlement and a subsequent read', async () => {
  for (const transition of ['navigation', 'account']) for (const outcome of ['success', 'error']) {
    const mutation = deferred(), recovery = deferred();
    let writes = 0, holdReads = false;
    const x = await started({ listFriends: () => holdReads ? recovery.promise : Promise.resolve([]),
      sendFriendRequest: () => { writes++; return mutation.promise; } });
    const pending = x.store.send(await search(x.store));
    if (transition === 'navigation') { x.store.stop(); cleared(x.store); x.store.start(); }
    else { x.event(session('c')); await flush(); x.event(session('a')); }
    await flush();
    const person = await search(x.store);
    assert.equal(x.store.snapshot().pendingAction.kind, 'send');
    await x.store.send(person);
    assert.equal(writes, 1);
    holdReads = true;
    if (outcome === 'success') mutation.resolve(relationship({ direction: 'outgoing' }));
    else mutation.reject(new ApiError('old timeout', null, 'request_timeout'));
    await flush();
    assert.equal(x.store.snapshot().pendingAction, null);
    assert.equal(x.store.snapshot().refreshRequired, true);
    assert.equal(x.store.snapshot().outgoing.length, 0);
    await x.store.send(person);
    assert.equal(writes, 1);
    recovery.resolve([]);
    await pending;
    assert.equal(x.store.snapshot().refreshRequired, false);
    assert.equal(writes, 1);
  }
});

test('same-account token refresh preserves pending mutation guards and restarts searches with the new token', async () => {
  const oldSearch = deferred(), newSearch = deferred(), mutation = deferred();
  const searchTokens = [], readTokens = [];
  let writes = 0;
  const x = await started({
    listFriends: async s => { readTokens.push(s.access_token); return []; },
    listFriendRequests: async () => ({ incoming: [relationship()], outgoing: [] }),
    searchProfile: s => { searchTokens.push(s.access_token); return searchTokens.length === 1 ? oldSearch.promise : newSearch.promise; },
    acceptFriendRequest: () => { writes++; return mutation.promise; },
  });
  const row = x.store.snapshot().incoming[0];
  const writing = x.store.accept(row);
  x.store.setQuery('user_b');
  const searching = x.store.search();
  x.event(session('a', 'fresh-token'));
  await flush();
  assert.deepEqual(searchTokens, ['a-token', 'fresh-token']);
  assert.equal(x.store.snapshot().pendingAction.kind, 'accept');
  await x.store.accept(x.store.snapshot().incoming[0]);
  assert.equal(writes, 1);
  newSearch.resolve(identity('b', { display_name: 'Fresh result' }));
  await flush();
  oldSearch.resolve(identity('b', { display_name: 'Old result' }));
  await searching;
  assert.equal(x.store.snapshot().searchResult.display_name, 'Fresh result');
  mutation.resolve(accepted());
  await writing;
  assert.equal(readTokens.at(-1), 'fresh-token');
  assert.equal(x.store.snapshot().pendingAction, null);
  assert.equal(x.store.snapshot().refreshRequired, false);
});

test('stopping unsubscribes and stale restart reads cannot overwrite the new loading state', async () => {
  const old = deferred(), current = deferred();
  let reads = 0;
  const x = await setup({ listFriends: () => ++reads === 1 ? old.promise : current.promise });
  x.store.start();
  x.store.stop();
  cleared(x.store);
  x.event(session('c'));
  await flush();
  assert.equal(reads, 1);
  x.store.start();
  old.resolve([accepted()]);
  await flush();
  assert.equal(x.store.snapshot().loading, true);
  assert.equal(x.store.snapshot().hasLoaded, false);
  current.resolve([]);
  await flush();
  assert.equal(x.store.snapshot().hasLoaded, true);
  assert.equal(x.store.snapshot().loading, false);
});

test('cancel/reopen creates a new removal confirmation that old handlers cannot confirm or cancel', async () => {
  let writes = 0;
  const x = await started({ listFriends: async () => [accepted()], removeFriend: async () => { writes++; } });
  const row = x.store.snapshot().friends[0];
  x.store.requestRemove(row);
  const old = x.store.snapshot().removeConfirmation;
  x.store.cancelRemove(old);
  x.store.requestRemove(row);
  const current = x.store.snapshot().removeConfirmation;
  assert.notEqual(current, old);
  x.store.cancelRemove(old);
  await x.store.confirmRemove(old);
  assert.equal(x.store.snapshot().removeConfirmation, current);
  assert.equal(writes, 0);
  await x.store.confirmRemove(current);
  assert.equal(writes, 1);
});

test('a failed send for an old query cannot clear or cancel a newer query, result, or pending search', async () => {
  for (const newer of ['unsubmitted', 'pending', 'complete']) {
    const mutation = deferred(), lookup = deferred();
    const x = await started({ sendFriendRequest: () => mutation.promise,
      searchProfile: (_s, query) => query === 'user_b' ? Promise.resolve(identity()) : lookup.promise });
    const pending = x.store.send(await search(x.store));
    x.store.setQuery('user_c');
    const searching = newer === 'unsubmitted' ? null : x.store.search();
    if (newer === 'complete') { lookup.resolve(identity('c')); await searching; }
    mutation.reject(new ApiError('gone', 404, 'recipient_not_found'));
    await pending;
    assert.equal(x.store.snapshot().query, 'user_c');
    assert.equal(x.store.snapshot().searchError, null);
    if (newer === 'pending') {
      assert.equal(x.store.snapshot().searchLoading, true);
      lookup.resolve(identity('c'));
      await searching;
    }
    assert.equal(x.store.snapshot().searchResult?.user_id ?? null, newer === 'unsubmitted' ? null : 'c');
    assert.match(x.store.snapshot().actionError, /no longer available/);
  }
});

test('mid-write reads cannot duplicate or regress a later relationship before post-write reconciliation', async () => {
  for (const kind of ['send', 'accept']) {
    const mutation = deferred();
    let reads = 0;
    const x = await started({
      listFriends: async () => {
        if (++reads === 3) throw new ApiError('offline after acknowledgement', null, 'network_error');
        return reads === 2 ? [accepted()] : [];
      },
      listFriendRequests: async () => ({ incoming: kind === 'accept' && reads === 1 ? [relationship()] : [], outgoing: [] }),
      sendFriendRequest: () => mutation.promise, acceptFriendRequest: () => mutation.promise,
    });
    const pending = kind === 'send' ? x.store.send(await search(x.store)) : x.store.accept(x.store.snapshot().incoming[0]);
    // The server can already have committed and the other person accepted it,
    // even while this client's mutation acknowledgement is still in transit.
    await x.store.refresh();
    assert.equal(x.store.snapshot().friends.length, 0);
    assert.equal(x.store.snapshot().pendingAction.kind, kind);
    mutation.resolve(kind === 'send' ? relationship({ direction: 'outgoing' }) : accepted());
    await pending;
    const state = x.store.snapshot();
    assert.equal(state.friends.length + state.incoming.length + state.outgoing.length, 1);
    assert.equal(state.refreshRequired, true);
    assert.match(state.error, /connection/);
    assert.equal(x.store.canMutate(), false);
    x.api.listFriends = async () => [accepted()];
    await x.store.refresh();
    assert.equal(x.store.relationshipFor('b'), 'friend');
    assert.equal(x.store.snapshot().outgoing.length, 0);
  }
});

test('ambiguous accept, reject and removal read the committed state and never repeat the mutation', async () => {
  for (const kind of ['accept', 'reject', 'remove']) {
    let writes = 0;
    const row = kind === 'remove' ? accepted() : relationship();
    const x = await started({
      listFriends: async () => kind === 'remove' ? (writes ? [] : [row]) : kind === 'accept' && writes ? [accepted()] : [],
      listFriendRequests: async () => ({ incoming: kind !== 'remove' && !writes ? [row] : [], outgoing: [] }),
      [kind === 'accept' ? 'acceptFriendRequest' : kind === 'reject' ? 'rejectFriendRequest' : 'removeFriend']:
        async () => { writes++; throw new ApiError('response lost', null, 'network_error'); },
    });
    if (kind === 'remove') {
      x.store.requestRemove(row);
      await x.store.confirmRemove(x.store.snapshot().removeConfirmation);
    } else await x.store[kind](row);
    assert.equal(writes, 1);
    assert.equal(x.store.snapshot().refreshRequired, false);
    assert.equal(x.store.snapshot().friends.length, kind === 'accept' ? 1 : 0);
    assert.equal(x.store.snapshot().incoming.length, 0);
    if (kind === 'remove') await x.store.confirmRemove(row);
    else await x.store[kind](row);
    assert.equal(writes, 1);
  }
});

test('a missing caller profile clears identities immediately even when reconciliation cannot reach the server', async () => {
  const mutation = deferred(), reload = deferred();
  let reads = 0;
  const x = await started({ listFriends: () => ++reads === 1 ? Promise.resolve([accepted({ profile: identity('c') })]) : reload.promise,
    sendFriendRequest: () => mutation.promise });
  const pending = x.store.send(await search(x.store));
  mutation.reject(new ApiError('missing caller', 404, 'profile_not_found'));
  await flush();
  assert.equal(x.store.snapshot().friends.length, 0);
  assert.equal(x.store.snapshot().searchResult, null);
  assert.equal(x.store.canMutate(), false);
  reload.reject(new ApiError('offline', null, 'network_error'));
  await pending;
  assert.equal(x.store.snapshot().friends.length, 0);
  assert.equal(x.store.snapshot().searchResult, null);
  assert.match(x.store.snapshot().actionError, /complete onboarding/);
});

test('route remounts retain pending and uncertain guards under the same session provider without retaining visible data', async () => {
  for (const outcome of ['success', 'ambiguous']) {
    const mutation = deferred(), refresh = deferred();
    let writes = 0, holdReads = false;
    const x = await setup({
      listFriends: () => holdReads ? refresh.promise : Promise.resolve([]),
      sendFriendRequest: () => { writes++; return mutation.promise; },
    });
    const original = FriendsStore.forSession(x.sessions, x.api);
    original.start();
    await flush();
    const pending = original.send(await search(original));
    original.stop();
    cleared(original);
    // The route's useState initializer runs again on remount, but uses the same
    // provider-owned store. A separate provider must never share this guard.
    const reopened = FriendsStore.forSession(x.sessions, x.api);
    assert.equal(reopened, original);
    const other = await setup();
    assert.notEqual(FriendsStore.forSession(other.sessions, other.api), reopened);
    reopened.start();
    await flush();
    await reopened.send(await search(reopened));
    assert.equal(writes, 1);
    assert.equal(reopened.canMutate(), false);
    holdReads = true;
    if (outcome === 'success') mutation.resolve(relationship({ direction: 'outgoing' }));
    else mutation.reject(new ApiError('response lost', null, 'network_error'));
    await flush();
    assert.equal(reopened.snapshot().refreshRequired, true);
    reopened.stop();
    const reopenedAgain = FriendsStore.forSession(x.sessions, x.api);
    reopenedAgain.start();
    await reopenedAgain.send(await search(reopenedAgain));
    assert.equal(writes, 1);
    refresh.resolve([]);
    await pending;
    await flush();
    assert.equal(reopenedAgain.snapshot().refreshRequired, false);
    assert.equal(writes, 1);
  }
});

test('a late accept cannot restore identities after a read discovers the caller profile is missing', async () => {
  const mutation = deferred();
  let reads = 0;
  const x = await started({
    listFriends: async () => {
      if (++reads === 2) throw new ApiError('missing caller', 404, 'profile_not_found');
      if (reads > 2) throw new ApiError('offline', null, 'network_error');
      return [];
    },
    listFriendRequests: async () => ({ incoming: [relationship()], outgoing: [] }),
    acceptFriendRequest: () => mutation.promise,
  });
  const pending = x.store.accept(x.store.snapshot().incoming[0]);
  await x.store.refresh();
  assert.equal(x.store.snapshot().incoming.length, 0);
  assert.match(x.store.snapshot().error, /complete onboarding/);
  mutation.resolve(accepted());
  await pending;
  assert.equal(x.store.snapshot().friends.length, 0);
  assert.equal(x.store.snapshot().incoming.length, 0);
  assert.equal(x.store.snapshot().hasLoaded, false);
  assert.equal(x.store.snapshot().refreshRequired, true);
  assert.equal(x.store.canMutate(), false);
});
