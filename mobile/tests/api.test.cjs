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
const usernameInput = {};
const excuseInput = {};
vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, '../lib/excuse-input.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: excuseInput });
vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, '../lib/username-input.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: usernameInput });
function client(fetch, env = { EXPO_PUBLIC_API_URL: 'https://api.example.test/' }) {
  const exports = {};
  vm.runInNewContext(source, {
    exports, process: { env }, fetch, AbortController,
    require: name => name === './username-input' ? usernameInput : name === './excuse-input' ? excuseInput : assert.fail(`Unexpected dependency: ${name}`),
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

const today = {
  local_date: '2026-10-11', timezone: 'Pacific/Kiritimati', server_time: '2026-10-10T23:30:00Z',
  occurrences: ['in_progress', 'completed', 'missed', 'justification_pending', 'excused'].map((state, index) => ({
    id: `00000000-0000-0000-0000-00000000000${index + 1}`,
    habit_id: `00000000-0000-0000-0000-00000000001${index + 1}`,
    owner_id: '00000000-0000-0000-0000-000000000020',
    local_date: '2026-10-11', timezone: 'Pacific/Kiritimati', closes_at: '2026-10-11T10:00:00Z',
    snapshot: {
      name: `Saved habit ${index}`, description: null,
      type: index < 2 ? 'binary' : 'target', target: index < 2 ? null : 10, unit: index === 2 ? 'pages' : null,
      schedule: 'selected', weekdays: [7], reminder_times: ['08:00'],
    },
    progress: index < 2 ? 0 : 3, completed: state === 'completed', state,
    created_at: '2026-10-10T10:00:00Z', updated_at: '2026-10-10T23:20:00Z',
  })),
};

test('Today GET uses the current session without date filters and preserves server snapshots and all states', async () => {
  const body = { ...today, occurrences: [...today.occurrences, {
    ...today.occurrences[2], id: '00000000-0000-0000-0000-000000000006',
    habit_id: '00000000-0000-0000-0000-000000000016',
    // Timezone snapshots may differ from the current profile timezone; progress is not capped.
    timezone: 'UTC', closes_at: '2026-10-12T00:00:00Z', progress: 12, completed: true, state: 'completed',
  }] };
  const calls = [];
  const api = client(async (url, init) => { calls.push({ url, init }); return json(200, body); });
  assert.deepEqual(await api.readToday(session), body);
  assert.deepEqual(await api.readToday({ ...session, access_token: 'refreshed-access' }), body);
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, 'https://api.example.test/today');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].init.headers.Authorization, 'Bearer current-access-secret');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer refreshed-access');
});

test('empty Today retains the server date, timezone, and timestamp', async () => {
  const body = { ...today, occurrences: [] };
  const api = client(async () => json(200, body));
  assert.deepEqual(await api.readToday(session), body);
});

test('Today auth, onboarding, server, network, and invalid JSON failures remain typed errors', async () => {
  for (const [respond, status, code, message] of [
    [() => json(401, { detail: 'Invalid or expired Supabase access token' }), 401, 'http_401', 'Invalid or expired Supabase access token'],
    [() => json(404, { detail: { code: 'profile_not_found', message: 'Create a profile to complete onboarding' } }), 404, 'profile_not_found', 'Create a profile to complete onboarding'],
    [() => json(503, { detail: null }), 503, 'http_503', 'API failed with HTTP 503'],
    [() => { throw new Error(`fetch failed ${session.access_token}`); }, null, 'network_error', 'Unable to reach the API. Check your connection.'],
    [() => new Response('not JSON'), 200, 'invalid_response', 'API returned an invalid JSON response'],
  ]) {
    let calls = 0;
    const api = client(async () => { calls++; return respond(); });
    await assert.rejects(api.readToday(session), failure(api, status, code, message));
    assert.equal(calls, 1);
  }
});

