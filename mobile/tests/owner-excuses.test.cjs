const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Real screens/stores with mocked host elements, Auth, API and app lifecycle.
// No native runtime or network is available here.
function compile(path, modules, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../${path}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Error, process: { env: {} }, require: modules, ...globals });
  return exports;
}
const cache = {};
const lib = name => cache[name] ??= compile(`lib/${name}.ts`, path => lib(path.slice(2)));
const { SessionStore, routeAccess } = lib('session-store');
const { ApiError } = lib('api');
const session = (id = 'a') => ({ user: { id }, access_token: `${id}-token` });
const profile = id => ({ user_id: id, username: id, timezone: 'UTC' });
const occurrence = (changes = {}) => ({
  id: 'occurrence-a', habit_id: 'habit-a', owner_id: 'a', local_date: '2026-10-10', timezone: 'Asia/Tokyo',
  closes_at: '2026-10-10T15:00:00Z', progress: 0, completed: false, state: 'in_progress',
  snapshot: { name: 'Original name', description: null, type: 'binary', target: null, unit: null,
    schedule: 'selected', weekdays: [1], reminder_times: ['08:00'] },
  created_at: '2026-10-09T15:00:00Z', updated_at: '2026-10-09T15:00:00Z', ...changes,
});
const today = (changes = {}) => ({
  local_date: '2026-10-10', timezone: 'America/Los_Angeles', server_time: '2026-10-11T05:00:00Z',
  occurrences: [occurrence()], ...changes,
});
const openToday = (changes = {}) => today({ server_time: '2026-10-10T12:00:00Z', ...changes });
const completedOccurrence = (changes = {}) => occurrence({ completed: true, state: 'completed', updated_at: '2026-10-10T12:01:00Z', ...changes });
const targetOccurrence = (changes = {}) => occurrence({ snapshot: { ...occurrence().snapshot,
  name: 'Read snapshot', type: 'target', target: 10, unit: 'pages' }, ...changes });
