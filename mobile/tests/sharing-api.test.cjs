const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function client(fetch) {
  const cache = {};
  function load(name) {
    if (cache[name]) return cache[name];
    const exports = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, require: path => load(path.slice(2)),
      process: { env: { EXPO_PUBLIC_API_URL: 'https://api.example.test/' } }, fetch, AbortController,
      setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args) });
    return cache[name] = exports;
  }
  return load('api');
}
const session = { user: { id: 'caller' }, access_token: 'current-token', refresh_token: 'refresh-token' };
const identity = { user_id: 'friend', username: 'friend_1', display_name: 'Current name' };
const json = (status, body) => new Response(JSON.stringify(body), { status });
const methods = ['listHabitShares', 'grantHabitShare', 'revokeHabitShare', 'listSharedHabits', 'readSharedHabit'];
const failure = (api, status, code) => error => {
  assert.ok(error instanceof api.ApiError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return true;
};

test('owner share helpers encode each path ID, send no body or actor, and preserve public identities', async () => {
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    return init.method === 'GET' ? json(200, [identity]) : init.method === 'PUT' ? json(200, identity)
      : { ok: true, status: 204, json: () => assert.fail('204 has no JSON body') };
  });
  assert.deepEqual(await api.listHabitShares(session, 'habit/id?#%'), [identity]);
  assert.deepEqual(await api.grantHabitShare(session, 'habit/id?#%', 'friend/id?#%'), identity);
  assert.equal(await api.revokeHabitShare({ ...session, access_token: 'renewed-token' }, 'habit/id?#%', 'friend/id?#%'), undefined);
  assert.deepEqual(calls.map(c => [c.url, c.init.method]), [
    ['https://api.example.test/habits/habit%2Fid%3F%23%25/shares', 'GET'],
    ['https://api.example.test/habits/habit%2Fid%3F%23%25/shares/friend%2Fid%3F%23%25', 'PUT'],
    ['https://api.example.test/habits/habit%2Fid%3F%23%25/shares/friend%2Fid%3F%23%25', 'DELETE'],
  ]);
  for (const { init } of calls) {
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].init.headers.Authorization, 'Bearer current-token');
  assert.equal(calls[2].init.headers.Authorization, 'Bearer renewed-token');
});

test('shared reads use only recipient endpoints and preserve owner dates, snapshots, null occurrences and streaks', async () => {
  const calls = [];
  const snapshot = { name: 'Read ten', description: null, type: 'target', target: 10, unit: 'pages', schedule: 'daily', weekdays: [], reminder_times: [] };
  const shared = { id: 'habit', owner: identity, configuration: { ...snapshot, name: 'Read twenty', target: 20, unit: 'chapters' },
    local_date: '2026-10-19', timezone: 'Asia/Tokyo', server_time: '2026-10-19T01:00:00Z', due_today: true,
    occurrence: { id: 'occurrence', local_date: '2026-10-19', timezone: 'Asia/Tokyo', closes_at: '2026-10-19T15:00:00Z', snapshot, progress: 10, completed: true, state: 'completed' },
    current_streak: 3, provisional: true, calculated_at: '2026-10-19T01:00:00Z' };
  const unscheduled = { ...shared, id: 'other', local_date: '2026-10-18', timezone: 'Pacific/Honolulu', due_today: false, occurrence: null };
  const api = client(async (url, init) => { calls.push({ url, init }); return json(200, url.endsWith('/shared-habits') ? [shared, unscheduled] : shared); });
  assert.deepEqual(await api.listSharedHabits(session), [shared, unscheduled]);
  assert.deepEqual(await api.readSharedHabit(session, 'habit/id?#%'), shared);
  assert.deepEqual(calls.map(c => c.url), ['https://api.example.test/shared-habits', 'https://api.example.test/shared-habits/habit%2Fid%3F%23%25']);
  for (const { init } of calls) { assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); }
});

test('empty grants and shared lists remain valid private-by-default results', async () => {
  const api = client(async () => json(200, []));
  assert.deepEqual(await api.listHabitShares(session, 'habit'), []);
  assert.deepEqual(await api.listSharedHabits(session), []);
});

test('sharing preserves authentication, missing profile, inaccessible habit and friendship errors without replay', async () => {
  for (const method of methods) {
    for (const [status, code] of [[401, 'http_401'], [404, 'profile_not_found'], [404, 'habit_not_found'], [409, 'friendship_required'], [422, 'self_share']]) {
      let calls = 0;
      const api = client(async () => { calls++; return json(status, { detail: { code, message: code } }); });
      await assert.rejects(api[method](session, 'habit', 'friend'), failure(api, status, code));
      assert.equal(calls, 1);
    }
  }
});

test('only revoke accepts 204 and unexpected success is an ambiguous error', async () => {
  for (const method of methods.filter(method => method !== 'revokeHabitShare')) {
    for (const response of [new Response(null, { status: 204 }), new Response('truncated', { status: 200 })]) {
      const api = client(async () => response);
      await assert.rejects(api[method](session, 'habit', 'friend'), failure(api, response.status, 'invalid_response'));
    }
  }
  const api = client(async () => json(200, identity));
  await assert.rejects(api.revokeHabitShare(session, 'habit', 'friend'), failure(api, 200, 'invalid_response'));
});

test('sharing mutations never replay network or server errors and redact transport details', async () => {
  for (const method of ['grantHabitShare', 'revokeHabitShare']) {
    for (const serverFailure of [false, true]) {
      let calls = 0;
      const api = client(async () => {
        calls++;
        if (serverFailure) return new Response('sensitive proxy output', { status: 503 });
        throw new Error(session.access_token);
      });
      await assert.rejects(api[method](session, 'habit', 'friend'), error => {
        failure(api, serverFailure ? 503 : null, serverFailure ? 'http_503' : 'network_error')(error);
        assert.ok(!error.message.includes(session.access_token));
        assert.ok(!error.message.includes('sensitive'));
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test('sharing mutation timeout aborts and cannot become success when a late response arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const method of ['grantHabitShare', 'revokeHabitShare']) {
    let finish, signal, calls = 0;
    const api = client((_url, init) => { calls++; signal = init.signal; return new Promise(resolve => { finish = resolve; }); });
    const pending = api[method](session, 'habit', 'friend');
    const rejected = assert.rejects(pending, failure(api, null, 'request_timeout'));
    t.mock.timers.tick(30_000);
    await rejected;
    assert.equal(signal.aborted, true);
    finish(method === 'grantHabitShare' ? json(200, identity) : new Response(null, { status: 204 }));
    await assert.rejects(pending, failure(api, null, 'request_timeout'));
    assert.equal(calls, 1);
  }
});
