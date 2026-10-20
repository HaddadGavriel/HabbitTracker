const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function compile(name, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Error, ...globals });
  return exports;
}
const input = compile('excuse-input');
const username = compile('username-input');
function client(fetch, globals = {}) {
  return compile('api', { fetch, AbortController, process: { env: { EXPO_PUBLIC_API_URL: 'https://api.test/' } },
    setTimeout, clearTimeout, require: path => ({ './excuse-input': input, './username-input': username })[path], ...globals });
}
const session = { user: { id: 'owner-a' }, access_token: 'token-a' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('explanation normalization exactly follows Python whitespace, including C0/NEL and excluding BOM', () => {
  const whitespace = '\t\n\v\f\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
  assert.equal(input.explanationInput(`${whitespace}Recovered 🌙${whitespace}`), 'Recovered 🌙');
  assert.equal(input.explanationInput('\ufeff'), '\ufeff');
  assert.equal(input.explanationInput('inside\u0085space'), 'inside\u0085space');
  assert.equal(input.trimExplanation(whitespace), '');
});

test('explanation length counts Unicode code points, without grapheme or UTF-16 shortcuts', () => {
  for (const value of ['x', '🌙'.repeat(1000), 'e\u0301'.repeat(500), '\ufeff' + 'x'.repeat(999)]) {
    assert.equal(input.explanationInput(` \u0085${value}\n`), value);
  }
  for (const value of ['', '\u001c\u0085', 'x'.repeat(1001), '🌙'.repeat(1001), 'e\u0301'.repeat(501)]) {
    assert.throws(() => input.explanationInput(value), /1–1,000/);
  }
  for (const value of ['a\0b', '\ud800', '\udfff', 'a\ud800b']) {
    assert.throws(() => input.explanationInput(value), /NUL|surrogate/);
  }
});

test('excuse routes send only their exact contract, encoded IDs, and current account token', async () => {
  const calls = [];
  const returned = { id: 'excuse-1', status: 'pending', decision_source: null };
  const api = client(async (url, init) => { calls.push({ url, init }); return json(url.endsWith('/pending') ? [returned] : returned); });
  assert.deepEqual(await api.submitExcuse(session, 'occurrence/a?', ' \u0085Recovering 🌙\u001c '), returned);
  assert.deepEqual(await api.readExcuse(session, 'occurrence/a?'), returned);
  assert.deepEqual(await api.listPendingExcuses(session), [returned]);
  const renewed = { ...session, access_token: 'token-renewed' };
  await api.decideExcuse(renewed, 'excuse/a?', 'approve');
  await api.decideExcuse(renewed, 'excuse/a?', 'reject');
  assert.deepEqual(calls.map(({ url, init }) => [url, init.method, init.body && JSON.parse(init.body)]), [
    ['https://api.test/occurrences/occurrence%2Fa%3F/excuse', 'POST', { explanation: 'Recovering 🌙' }],
    ['https://api.test/occurrences/occurrence%2Fa%3F/excuse', 'GET', undefined],
    ['https://api.test/excuses/pending', 'GET', undefined],
    ['https://api.test/excuses/excuse%2Fa%3F/decision', 'POST', { decision: 'approve' }],
    ['https://api.test/excuses/excuse%2Fa%3F/decision', 'POST', { decision: 'reject' }],
  ]);
  assert.deepEqual(calls.map(call => call.init.headers.Authorization), ['Bearer token-a', 'Bearer token-a', 'Bearer token-a', 'Bearer token-renewed', 'Bearer token-renewed']);
});

test('invalid explanations never dispatch a submission', async () => {
  let requests = 0;
  const api = client(async () => { requests++; return json({}); });
  for (const value of ['', ' \u0085\u001c', '🌙'.repeat(1001), '\0', '\udfff']) {
    await assert.rejects(api.submitExcuse(session, 'occurrence', value), error => error instanceof api.ApiError && error.code === 'invalid_excuse_explanation');
  }
  assert.equal(requests, 0);
});

for (const [code, status] of [['excuse_exists', 409], ['excuse_already_decided', 409], ['excuse_not_found', 404], ['occurrence_closed', 409]]) {
  test(`excuse API preserves ${code} for reconciliation/access handling`, async () => {
    const api = client(async () => json({ detail: { code, message: 'Public domain message' } }, status));
    await assert.rejects(api.submitExcuse(session, 'occurrence', 'Reason'), error => error instanceof api.ApiError && error.status === status && error.code === code);
    await assert.rejects(api.decideExcuse(session, 'excuse', 'approve'), error => error instanceof api.ApiError && error.status === status && error.code === code);
  });
}

test('submission timeout aborts and remains ambiguous even when a success arrives later', async () => {
  let timeout, finish, signal;
  const api = client((_url, init) => { signal = init.signal; return new Promise(resolve => { finish = resolve; }); }, {
    setTimeout: callback => { timeout = callback; return 1; }, clearTimeout() {},
  });
  const pending = api.submitExcuse(session, 'occurrence', 'Reason');
  const failure = assert.rejects(pending, error => error.code === 'request_timeout');
  timeout();
  await failure;
  assert.equal(signal.aborted, true);
  finish(json({ id: 'saved-excuse', status: 'approved', decision_source: 'automatic' }, 201));
  await assert.rejects(pending, error => error.code === 'request_timeout');
});