test('Today timeout settles once, aborts the request, and cannot become a late success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, finish, calls = 0;
  const api = client((_url, init) => {
    calls++; signal = init.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = api.readToday(session);
  const rejected = assert.rejects(pending, failure(api, null, 'request_timeout', 'API request timed out after 30 seconds. The server may have processed the request.'));
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(signal.aborted, true);
  finish(json(200, today));
  await assert.rejects(pending, error => error.code === 'request_timeout');
  assert.equal(calls, 1);
});

test('binary complete and undo PUT explicit booleans to the encoded ID using current credentials', async () => {
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    const { completed } = JSON.parse(init.body);
    return json(200, {
      ...today.occurrences[0], completed, state: completed ? 'completed' : 'in_progress',
      updated_at: '2026-10-10T23:31:00Z',
    });
  });
  for (const completed of [true, false]) {
    const currentSession = completed ? session : { ...session, access_token: 'refreshed-access' };
    assert.deepEqual(await api.setOccurrenceCompletion(currentSession, 'id/with spaces?#%', completed), {
      ...today.occurrences[0], completed, state: completed ? 'completed' : 'in_progress',
      updated_at: '2026-10-10T23:31:00Z',
    });
    const { url, init } = calls.at(-1);
    assert.equal(url, 'https://api.example.test/occurrences/id%2Fwith%20spaces%3F%23%25/completion');
    assert.equal(init.method, 'PUT');
    assert.deepEqual(JSON.parse(init.body), { completed });
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers.Authorization, `Bearer ${currentSession.access_token}`);
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls.length, 2);
});

test('completion preserves closed, locked, ownership, authentication and validation errors without retry', async () => {
  for (const [status, detail, code, message] of [
    [409, { code: 'occurrence_closed', message: 'Occurrence is closed' }, 'occurrence_closed', 'Occurrence is closed'],
    [409, { code: 'occurrence_locked', message: 'Occurrence is locked by an excuse submission' }, 'occurrence_locked', 'Occurrence is locked by an excuse submission'],
    [409, { code: 'wrong_occurrence_type', message: 'Operation does not match occurrence type' }, 'wrong_occurrence_type', 'Operation does not match occurrence type'],
    [404, { code: 'occurrence_not_found', message: 'Occurrence not found' }, 'occurrence_not_found', 'Occurrence not found'],
    [401, 'Invalid or expired Supabase access token', 'http_401', 'Invalid or expired Supabase access token'],
    [422, [{ loc: ['body', 'completed'], input: session.access_token }], 'validation_error', 'Request validation failed. Check the submitted fields.'],
    [503, null, 'http_503', 'API failed with HTTP 503'],
  ]) {
    let requests = 0;
    const api = client(async () => { requests++; return json(status, { detail }); });
    await assert.rejects(api.setOccurrenceCompletion(session, 'occurrence-id', true), failure(api, status, code, message));
    assert.equal(requests, 1);
  }
});

test('completion never retries uncertain network or invalid-response outcomes', async () => {
  for (const [respond, status, code, message] of [
    [() => { throw new Error(`Lost connection ${session.access_token}`); }, null, 'network_error', 'Unable to reach the API. Check your connection.'],
    [() => new Response('truncated response', { status: 200 }), 200, 'invalid_response', 'API returned an invalid JSON response'],
  ]) {
    let requests = 0;
    const api = client(async () => { requests++; return respond(); });
    await assert.rejects(api.setOccurrenceCompletion(session, 'occurrence-id', false), failure(api, status, code, message));
    assert.equal(requests, 1);
  }
});

test('completion timeout reports possible processing and ignores late success without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, finish, requests = 0;
  const api = client((_url, init) => {
    requests++; signal = init.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = api.setOccurrenceCompletion(session, 'occurrence-id', true);
  const timedOut = failure(api, null, 'request_timeout', 'API request timed out after 30 seconds. The server may have processed the request.');
  const rejected = assert.rejects(pending, timedOut);
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(signal.aborted, true);
  finish(json(200, { ...today.occurrences[0], completed: true, state: 'completed' }));
  await assert.rejects(pending, timedOut);
  assert.equal(requests, 1);
});

test('target progress PUT sends absolute values including reductions and zero with current credentials', async () => {
  const occurrence = { ...today.occurrences[2], progress: 12, completed: true, state: 'completed' };
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    const { progress } = JSON.parse(init.body);
    return json(200, {
      ...occurrence, progress, completed: progress >= occurrence.snapshot.target,
      state: progress >= occurrence.snapshot.target ? 'completed' : 'in_progress',
      updated_at: '2026-10-10T23:31:00Z',
    });
  });
  for (const progress of [12, 3, 0, Number.MAX_SAFE_INTEGER]) {
    const currentSession = { ...session, access_token: `current-access-${progress}` };
    const result = await api.setOccurrenceProgress(currentSession, 'id/with spaces?#%', progress);
    assert.deepEqual(result, {
      ...occurrence, progress, completed: progress >= occurrence.snapshot.target,
      state: progress >= occurrence.snapshot.target ? 'completed' : 'in_progress',
      updated_at: '2026-10-10T23:31:00Z',
    });
    const { url, init } = calls.at(-1);
    assert.equal(url, 'https://api.example.test/occurrences/id%2Fwith%20spaces%3F%23%25/progress');
    assert.equal(init.method, 'PUT');
    assert.deepEqual(JSON.parse(init.body), { progress });
    assert.equal(init.headers.Authorization, `Bearer ${currentSession.access_token}`);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers['Idempotency-Key'], undefined);
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls.length, 4);
});