function clock() {
  let elapsed = 0, nextId = 0;
  const timers = new Map();
  return {
    globals: {
      performance: { now: () => elapsed },
      setTimeout: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, due: elapsed + delay }); return id; },
      clearTimeout: id => timers.delete(id),
    },
    advance: duration => {
      const end = elapsed + duration;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        elapsed = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      elapsed = end;
    },
    timerCount: () => timers.size,
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
const runtime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  const children = tree.type === 'FlatList'
    ? [tree.props.ListHeaderComponent, tree.props.data.length ? tree.props.data.map(item => tree.props.renderItem({ item })) : tree.props.ListEmptyComponent]
    : tree.props.children;
  return [tree, ...nodes(children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree && typeof tree === 'object' ? text(tree.props.children) : '';
}
async function screen(readToday, readProfile = async s => profile(s.user.id), initial = session(),
  setOccurrenceCompletion = async () => assert.fail('Unexpected completion request'),
  setOccurrenceProgress = async () => assert.fail('Unexpected progress request'), excuseAPI = {}) {
  let authEvent, store, focus, cleanup;
  const timer = clock();
  const { TodayStore } = compile('lib/today-store.ts', path => lib(path.slice(2)), timer.globals);
  const appListeners = new Set();
  const auth = {
    getSession: async () => ({ data: { session: initial } }),
    onAuthStateChange: cb => { authEvent = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, { readProfile, createProfile: async s => profile(s.user.id) });
  await sessions.start();
  const AppState = {
    currentState: 'active',
    addEventListener: (event, cb) => {
      assert.equal(event, 'change');
      appListeners.add(cb);
      return { remove: () => appListeners.delete(cb) };
    },
  };
  const modules = {
    ...require('./native-ui-support.cjs'),
    'react/jsx-runtime': runtime,
    react: { useCallback: fn => fn, useState: initial => [store ??= initial()], useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    'expo-router': { useFocusEffect: callback => { focus = callback; } },
    'react-native': { AppState, ActivityIndicator: 'ActivityIndicator', Button: 'Button', FlatList: 'FlatList',
      Text: 'Text', TextInput: 'TextInput', View: 'View', StyleSheet: { create: value => value } },
    '../components/form': { styles: {} },
    '../components/excuse-view': compile('components/excuse-view.tsx', name => name === 'react/jsx-runtime' ? runtime
      : name === 'react-native' ? { Text: 'Text', View: 'View' } : { styles: {} }),
    '../lib/excuse-input': lib('excuse-input'),
    '../lib/api': { readToday, setOccurrenceCompletion, setOccurrenceProgress, ...excuseAPI },
    '../lib/today-store': { TodayStore },
    '../lib/local-reminder-runtime': { localReminderService: { changed: async () => {} } },
    '../lib/session': { useSession: () => ({ store: sessions }) },
  };
  const exports = compile('app/today.tsx', name => { assert.ok(modules[name], `Unexpected module ${name}`); return modules[name]; });
  const render = () => nodes(exports.default());
  const list = () => render().find(node => node.type === 'FlatList').props;
  const row = id => {
    const item = list().data.find(item => item.id === id);
    return item ? nodes(list().renderItem({ item })) : [];
  };
  render();
  cleanup = focus();
  await flush();
  return {
    render, sessions, auth, store: () => store, row, advance: timer.advance, timerCount: timer.timerCount,
    texts: () => render().filter(node => node.type === 'Text').map(text),
    list,
    button: (title, id) => (id ? row(id) : render()).find(node => node.type === 'Button' && node.props.title === title),
    input: () => render().find(node => node.type === 'TextInput' && node.props.accessibilityLabel.startsWith('Explanation for')),
    remount: async () => { cleanup(); store = undefined; render(); cleanup = focus(); await flush(); },
    event: value => authEvent('SIGNED_IN', value),
    leave: () => cleanup(),
    focus: () => { cleanup = focus(); },
    appState: value => { AppState.currentState = value; appListeners.forEach(listener => listener(value)); },
    appListeners: () => appListeners.size,
  };
}

const result = (status = 'pending', item = occurrence()) => ({
  id: 'excuse-a', occurrence_id: item.id, habit_id: item.habit_id, owner_id: item.owner_id,
  explanation: 'Recovering 🌙', status, decision_source: status === 'pending' ? null : status === 'approved' ? 'automatic' : 'friend',
  decided_by: status === 'rejected' ? 'friend-b' : null, decided_at: status === 'pending' ? null : '2026-10-10T12:01:00Z',
  created_at: '2026-10-10T12:00:00Z', occurrence: { ...item, state: status === 'pending' ? 'justification_pending' : status === 'approved' ? 'excused' : 'missed', updated_at: '2026-10-10T12:01:00Z' },
});
const setup = (api = {}, read = async () => openToday()) => screen(read, undefined, undefined, undefined, undefined, api);
function draft(ui, value) { ui.button('Submit excuse')?.props.onPress(); ui.input().props.onChangeText(value); }
const submit = ui => ui.button('Submit and lock occurrence').props.onPress();
const texts = ui => ui.texts().join('\n');
const row = ui => ui.list().data[0];

for (const status of ['approved', 'pending']) for (const type of ['binary', 'target']) {
  test(`${type} submission displays server-returned ${status} and permanently locks normal writes`, async () => {
    const write = deferred();
    const item = type === 'binary' ? occurrence() : targetOccurrence({ progress: 3 });
    const confirmed = result(status, item);
    let submitted = false;
    const writes = [];
    const ui = await setup({ readExcuse: async () => confirmed,
      submitExcuse: (s, id, explanation) => { writes.push({ s, id, explanation }); return write.promise; } },
      async () => openToday({ occurrences: [submitted ? { ...confirmed.occurrence } : item] }));
    const capturedOrdinary = ui.button(type === 'binary' ? 'Complete' : 'Save progress').props.onPress;
    draft(ui, ' \u0085Recovering 🌙\u001c ');
    assert.match(texts(ui), /permanently locks ordinary completion, undo, and progress/);
    assert.match(texts(ui), /Unshared submissions automatically approve/);
    assert.match(texts(ui), /currently authorized friend/);
    const pending = submit(ui);
    await submit(ui); await capturedOrdinary();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].explanation, 'Recovering 🌙');
    assert.equal(writes[0].s.user.id, 'a'); assert.equal(writes[0].id, item.id);
    assert.equal(ui.button('Complete'), undefined); assert.equal(ui.button('Save progress'), undefined);
    assert.doesNotMatch(texts(ui), /Excuse automatically approved by the server|Excuse submitted\./);
    submitted = true; write.resolve(confirmed); await pending;
    assert.equal(row(ui).state, status === 'approved' ? 'excused' : 'justification_pending');
    assert.equal(row(ui).progress, item.progress); assert.equal(row(ui).completed, false);
    assert.match(texts(ui), status === 'approved' ? /automatically approved by the server/ : /Awaiting an authorized friend’s decision/);
    assert.match(texts(ui), /Recovering 🌙/); assert.match(texts(ui), /Submitted: 2026-10-10T12:00:00Z/);
    assert.match(texts(ui), status === 'approved' ? /Decision: Automatic/ : /Decision: Awaiting an authorized friend/);
    assert.equal(ui.input(), undefined); assert.equal(ui.button('Submit excuse'), undefined);
    await capturedOrdinary();
  });
}

test('blank, oversized and invalid Unicode explanations retain exact draft without dispatch', async () => {
  const ui = await setup({ submitExcuse: async () => assert.fail('Invalid input dispatched') });
  draft(ui, '');
  for (const value of ['', ' \u0085\u001c ', '🌙'.repeat(1001), 'NUL\0', '\ud800']) {
    ui.input().props.onChangeText(value); await submit(ui);
    assert.equal(ui.input().props.value, value);
    assert.match(texts(ui), /1–1,000|NUL|surrogate/);
    assert.equal(ui.button('Submit and lock occurrence').props.disabled, false);
  }
  ui.input().props.onChangeText(' 🌙 ');
  assert.match(texts(ui), /1 \/ 1,000 Unicode characters after trimming/);
});

test('submission excludes completed, missed, pending, excused and stale occurrence objects', async () => {
  for (const [state, completed] of [['completed', true], ['missed', false], ['justification_pending', false], ['excused', false], ['in_progress', true]]) {
    const ui = await setup({}, async () => openToday({ occurrences: [occurrence({ state, completed })] }));
    assert.equal(ui.button('Submit excuse'), undefined, state);
    ui.store().openExcuse(row(ui)); await ui.store().submitExplanation(row(ui));
    assert.equal(ui.input(), undefined); ui.leave();
  }
  const ui = await setup();
  assert.equal(ui.store().canSubmitExcuse({ ...row(ui) }), false);
  assert.equal(ui.store().canSubmitExcuse({ ...row(ui), owner_id: 'other' }), false);
});

test('original server deadline is strict at the exact instant despite a different profile timezone', async () => {
  const ui = await setup({}, async () => openToday({ server_time: '2026-10-10T14:59:58Z' }));
  draft(ui, 'Reason'); const capturedSubmit = ui.button('Submit and lock occurrence').props.onPress;
  ui.advance(1999); assert.equal(ui.button('Submit and lock occurrence').props.disabled, false);
  ui.advance(1); assert.equal(ui.button('Submit and lock occurrence').props.disabled, true);
  await capturedSubmit();
  assert.equal(row(ui).state, 'in_progress'); assert.equal(ui.input().props.value, 'Reason');
  assert.match(texts(ui), /2026-10-10T15:00:00Z/);
});

test('time receiving the server snapshot conservatively consumes the submission window', async () => {
  const read = deferred(); const ui = await setup({}, () => read.promise);
  ui.advance(2000); read.resolve(openToday({ server_time: '2026-10-10T14:59:59Z' })); await flush();
  assert.equal(ui.button('Submit excuse'), undefined); assert.equal(row(ui).state, 'in_progress');
});

for (const [status, code] of [[401, 'http_401'], [422, 'invalid_excuse_explanation'], [429, 'http_429']]) {
  test(`recoverable ${code} preserves explanation and enables an intentional retry`, async () => {
    let writes = 0;
    const ui = await setup({ submitExcuse: async () => { writes++; throw new ApiError('private server text', status, code); } });
    draft(ui, '  Recovering 🌙  '); await submit(ui);
    assert.equal(ui.input().props.value, '  Recovering 🌙  ');
    assert.equal(ui.button('Submit and lock occurrence').props.disabled, false);
    assert.match(texts(ui), /Your explanation is saved here/); assert.doesNotMatch(texts(ui), /private server text/);
    await submit(ui); assert.equal(writes, 2);
  });
}

for (const [status, code] of [[null, 'request_timeout'], [null, 'network_error'], [409, 'excuse_exists']]) {
  test(`${code} reads existing excuse AND current Today before resolving the outcome`, async () => {
    const current = deferred(), existing = deferred(); let reads = 0, gets = 0, writes = 0;
    const confirmed = result();
    const ui = await setup({ readExcuse: () => { gets++; return existing.promise; },
      submitExcuse: async () => { writes++; throw new ApiError('not confirmed', status, code); } },
      () => ++reads === 1 ? Promise.resolve(openToday()) : current.promise);
    draft(ui, 'Recovering 🌙'); const pending = submit(ui); await flush();
    assert.equal(reads, 2); assert.equal(gets, 1); assert.equal(ui.input().props.value, 'Recovering 🌙');
    assert.equal(ui.button('Submit and lock occurrence').props.disabled, true);
    existing.resolve(confirmed); await flush();
    assert.equal(ui.button('Submit and lock occurrence').props.disabled, true);
    await submit(ui); assert.equal(writes, 1);
    current.resolve(openToday({ occurrences: [{ ...confirmed.occurrence }] })); await pending;
    assert.equal(row(ui).state, 'justification_pending'); assert.match(texts(ui), /Excuse: pending/);
    assert.equal(ui.button('Submit excuse'), undefined); assert.equal(ui.button('Complete'), undefined);
  });
}

test('timeout retry requires excuse-not-found AND fresh eligible Today; failed Today retains guarded draft', async () => {
  let reads = 0, gets = 0, writes = 0;
  const ui = await setup({ readExcuse: async () => { gets++; throw new ApiError('missing', 404, 'excuse_not_found'); },
    submitExcuse: async () => { writes++; throw new ApiError('timeout', null, 'request_timeout'); } },
    async () => { if (++reads === 2) throw new ApiError('offline', null, 'network_error'); return openToday(); });
  draft(ui, 'Keep this explanation'); await submit(ui);
  assert.equal(ui.input().props.value, 'Keep this explanation');
  assert.equal(ui.button('Submit and lock occurrence').props.disabled, true);
  await submit(ui); assert.equal(writes, 1);
  await ui.button('Check submission').props.onPress();
  assert.equal(reads, 3); assert.equal(gets, 2);
  assert.equal(ui.button('Submit and lock occurrence').props.disabled, false);
  assert.equal(ui.input().props.value, 'Keep this explanation'); assert.match(texts(ui), /Current occurrence checked/);
});

test('excuse_exists never unlocks resubmission after an inconsistent not-found GET', async () => {
  const ui = await setup({ submitExcuse: async () => { throw new ApiError('saved', 409, 'excuse_exists'); },
    readExcuse: async () => { throw new ApiError('missing', 404, 'excuse_not_found'); } });
  draft(ui, 'Original explanation'); await submit(ui);
  assert.equal(ui.button('Submit and lock occurrence').props.disabled, true);
  assert.equal(ui.input().props.value, 'Original explanation'); assert.equal(ui.button('Complete'), undefined);
  await ui.button('Check submission').props.onPress();
  assert.equal(ui.button('Submit and lock occurrence').props.disabled, true);
});

for (const outcome of ['success', 'failure']) test(`account switch clears drafts and ignores late ${outcome} with reused occurrence IDs`, async () => {
  const write = deferred(); let writes = 0;
  const ui = await setup({ submitExcuse: () => { writes++; return write.promise; } },
    async s => openToday({ occurrences: [occurrence({ owner_id: s.user.id, snapshot: { ...occurrence().snapshot, name: `${s.user.id} habit` } })] }));
  draft(ui, 'Private owner A explanation');
  const capturedInput = ui.input().props.onChangeText, capturedSubmit = ui.button('Submit and lock occurrence').props.onPress;
  const pending = submit(ui); ui.event(session('b')); await flush();
  assert.equal(Object.keys(ui.store().snapshot().excuses).length, 0);
  assert.doesNotMatch(texts(ui), /Private owner A explanation|a habit/); assert.match(texts(ui), /b habit/);
  assert.ok(ui.button('Submit excuse')); capturedInput('Leaked draft'); await capturedSubmit();
  const accepted = ui.store().snapshot();
  if (outcome === 'success') write.resolve(result()); else write.reject(new ApiError('old failure', null, 'network_error'));
  await pending; assert.equal(ui.store().snapshot(), accepted); assert.equal(writes, 1);
  assert.doesNotMatch(texts(ui), /Leaked draft|old failure|Recovering/);
});

test('remount clears private text and pending guard automatically reconciles when the old submission settles', async () => {
  const write = deferred(); let writes = 0, gets = 0;
  const confirmed = result();
  const ui = await setup({ submitExcuse: () => { writes++; return write.promise; }, readExcuse: async () => { gets++; return confirmed; } });
  draft(ui, 'Private draft'); const pending = submit(ui); await ui.remount();
  assert.doesNotMatch(texts(ui), /Private draft/);
  assert.equal(ui.button('Submit excuse'), undefined); assert.equal(ui.button('Complete'), undefined);
  write.resolve(confirmed); await pending; await flush();
  assert.equal(writes, 1); assert.equal(gets, 1); assert.match(texts(ui), /Excuse: pending/);
  assert.equal(ui.button('Submit excuse'), undefined);
  assert.ok(!ui.render().some(node => node.type === 'ActivityIndicator'));
});

test('owner details preserve unresolved/archival information and refresh to a final late friend decision', async () => {
  let saved = result();
  const ui = await setup({ readExcuse: async () => saved }, async () => openToday({ occurrences: [{ ...saved.occurrence }] }));
  await ui.button('View excuse').props.onPress();
  assert.match(texts(ui), /Pending stays unresolved if no authorized friends remain/);
  assert.match(texts(ui), /Archived habits must be restored/);
  saved = { ...result('rejected'), decided_at: '2026-10-12T01:00:00Z' };
  await ui.list().onRefresh();
  assert.match(texts(ui), /Excuse: rejected/); assert.match(texts(ui), /Decision: Friend/);
  assert.match(texts(ui), /Decided by: friend-b/); assert.match(texts(ui), /Decided at: 2026-10-12T01:00:00Z/);
  assert.equal(row(ui).state, 'missed'); assert.equal(ui.button('Submit excuse'), undefined); assert.equal(ui.button('Complete'), undefined);
});

for (const remainsStale of [false, true]) test(`newer Today decision triggers a second excuse read; still-stale=${remainsStale}`, async () => {
  const pending = result();
  const final = result('rejected'); final.occurrence.updated_at = '2026-10-10T12:02:00Z';
  let gets = 0;
  const ui = await setup({ readExcuse: async () => ++gets === 1 || remainsStale ? pending : final },
    async () => openToday({ occurrences: [{ ...final.occurrence }] }));
  await ui.button('View excuse').props.onPress();
  assert.equal(gets, 2); assert.equal(row(ui).state, 'missed');
  assert.doesNotMatch(texts(ui), /Excuse: pending/);
  if (remainsStale) {
    assert.match(texts(ui), /occurrence changed while loading/); assert.ok(ui.button('Check submission'));
  } else assert.match(texts(ui), /Excuse: rejected/);
  assert.equal(ui.button('Submit excuse'), undefined); assert.equal(ui.button('Complete'), undefined);
});
