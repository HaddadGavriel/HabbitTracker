const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Compile only the client with the existing TypeScript dependency. No Expo/Auth runtime
// or real fetch is available in this isolated module; every request must use our mock.
const source = ts.transpileModule(readFileSync(join(__dirname, '../lib/api.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function client(fetch, env = { EXPO_PUBLIC_API_URL: 'https://api.example.test/' }) {
  const exports = {};
  vm.runInNewContext(source, {
    exports, process: { env }, fetch, AbortController,
    setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args),
  });
  return exports;
}
const session = { access_token: 'current-access-secret', refresh_token: 'refresh-secret' };
const input = { username: ' Alice_1 ', display_name: ' Alice ', timezone: 'Asia/Jerusalem' };
const profile = {
  user_id: 'user-id', username: 'alice_1', display_name: 'Alice', timezone: 'Asia/Jerusalem',
  created_at: '2026-10-09T12:00:00Z', updated_at: '2026-10-09T12:00:00Z',
};
const json = (status, body) => new Response(JSON.stringify(body), { status });
function failure(api, status, code, message) {
  return error => {
    assert.ok(error instanceof api.ApiError);
    assert.equal(error.name, 'ApiError');
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.ok(!error.message.includes('[object Object]'));
    return true;
  };
}

test('profile GET/POST use exact contracts and the supplied current session token', async () => {
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    return json(init.method === 'POST' ? 201 : 200, profile);
  });
  assert.deepEqual(await api.readProfile(session), profile);
  assert.deepEqual(await api.createProfile({ ...session, access_token: 'refreshed-access' }, input), profile);
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, 'https://api.example.test/profiles/me');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
  }
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer current-access-secret');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer refreshed-access');
  assert.deepEqual(JSON.parse(calls[1].init.body), input);
});

test('profile-not-found preserves onboarding code and status', async () => {
  const message = 'Create a profile to complete onboarding';
  const api = client(async () => json(404, { detail: { code: 'profile_not_found', message } }));
  await assert.rejects(api.readProfile(session), failure(api, 404, 'profile_not_found', message));
});

test('habits GET requests active habits with the supplied current session and preserves the array contract', async () => {
  const binary = {
    id: '00000000-0000-0000-0000-000000000001', owner_id: '00000000-0000-0000-0000-000000000010',
    name: 'Read before bed', description: null, type: 'binary', target: null, unit: null,
    schedule: 'daily', weekdays: [], reminder_times: ['08:00', '21:30'],
    created_at: profile.created_at, updated_at: profile.updated_at, archived_at: null,
  };
  const target = {
    ...binary, id: '00000000-0000-0000-0000-000000000002', name: 'Walk', description: 'Take a walk outdoors',
    type: 'target', target: 5000, unit: 'steps', schedule: 'selected', weekdays: [1, 3, 7], reminder_times: ['18:00'],
  };
  const habits = [binary, target, { ...target, id: '00000000-0000-0000-0000-000000000003', unit: null }];
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    return json(200, habits);
  });
  assert.deepEqual(await api.listHabits(session), habits);
  assert.deepEqual(await api.listHabits({ ...session, access_token: 'refreshed-access' }), habits);
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, 'https://api.example.test/habits?status=active');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].init.headers.Authorization, 'Bearer current-access-secret');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer refreshed-access');
});

test('an account without active habits returns an empty array', async () => {
  const api = client(async () => json(200, []));
  assert.deepEqual(await api.listHabits(session), []);
});

test('habit list errors remain typed errors and never become empty results', async () => {
  for (const [status, detail, code, message] of [
    [404, { code: 'profile_not_found', message: 'Create a profile to complete onboarding' }, 'profile_not_found', 'Create a profile to complete onboarding'],
    [401, 'Invalid or expired Supabase access token', 'http_401', 'Invalid or expired Supabase access token'],
    [503, null, 'http_503', 'API failed with HTTP 503'],
  ]) {
    const api = client(async () => json(status, { detail }));
    await assert.rejects(api.listHabits(session), failure(api, status, code, message));
  }
  const api = client(async () => { throw new Error(`fetch failed ${session.access_token}`); });
  await assert.rejects(api.listHabits(session), failure(api, null, 'network_error', 'Unable to reach the API. Check your connection.'));
});

test('structured conflicts preserve codes/messages and mutations are not retried', async () => {
  for (const [code, message] of [
    ['username_taken', 'That username is already taken'],
    ['profile_already_exists', 'This user already has a profile'],
  ]) {
    let requests = 0;
    const api = client(async () => { requests++; return json(409, { detail: { code, message } }); });
    await assert.rejects(api.createProfile(session, input), failure(api, 409, code, message));
    assert.equal(requests, 1);
  }
});

test('string auth errors remain readable', async () => {
  const api = client(async () => json(401, { detail: 'Invalid or expired Supabase access token' }));
  await assert.rejects(api.readProfile(session), failure(api, 401, 'http_401', 'Invalid or expired Supabase access token'));
});