test('target progress rejects unsafe, fractional, negative and nonnumber inputs before any request', async () => {
  let requests = 0;
  const api = client(async () => { requests++; return json(200, today.occurrences[2]); });
  for (const progress of [
    Number.MAX_SAFE_INTEGER + 1, Number('9007199254740993'), -1, 0.5,
    NaN, Infinity, -Infinity, '3', '', true, false, null, undefined, 3n,
  ]) {
    await assert.rejects(api.setOccurrenceProgress(session, 'occurrence-id', progress),
      failure(api, null, 'invalid_progress', 'Progress must be a nonnegative safe integer.'));
  }
  assert.equal(requests, 0);
});

test('target progress preserves deadline, locked, ownership, authentication and validation rejections without retry', async () => {
  for (const [status, detail, code, message] of [
    [409, { code: 'occurrence_closed', message: 'Occurrence is closed' }, 'occurrence_closed', 'Occurrence is closed'],
    [409, { code: 'occurrence_locked', message: 'Occurrence is locked by an excuse submission' }, 'occurrence_locked', 'Occurrence is locked by an excuse submission'],
    [409, { code: 'wrong_occurrence_type', message: 'Operation does not match occurrence type' }, 'wrong_occurrence_type', 'Operation does not match occurrence type'],
    [404, { code: 'occurrence_not_found', message: 'Occurrence not found' }, 'occurrence_not_found', 'Occurrence not found'],
    [404, { code: 'profile_not_found', message: 'Create a profile to complete onboarding' }, 'profile_not_found', 'Create a profile to complete onboarding'],
    [401, 'Invalid or expired Supabase access token', 'http_401', 'Invalid or expired Supabase access token'],
    [422, [{ loc: ['body', 'progress'], input: session.access_token }], 'validation_error', 'Request validation failed. Check the submitted fields.'],
    [503, null, 'http_503', 'API failed with HTTP 503'],
  ]) {
    let requests = 0;
    const api = client(async () => { requests++; return json(status, { detail }); });
    await assert.rejects(api.setOccurrenceProgress(session, 'occurrence-id', 3), failure(api, status, code, message));
    assert.equal(requests, 1);
  }
});

test('target progress never retries ambiguous network or invalid-response outcomes', async () => {
  for (const [respond, status, code, message] of [
    [() => { throw new Error(`Lost connection ${session.access_token}`); }, null, 'network_error', 'Unable to reach the API. Check your connection.'],
    [() => new Response('truncated response', { status: 200 }), 200, 'invalid_response', 'API returned an invalid JSON response'],
  ]) {
    let requests = 0;
    const api = client(async () => { requests++; return respond(); });
    await assert.rejects(api.setOccurrenceProgress(session, 'occurrence-id', 3), failure(api, status, code, message));
    assert.equal(requests, 1);
  }
});

