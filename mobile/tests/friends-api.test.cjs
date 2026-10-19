const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function client(fetch = () => assert.fail('No request expected')) {
  const cache = {};
  function load(name) {
    if (cache[name]) return cache[name];
    const exports = {};
    const source = ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, {
      exports, require: path => load(path.slice(2)),
      process: { env: { EXPO_PUBLIC_API_URL: 'https://api.example.test/' } },
      fetch, AbortController,
      setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args),
    });
    return cache[name] = exports;
  }
  return { ...load('api'), ...load('username-input'), ...load('profile-input') };
}
const session = { user: { id: 'caller-id' }, access_token: 'current-token', refresh_token: 'refresh-token' };
const identity = { user_id: 'other-user-id', username: 'bob_2', display_name: 'Bob renamed' };
const relationship = (changes = {}) => ({
  id: 'relationship-id', direction: 'outgoing', state: 'pending', profile: identity,
  created_at: '2026-10-15T12:00:00Z', updated_at: '2026-10-15T12:00:00Z', accepted_at: null,
  ...changes,
});
const accepted = relationship({ state: 'accepted', accepted_at: '2026-10-15T13:00:00Z' });
const json = (status, body) => new Response(JSON.stringify(body), { status });
const mutations = ['sendFriendRequest', 'acceptFriendRequest', 'rejectFriendRequest', 'removeFriend'];
const failure = (api, status, code) => error => {
  assert.ok(error instanceof api.ApiError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return true;
};

test('exact search normalizes the username and sends only one current-session GET', async () => {
  const calls = [];
  const api = client(async (url, init) => { calls.push({ url, init }); return json(200, identity); });
  assert.deepEqual(await api.searchProfile(session, ' \tBOB_2\n'), identity);
  assert.deepEqual(await api.searchProfile({ ...session, access_token: 'refreshed-token' }, '\u0085Bob_2\u001c'), identity);
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, 'https://api.example.test/profiles/search?username=bob_2');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].init.headers.Authorization, 'Bearer current-token');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer refreshed-token');
});

test('search rejects invalid usernames before any request, without partial search or directory fallback', async () => {
  const api = client();
  for (const value of ['', ' ', 'ab', 'a'.repeat(31), '@bob', 'bob smith', 'bob%', 'bob?x=1', 'bób', 'BO\u0130', '\uFEFFbob', 'bob\uFEFF', 'bob\u200b']) {
    await assert.rejects(api.searchProfile(session, value), failure(api, null, 'invalid_username'));
  }
});

test('username validation and onboarding match Python strip/lower including Unicode edge cases', () => {
  const api = client();
  const pythonWhitespace = '\u0009\u000a\u000b\u000c\u000d\u001c\u001d\u001e\u001f\u0020\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
  for (const space of pythonWhitespace) {
    const username = `${space}BOB_2${space}`;
    assert.equal(api.usernameInput(username), 'bob_2');
    assert.equal(api.profileInput({ username, display_name: 'Bob', timezone: 'UTC' }).username, 'bob_2');
  }
  // The backend lowers before enforcing ASCII, so Unicode Kelvin sign becomes k.
  assert.equal(api.usernameInput('\u212AIM'), 'kim');
  assert.equal(api.usernameInput('A'.repeat(30)), 'a'.repeat(30));
  for (const username of ['\uFEFFbob', 'bob\uFEFF', 'bo\u0085b', '\u180Ebob', 'BO\u0130', '\uFF22ob']) {
    assert.throws(() => api.usernameInput(username), /Username must be/);
    assert.throws(() => api.profileInput({ username, display_name: 'Bob', timezone: 'UTC' }), /Username must be/);
  }
});

test('friend and request lists preserve current public identities and backend ordering', async () => {
  const incoming = relationship({ id: 'incoming-id', direction: 'incoming', profile: { ...identity, username: 'alice_new', display_name: 'Alice now' } });
  const lists = { incoming: [incoming], outgoing: [relationship()] };
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    return json(200, url.endsWith('/friends') ? [accepted] : lists);
  });
  assert.deepEqual(await api.listFriends(session), [accepted]);
  assert.deepEqual(await api.listFriendRequests(session), lists);
  assert.deepEqual(calls.map(call => call.url), ['https://api.example.test/friends', 'https://api.example.test/friend-requests']);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, 'Bearer current-token');
  }
});

test('sending uses only recipient identity and accepting uses an encoded request ID with no body', async () => {
  const calls = [];
  const api = client(async (url, init) => { calls.push({ url, init }); return json(url.endsWith('/accept') ? 200 : 201, url.endsWith('/accept') ? accepted : relationship()); });
  assert.deepEqual(await api.sendFriendRequest(session, identity.user_id), relationship());
  assert.deepEqual(await api.acceptFriendRequest({ ...session, access_token: 'refreshed-token' }, 'request/id?#%'), accepted);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.example.test/friend-requests');
  assert.deepEqual(JSON.parse(calls[0].init.body), { recipient_user_id: identity.user_id });
  assert.equal(calls[1].url, 'https://api.example.test/friend-requests/request%2Fid%3F%23%25/accept');
  assert.equal(calls[1].init.body, undefined);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer refreshed-token');
  for (const { init } of calls) assert.equal(init.method, 'POST');
});