test('validation errors omit submitted input/context, including credentials', async () => {
  const api = client(async () => json(422, { detail: [
    { loc: ['body', 'password'], msg: `Invalid ${session.refresh_token}`, input: session.access_token, ctx: { secret: 'sb_secret_hidden' } },
  ] }));
  await assert.rejects(api.createProfile(session, input), failure(api, 422, 'validation_error', 'Request validation failed. Check the submitted fields.'));
});

test('structured and string messages redact session tokens, keys, JWTs and push tokens', async () => {
  const sensitive = `${session.access_token} ${session.refresh_token} Bearer other-token sb_secret_hidden sb_publishable_hidden eyJabc.def.ghi ExpoPushToken[hidden]`;
  for (const detail of [sensitive, { code: 'upstream_error', message: sensitive }]) {
    const api = client(async () => json(502, { detail }));
    await assert.rejects(api.readProfile(session), error => {
      assert.equal(error.status, 502);
      assert.equal(error.message, '[redacted] [redacted] Bearer [redacted] [redacted] [redacted] [redacted] [redacted]');
      return true;
    });
  }
});

test('non-JSON and malformed detail failures retain HTTP status without raw body', async () => {
  for (const response of [
    new Response('<html>proxy credentials sb_secret_hidden</html>', { status: 503 }),
    new Response('', { status: 503 }),
    json(503, { detail: { code: {}, message: {} } }),
    json(503, { detail: null }),
  ]) {
    const api = client(async () => response);
    await assert.rejects(api.readProfile(session), failure(api, 503, 'http_503', 'API failed with HTTP 503'));
  }
});

test('invalid JSON success is a typed error rather than a fake profile', async () => {
  const api = client(async () => new Response('not JSON'));
  await assert.rejects(api.readProfile(session), failure(api, 200, 'invalid_response', 'API returned an invalid JSON response'));
});

test('network failures are safe, typed, and not retried', async () => {
  let requests = 0;
  const api = client(async () => { requests++; throw new Error(`fetch failed ${session.access_token}`); });
  await assert.rejects(api.createProfile(session, input), failure(api, null, 'network_error', 'Unable to reach the API. Check your connection.'));
  assert.equal(requests, 1);
});

test('missing configuration fails before fetch', async () => {
  const api = client(() => assert.fail('must not fetch'), {});
  await assert.rejects(api.readProfile(session), failure(api, null, 'configuration_error', 'Missing EXPO_PUBLIC_API_URL'));
});

test('deadline aborts a pending mutation, settles even if fetch ignores abort, and never retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let requests = 0;
  const api = client((_url, init) => { requests++; signal = init.signal; return new Promise(() => {}); });
  const pending = api.createProfile(session, input);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  t.mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(signal.aborted, false);
  const rejected = assert.rejects(pending, failure(api, null, 'request_timeout', 'API request timed out after 30 seconds. The server may have processed the request.'));
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(requests, 1);
});

test('deadline also bounds body reading and retains received HTTP status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let bodyStarted;
  const readingBody = new Promise(resolve => { bodyStarted = resolve; });
  const api = client(async (_url, init) => {
    signal = init.signal;
    return { status: 503, ok: false, json: () => { bodyStarted(); return new Promise(() => {}); } };
  });
  const pending = api.readProfile(session);
  await readingBody;
  const rejected = assert.rejects(pending, failure(api, 503, 'request_timeout', 'API request timed out after 30 seconds. The server may have processed the request.'));
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('settled success/failure clears deadline without aborting completed requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const status of [200, 404]) {
    let signal;
    const api = client(async (_url, init) => { signal = init.signal; return json(status, profile); });
    if (status === 200) await api.readProfile(session);
    else await assert.rejects(api.readProfile(session));
    t.mock.timers.tick(30_000);
    assert.equal(signal.aborted, false);
  }
});

test('existing infrastructure functions preserve signatures, payloads and results', async () => {
  const calls = [];
  const device = { registered: true, platform: 'android', updated_at: profile.updated_at };
  const result = {
    request_id: 'infra_123', success: true, database_verified: true, push_requested: true,
    expo_ticket_id: null, server_received_at: profile.created_at,
    timings_ms: { database: 1, push_request: 2, server_total: 3 },
  };
  const api = client(async (url, init) => {
    calls.push({ url, init });
    return json(200, url.endsWith('/devices/register') ? device : result);
  });
  assert.deepEqual(await api.registerDevice(session, 'ExpoPushToken[mock]'), device);
  assert.deepEqual(await api.runInfrastructureTest(session, 'infra_123', profile.created_at), result);
  assert.equal(calls[0].url, 'https://api.example.test/devices/register');
  assert.equal(calls[1].url, 'https://api.example.test/infrastructure-test');
  assert.deepEqual(JSON.parse(calls[0].init.body), { expo_push_token: 'ExpoPushToken[mock]', platform: 'android' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { request_id: 'infra_123', client_started_at: profile.created_at });
  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer current-access-secret');
  }
});