test('target progress timeout stays ambiguous even if the server later confirms a reduction', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, signal, requests = 0;
  const api = client((_url, init) => {
    requests++; signal = init.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = api.setOccurrenceProgress(session, 'occurrence-id', 3);
  const timedOut = failure(api, null, 'request_timeout', 'API request timed out after 30 seconds. The server may have processed the request.');
  const rejected = assert.rejects(pending, timedOut);
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(signal.aborted, true);
  finish(json(200, { ...today.occurrences[2], progress: 3, completed: false, state: 'in_progress' }));
  await assert.rejects(pending, timedOut);
  assert.equal(requests, 1);
});

const history = {
  habit_id: 'owned-archived-habit', next_cursor: 'opaque-next-cursor',
  occurrences: today.occurrences.map((occurrence, index) => ({
    ...occurrence, habit_id: 'owned-archived-habit', local_date: `2026-10-${String(11 - index).padStart(2, '0')}`,
    excuse: index < 2 ? null : {
      id: `excuse-${index}`, explanation: 'Unable to finish this occurrence.',
      status: ['rejected', 'pending', 'approved'][index - 2],
      decision_source: index === 3 ? null : index === 4 ? 'automatic' : 'friend',
      decided_by: index === 2 ? 'deciding-friend-id' : null,
      decided_at: index === 3 ? null : '2026-10-10T21:00:00Z',
      created_at: '2026-10-10T20:00:00Z',
    },
  })),
};

test('owner history preserves stored snapshots, states and compact excuses for archived habits', async () => {
  const calls = [];
  const api = client(async (url, init) => { calls.push({ url, init }); return json(200, history); });
  for (const cursor of [undefined, null, 'opaque+/with spaces?&#%=']) {
    const currentSession = { ...session, access_token: 'refreshed-history-access' };
    assert.deepEqual(await api.readHabitHistory(currentSession, 'habit/with spaces?#%', cursor), history);
    const { url, init } = calls.at(-1);
    assert.equal(url, `https://api.example.test/habits/habit%2Fwith%20spaces%3F%23%25/history?limit=30${cursor == null ? '' : '&cursor=opaque%2B%2Fwith%20spaces%3F%26%23%25%3D'}`);
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, 'Bearer refreshed-history-access');
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls.length, 3);
});

test('owner history returns an empty page and uses the exact next cursor for continuation', async () => {
  const pages = [history, { habit_id: history.habit_id, occurrences: [], next_cursor: null }];
  const calls = [];
  const api = client(async (url, init) => { calls.push({ url, init }); return json(200, pages[calls.length - 1]); });
  const first = await api.readHabitHistory(session, history.habit_id);
  assert.deepEqual(first, history);
  const second = await api.readHabitHistory(session, history.habit_id, first.next_cursor);
  assert.deepEqual(second, pages[1]);
  assert.equal(calls[1].url, 'https://api.example.test/habits/owned-archived-habit/history?limit=30&cursor=opaque-next-cursor');
});

test('owner streak reads preserve server-calculated counts and provisional zero without local derivation', async () => {
  const calls = [];
  for (const [current_streak, provisional] of [[42, false], [2, true], [0, true], [0, false]]) {
    const streak = { habit_id: 'owned-archived-habit', current_streak, provisional, calculated_at: '2026-10-11T23:00:00Z' };
    const api = client(async (url, init) => { calls.push({ url, init }); return json(200, streak); });
    assert.deepEqual(await api.readHabitStreak({ ...session, access_token: 'current-streak-access' }, 'habit/with spaces?#%'), streak);
    const { url, init } = calls.at(-1);
    assert.equal(url, 'https://api.example.test/habits/habit%2Fwith%20spaces%3F%23%25/streak');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, 'Bearer current-streak-access');
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls.length, 4);
});