test('reject and remove accept only their empty 204 contract, encode IDs and omit actor/body fields', async () => {
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    return { status: 204, ok: true, json: () => assert.fail('204 must not be read as JSON') };
  });
  assert.equal(await api.rejectFriendRequest(session, 'request/id?#%'), undefined);
  assert.equal(await api.removeFriend({ ...session, access_token: 'refreshed-token' }, 'user/id?#%'), undefined);
  assert.equal(calls[0].url, 'https://api.example.test/friend-requests/request%2Fid%3F%23%25/reject');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[1].url, 'https://api.example.test/friends/user%2Fid%3F%23%25');
  assert.equal(calls[1].init.method, 'DELETE');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer refreshed-token');
  for (const { init } of calls) {
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test('204 support does not allow empty or malformed JSON success for JSON endpoints', async () => {
  for (const method of ['readProfile', 'searchProfile', 'listFriends', 'listFriendRequests', 'sendFriendRequest', 'acceptFriendRequest']) {
    for (const response of [new Response(null, { status: 204 }), new Response('truncated', { status: 200 }), new Response('', { status: 201 })]) {
      const api = client(async () => response);
      await assert.rejects(api[method](session, 'bob_2'), failure(api, response.status, 'invalid_response'));
    }
  }
  for (const method of ['rejectFriendRequest', 'removeFriend']) {
    const api = client(async () => json(200, { unexpected: true }));
    await assert.rejects(api[method](session, 'id'), failure(api, 200, 'invalid_response'));
  }
});

test('search preserves absent/self/profile-not-found, authentication and validation responses', async () => {
  for (const [status, code] of [[404, 'profile_not_found'], [401, 'http_401'], [422, 'invalid_username'], [503, 'http_503']]) {
    let calls = 0;
    const api = client(async () => { calls++; return json(status, { detail: { code, message: code } }); });
    await assert.rejects(api.searchProfile(session, 'bob_2'), failure(api, status, code));
    assert.equal(calls, 1);
  }
});

test('duplicate/reverse/existing friendship conflicts and missing recipients retain exact codes without retry', async () => {
  for (const [status, code] of [[409, 'outgoing_request_exists'], [409, 'incoming_request_exists'], [409, 'friendship_exists'], [404, 'recipient_not_found'], [422, 'self_request']]) {
    let calls = 0;
    const api = client(async () => { calls++; return json(status, { detail: { code, message: code } }); });
    await assert.rejects(api.sendFriendRequest(session, identity.user_id), failure(api, status, code));
    assert.equal(calls, 1);
  }
});

test('already-processed requests and absent friendships remain typed failures for reconciliation', async () => {
  for (const [method, code] of [['acceptFriendRequest', 'friend_request_not_found'], ['rejectFriendRequest', 'friend_request_not_found'], ['removeFriend', 'friendship_not_found']]) {
    let calls = 0;
    const api = client(async () => { calls++; return json(404, { detail: { code, message: 'No current relationship' } }); });
    await assert.rejects(api[method](session, 'id'), failure(api, 404, code));
    assert.equal(calls, 1);
  }
});

test('all friendship mutations preserve expired auth and missing profile errors, including 204 endpoints', async () => {
  for (const method of mutations) {
    for (const [status, detail, code] of [[401, 'Invalid or expired Supabase access token', 'http_401'], [404, { code: 'profile_not_found', message: 'Create a profile' }, 'profile_not_found']]) {
      let calls = 0;
      const api = client(async () => { calls++; return json(status, { detail }); });
      await assert.rejects(api[method](session, 'id'), failure(api, status, code));
      assert.equal(calls, 1);
    }
  }
});

test('network and server failures never automatically repeat any friendship mutation', async () => {
  for (const method of mutations) {
    for (const serverFailure of [false, true]) {
      let calls = 0;
      const api = client(async () => {
        calls++;
        if (serverFailure) return new Response('proxy failure with sensitive data', { status: 503 });
        throw new Error(`Lost connection ${session.access_token}`);
      });
      await assert.rejects(api[method](session, 'id'), error => {
        failure(api, serverFailure ? 503 : null, serverFailure ? 'http_503' : 'network_error')(error);
        assert.ok(!error.message.includes(session.access_token));
        assert.ok(!error.message.includes('sensitive data'));
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test('friendship mutation deadlines settle once, never retry, and ignore late JSON or 204 success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const method of mutations) {
    let calls = 0, finish, signal;
    const api = client((_url, init) => {
      calls++; signal = init.signal;
      return new Promise(resolve => { finish = resolve; });
    });
    const pending = api[method](session, 'id');
    const rejected = assert.rejects(pending, failure(api, null, 'request_timeout'));
    t.mock.timers.tick(30_000);
    await rejected;
    assert.equal(signal.aborted, true);
    finish(method === 'sendFriendRequest' || method === 'acceptFriendRequest' ? json(200, accepted) : new Response(null, { status: 204 }));
    await assert.rejects(pending, failure(api, null, 'request_timeout'));
    assert.equal(calls, 1);
  }
});