test('owner history and streak keep access failures typed and never replace errors with empty results', async () => {
  for (const operation of ['readHabitHistory', 'readHabitStreak']) {
    for (const [status, detail, code, message] of [
      [401, 'Invalid or expired Supabase access token', 'http_401', 'Invalid or expired Supabase access token'],
      [404, { code: 'profile_not_found', message: 'Create a profile to complete onboarding' }, 'profile_not_found', 'Create a profile to complete onboarding'],
      [404, { code: 'habit_not_found', message: 'Habit not found' }, 'habit_not_found', 'Habit not found'],
      [422, { code: 'invalid_history_cursor', message: 'Invalid history cursor for this habit and date range' }, 'invalid_history_cursor', 'Invalid history cursor for this habit and date range'],
      [503, null, 'http_503', 'API failed with HTTP 503'],
    ]) {
      let requests = 0;
      const api = client(async () => { requests++; return json(status, { detail }); });
      await assert.rejects(api[operation](session, history.habit_id), failure(api, status, code, message));
      assert.equal(requests, 1);
    }
    for (const [respond, status, code, message] of [
      [() => { throw new Error(`Lost connection ${session.access_token}`); }, null, 'network_error', 'Unable to reach the API. Check your connection.'],
      [() => new Response('not JSON'), 200, 'invalid_response', 'API returned an invalid JSON response'],
    ]) {
      let requests = 0;
      const api = client(async () => { requests++; return respond(); });
      await assert.rejects(api[operation](session, history.habit_id), failure(api, status, code, message));
      assert.equal(requests, 1);
    }
  }
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

test('habit filters use the backend status parameter and return the server array', async () => {
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    return json(200, []);
  });
  for (const status of ['active', 'archived', 'all']) {
    assert.deepEqual(await api.listHabits(session, status), []);
    assert.equal(calls.at(-1).url, `https://api.example.test/habits?status=${status}`);
    assert.equal(calls.at(-1).init.method, 'GET');
    assert.equal(calls.at(-1).init.body, undefined);
    assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer current-access-secret');
  }
  assert.equal(calls.length, 3);
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

const binaryCreate = {
  name: 'Read before bed', type: 'binary', schedule: 'daily', weekdays: [], reminder_times: ['21:30'],
};

test('habit POST sends exact binary/target contracts with the supplied current session and returns the created habit', async () => {
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    return json(201, {
      description: null, target: null, unit: null, ...JSON.parse(init.body),
      id: 'new-habit-id', owner_id: 'current-user-id', archived_at: null,
      created_at: profile.created_at, updated_at: profile.updated_at,
    });
  });
  const targetCreate = {
    name: 'Walk', description: 'Outside', type: 'target', target: 5000, unit: 'steps',
    schedule: 'selected', weekdays: [1, 3, 7], reminder_times: ['08:00', '21:30'],
  };
  for (const body of [binaryCreate, targetCreate, { ...targetCreate, unit: undefined }]) {
    const result = await api.createHabit({ ...session, access_token: 'refreshed-access' }, body);
    assert.deepEqual(result, {
      description: null, target: null, unit: null, ...JSON.parse(JSON.stringify(body)),
      id: 'new-habit-id', owner_id: 'current-user-id', archived_at: null,
      created_at: profile.created_at, updated_at: profile.updated_at,
    });
    const { url, init } = calls.at(-1);
    assert.equal(url, 'https://api.example.test/habits');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer refreshed-access');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), JSON.parse(JSON.stringify(body)));
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls.length, 3);
  const binaryPayload = JSON.parse(calls[0].init.body);
  for (const absent of ['owner_id', 'id', 'created_at', 'target', 'unit']) {
    assert.equal(Object.hasOwn(binaryPayload, absent), false);
  }
});

test('habit creation keeps validation, auth and server failures readable and sends each mutation only once', async () => {
  for (const [status, detail, code, message] of [
    [400, 'Invalid request', 'http_400', 'Invalid request'],
    [401, 'Invalid or expired Supabase access token', 'http_401', 'Invalid or expired Supabase access token'],
    [404, { code: 'profile_not_found', message: 'Create a profile to complete onboarding' }, 'profile_not_found', 'Create a profile to complete onboarding'],
    [422, [{ loc: ['body', 'name'], input: session.access_token }], 'validation_error', 'Request validation failed. Check the submitted fields.'],
    [422, { code: 'invalid_habit_configuration', message: 'Invalid resulting habit configuration' }, 'invalid_habit_configuration', 'Invalid resulting habit configuration'],
    [503, null, 'http_503', 'API failed with HTTP 503'],
  ]) {
    let requests = 0;
    const api = client(async () => { requests++; return json(status, { detail }); });
    await assert.rejects(api.createHabit(session, binaryCreate), failure(api, status, code, message));
    assert.equal(requests, 1);
  }
});

test('habit creation never retries ambiguous network or invalid-response failures', async () => {
  for (const [respond, status, code, message] of [
    [() => { throw new Error(`Lost connection ${session.access_token}`); }, null, 'network_error', 'Unable to reach the API. Check your connection.'],
    [() => new Response('truncated response', { status: 201 }), 201, 'invalid_response', 'API returned an invalid JSON response'],
  ]) {
    let requests = 0;
    const api = client(async () => { requests++; return respond(); });
    await assert.rejects(api.createHabit(session, binaryCreate), failure(api, status, code, message));
    assert.equal(requests, 1);
  }
});

test('habit creation timeout warns that creation may have succeeded and never retries or accepts a late success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  let signal;
  let finish;
  const api = client((_url, init) => {
    requests++;
    signal = init.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = api.createHabit(session, binaryCreate);
  const rejected = assert.rejects(pending, failure(api, null, 'request_timeout', 'API request timed out after 30 seconds. The server may have processed the request.'));
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(signal.aborted, true);
  finish(json(201, { ...binaryCreate, id: 'already-created' }));
  await assert.rejects(pending, failure(api, null, 'request_timeout', 'API request timed out after 30 seconds. The server may have processed the request.'));
  assert.equal(requests, 1);
});

test('habit read and PATCH use encoded IDs, current credentials and exact partial payloads', async () => {
  const existing = {
    ...binaryCreate, id: 'habit-id', owner_id: 'owner-id', description: null, target: null, unit: null,
    created_at: profile.created_at, updated_at: profile.updated_at, archived_at: null,
  };
  const changes = { description: null, schedule: 'selected', weekdays: [1, 7], reminder_times: ['08:00'] };
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    return json(200, init.method === 'PATCH' ? { ...existing, ...changes } : existing);
  });
  const id = 'id/with spaces?#%';
  assert.deepEqual(await api.readHabit(session, id), existing);
  assert.deepEqual(await api.updateHabit({ ...session, access_token: 'refreshed-access' }, id, changes), { ...existing, ...changes });
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, 'https://api.example.test/habits/id%2Fwith%20spaces%3F%23%25');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer current-access-secret');
  assert.equal(calls[1].init.method, 'PATCH');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer refreshed-access');
  assert.deepEqual(JSON.parse(calls[1].init.body), changes);
});

test('habit read and PATCH preserve readable auth, ownership, archival and validation failures without retry', async () => {
  for (const method of ['readHabit', 'updateHabit']) {
    for (const [status, detail, code, message] of [
      [401, 'Invalid or expired Supabase access token', 'http_401', 'Invalid or expired Supabase access token'],
      [404, { code: 'habit_not_found', message: 'Habit not found' }, 'habit_not_found', 'Habit not found'],
      [409, { code: 'habit_archived', message: 'Restore the habit before editing its configuration' }, 'habit_archived', 'Restore the habit before editing its configuration'],
      [422, [{ loc: ['body', 'name'], input: session.access_token }], 'validation_error', 'Request validation failed. Check the submitted fields.'],
      [422, { code: 'invalid_habit_configuration', message: 'Invalid resulting habit configuration' }, 'invalid_habit_configuration', 'Invalid resulting habit configuration'],
      [503, null, 'http_503', 'API failed with HTTP 503'],
    ]) {
      let requests = 0;
      const api = client(async () => { requests++; return json(status, { detail }); });
      await assert.rejects(api[method](session, 'habit-id', { name: 'Read more' }), failure(api, status, code, message));
      assert.equal(requests, 1);
    }
  }
});

test('habit PATCH never retries ambiguous network or invalid-response failures', async () => {
  for (const [respond, status, code, message] of [
    [() => { throw new Error(`Lost connection ${session.access_token}`); }, null, 'network_error', 'Unable to reach the API. Check your connection.'],
    [() => new Response('truncated response', { status: 200 }), 200, 'invalid_response', 'API returned an invalid JSON response'],
  ]) {
    let requests = 0;
    const api = client(async () => { requests++; return respond(); });
    await assert.rejects(api.updateHabit(session, 'habit-id', { unit: null }), failure(api, status, code, message));
    assert.equal(requests, 1);
  }
});

test('habit PATCH timeout warns about possible processing and ignores a late result without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  let signal;
  let finish;
  const api = client((_url, init) => {
    requests++;
    signal = init.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = api.updateHabit(session, 'habit-id', { description: null, unit: null });
  const rejected = assert.rejects(pending, failure(api, null, 'request_timeout', 'API request timed out after 30 seconds. The server may have processed the request.'));
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(signal.aborted, true);
  finish(json(200, { ...binaryCreate, id: 'habit-id', description: null }));
  await assert.rejects(pending, failure(api, null, 'request_timeout', 'API request timed out after 30 seconds. The server may have processed the request.'));
  assert.equal(requests, 1);
});

test('archive and restore POST encoded IDs with current credentials, no body and complete habit results', async () => {
  const existing = {
    ...binaryCreate, id: 'habit-id', owner_id: 'owner-id', description: null, target: null, unit: null,
    created_at: profile.created_at, updated_at: profile.updated_at, archived_at: null,
  };
  const archived = { ...existing, archived_at: '2026-10-11T12:00:00Z', updated_at: '2026-10-11T12:00:00Z' };
  const restored = { ...existing, updated_at: '2026-10-11T13:00:00Z' };
  const calls = [];
  const api = client(async (url, init) => {
    calls.push({ url, init });
    return json(200, url.endsWith('/archive') ? archived : restored);
  });
  const id = 'id/with spaces?#%';
  assert.deepEqual(await api.archiveHabit(session, id), archived);
  assert.deepEqual(await api.restoreHabit({ ...session, access_token: 'refreshed-access' }, id), restored);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.example.test/habits/id%2Fwith%20spaces%3F%23%25/archive');
  assert.equal(calls[1].url, 'https://api.example.test/habits/id%2Fwith%20spaces%3F%23%25/restore');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer current-access-secret');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer refreshed-access');
  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(Object.hasOwn(init, 'body'), false);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
  }
});

test('lifecycle auth, ownership, profile, validation and server failures stay readable without retry', async () => {
  for (const method of ['archiveHabit', 'restoreHabit']) {
    for (const [status, detail, code, message] of [
      [401, 'Invalid or expired Supabase access token', 'http_401', 'Invalid or expired Supabase access token'],
      [404, { code: 'habit_not_found', message: 'Habit not found' }, 'habit_not_found', 'Habit not found'],
      [404, { code: 'profile_not_found', message: 'Create a profile to complete onboarding' }, 'profile_not_found', 'Create a profile to complete onboarding'],
      [422, [{ loc: ['path', 'habit_id'], input: session.access_token }], 'validation_error', 'Request validation failed. Check the submitted fields.'],
      [503, null, 'http_503', 'API failed with HTTP 503'],
    ]) {
      let requests = 0;
      const api = client(async () => { requests++; return json(status, { detail }); });
      await assert.rejects(api[method](session, 'habit-id'), failure(api, status, code, message));
      assert.equal(requests, 1);
    }
  }
});

test('lifecycle network and invalid-response failures never trigger automatic mutation retries', async () => {
  for (const method of ['archiveHabit', 'restoreHabit']) {
    for (const [respond, status, code, message] of [
      [() => { throw new Error(`Lost connection ${session.access_token}`); }, null, 'network_error', 'Unable to reach the API. Check your connection.'],
      [() => new Response('truncated response', { status: 200 }), 200, 'invalid_response', 'API returned an invalid JSON response'],
    ]) {
      let requests = 0;
      const api = client(async () => { requests++; return respond(); });
      await assert.rejects(api[method](session, 'habit-id'), failure(api, status, code, message));
      assert.equal(requests, 1);
    }
  }
});

test('lifecycle timeouts warn of possible processing, ignore late successes and never retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const method of ['archiveHabit', 'restoreHabit']) {
    let requests = 0;
    let signal;
    let finish;
    const api = client((_url, init) => {
      requests++;
      signal = init.signal;
      return new Promise(resolve => { finish = resolve; });
    });
    const pending = api[method](session, 'habit-id');
    const timedOut = failure(api, null, 'request_timeout', 'API request timed out after 30 seconds. The server may have processed the request.');
    const rejected = assert.rejects(pending, timedOut);
    t.mock.timers.tick(30_000);
    await rejected;
    assert.equal(signal.aborted, true);
    finish(json(200, { ...binaryCreate, id: 'habit-id', archived_at: method === 'archiveHabit' ? profile.created_at : null }));
    await assert.rejects(pending, timedOut);
    assert.equal(requests, 1);
  }
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

test('profile PATCH sends only editable fields and uses the supplied access token', async () => {
  let call;
  const api = client(async (url, init) => { call = { url, init }; return json(200, profile); });
  const fields = { username: 'alice_1', display_name: 'Alice', timezone: 'Asia/Jerusalem' };
  assert.deepEqual(await api.updateProfile(session, fields), profile);
  assert.equal(call.url, 'https://api.example.test/profiles/me'); assert.equal(call.init.method,'PATCH');
  assert.deepEqual(JSON.parse(call.init.body),fields); assert.equal(call.init.headers.Authorization,'Bearer current-access-secret');
});
