const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual screen handlers and stores with mocked host elements, Auth,
// and API promises. Keyed children remount just as they do under React navigation.
function compile(path, modules) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../${path}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, process: { env: {} }, require: modules });
  return exports;
}
const cache = {};
const lib = name => cache[name] ??= compile(`lib/${name}.ts`, path => lib(path.slice(2)));
const { SessionStore, routeAccess } = lib('session-store');
const { HistoryStore } = lib('history-store');
const { ApiError } = lib('api');
const habitA = 'aaaaaaaa-1111-4111-8111-111111111111';
const habitB = 'bbbbbbbb-2222-4222-8222-222222222222';
const session = (id = 'a') => ({ user: { id }, access_token: `${id}-token` });
const profile = id => ({ user_id: id, username: id, timezone: 'UTC' });
const occurrence = (changes = {}) => ({
  id: 'occurrence-a', habit_id: habitA, owner_id: 'a', local_date: '2026-10-10', timezone: 'Asia/Tokyo',
  closes_at: '2026-10-10T15:00:00Z', progress: 0, completed: false, state: 'in_progress',
  snapshot: { name: 'Original name', description: 'Saved description', type: 'binary', target: null, unit: null,
    schedule: 'selected', weekdays: [1, 7], reminder_times: ['08:00', '17:30'] },
  excuse: null, created_at: '2026-10-09T15:00:00Z', updated_at: '2026-10-09T15:00:00Z', ...changes,
});
const history = (changes = {}) => ({ habit_id: habitA, occurrences: [occurrence()], next_cursor: null, ...changes });
const streak = (changes = {}) => ({ habit_id: habitA, current_streak: 42, provisional: false, calculated_at: '2026-10-11T05:00:00Z', ...changes });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  const children = tree.type === 'FlatList'
    ? [tree.props.ListHeaderComponent, tree.props.data.length ? tree.props.data.map(item => tree.props.renderItem({ item })) : tree.props.ListEmptyComponent, tree.props.ListFooterComponent]
    : tree.props.children;
  return [tree, ...nodes(children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree && typeof tree === 'object' ? text(tree.props.children) : '';
}
async function screen({ readHabitHistory = async () => history(), readHabitStreak = async () => streak(),
  readProfile = async s => profile(s.user.id), initial = session(), id = habitA } = {}) {
  let authEvent, store, focus, cleanup, activeKey, needsFocus = false;
  let params = { id };
  const auth = {
    getSession: async () => ({ data: { session: initial } }),
    onAuthStateChange: cb => { authEvent = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, { readProfile, createProfile: async s => profile(s.user.id) });
  await sessions.start();
  const jsx = (type, props, key) => {
    if (typeof type !== 'function') return { type, props, key };
    if (key !== undefined && key !== activeKey) {
      cleanup?.();
      store = undefined;
      activeKey = key;
      needsFocus = true;
    }
    return type(props);
  };
  const navigations = [];
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    react: { useCallback: fn => fn, useState: initial => [store ??= initial()], useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    'expo-router': { useLocalSearchParams: () => params, useFocusEffect: callback => { focus = callback; }, router: { dismissTo: path => navigations.push(path) } },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Button: 'Button', FlatList: 'FlatList',
      Text: 'Text', View: 'View', StyleSheet: { create: value => value } },
    '../components/form': { Form: 'Form', Message: props => jsx('Text', { children: props.text }), styles: {} },
    '../lib/api': { readHabitHistory, readHabitStreak },
    '../lib/history-store': { HistoryStore },
    '../lib/session': { useSession: () => ({ store: sessions }) },
  };
  const exports = compile('app/habit-history.tsx', name => { assert.ok(modules[name], `Unexpected module ${name}`); return modules[name]; });
  const render = () => {
    let tree = exports.default();
    if (needsFocus) {
      needsFocus = false;
      cleanup = focus();
      tree = exports.default();
    }
    return nodes(tree);
  };
  render();
  await flush();
  return {
    render, sessions, auth, navigations, store: () => store,
    list: () => render().find(node => node.type === 'FlatList')?.props,
    texts: () => render().filter(node => node.type === 'Text').map(text),
    button: title => render().find(node => node.type === 'Button' && node.props.title === title),
    spinner: label => render().find(node => node.type === 'ActivityIndicator' && node.props.accessibilityLabel === label),
    event: value => authEvent('SIGNED_IN', value),
    leave: () => cleanup(),
    focus: () => { cleanup = focus(); },
    changeHabit: value => { params = { id: value }; render(); },
  };
}
const rowIds = ui => Array.from(ui.list().data, row => row.id);
function cleared(ui) {
  assert.deepEqual(rowIds(ui), []);
  assert.equal(ui.store().snapshot().streak, null);
  assert.equal(ui.store().snapshot().nextCursor, null);
  assert.equal(ui.store().snapshot().error, null);
  assert.equal(ui.store().snapshot().streakError, null);
  assert.ok(!ui.texts().some(value => /Original name|42 occurrences/.test(value)));
}

test('history displays independently while streak is still loading, then displays the server count', async () => {
  const pendingHistory = deferred(), pendingStreak = deferred();
  const ui = await screen({ readHabitHistory: () => pendingHistory.promise, readHabitStreak: () => pendingStreak.promise });
  assert.ok(ui.spinner('Loading habit history'));
  assert.ok(ui.spinner('Loading current streak'));
  assert.ok(!ui.texts().some(value => /No history/.test(value)));
  pendingHistory.resolve(history());
  await flush();
  assert.ok(ui.texts().includes('2026-10-10 · Original name'));
  assert.equal(ui.spinner('Loading habit history'), undefined);
  assert.ok(ui.spinner('Loading current streak'));
  assert.equal(ui.list().keyExtractor(occurrence()), 'occurrence-a');
  pendingStreak.resolve(streak());
  await flush();
  // A single unfinished page row cannot produce this value through local calculation.
  assert.ok(ui.texts().includes('42 occurrences'));
  assert.ok(ui.texts().includes('Calculated by the server at 2026-10-11T05:00:00Z.'));
});

for (const count of [0, 1, 7]) test(`server provisional streak ${count} is labeled even with empty history`, async () => {
  const ui = await screen({ readHabitHistory: async () => history({ occurrences: [] }), readHabitStreak: async () => streak({ current_streak: count, provisional: true }) });
  assert.ok(ui.texts().includes(`${count} ${count === 1 ? 'occurrence' : 'occurrences'}`));
  assert.ok(ui.texts().includes('Provisional — pending excuse decisions may change this streak.'));
  assert.ok(ui.texts().includes('No history yet for this habit.'));
  assert.equal(ui.button('Load more'), undefined);
});

test('read-only history shows stored snapshots, dates, progress, states and compact excuse fields', async () => {
  const states = ['in_progress', 'completed', 'missed', 'justification_pending', 'excused'];
  const rows = states.map((state, index) => occurrence({ id: `row-${index}`, state,
    local_date: `2026-10-0${9 - index}`, completed: index === 2,
    snapshot: { ...occurrence().snapshot, name: `Saved ${state}` },
  }));
  rows.push(occurrence({ id: 'target', local_date: '2026-10-04', progress: 13,
    snapshot: { ...occurrence().snapshot, name: 'Original target', type: 'target', target: 10, unit: 'pages', schedule: 'daily', weekdays: [] },
    excuse: { id: 'excuse-a', explanation: 'Saved explanation', status: 'approved', decision_source: 'friend', decided_by: 'friend-id',
      created_at: '2026-10-04T08:00:00Z', decided_at: '2026-10-05T08:00:00Z' },
  }));
  rows.push(occurrence({ id: 'unitless', local_date: '2026-10-03', progress: 2,
    snapshot: { ...occurrence().snapshot, name: 'Unitless', type: 'target', target: 5, unit: null, reminder_times: [] },
    excuse: { id: 'excuse-b', explanation: 'Pending explanation', status: 'pending', decision_source: null, decided_by: null, decided_at: null, created_at: '2026-10-03T08:00:00Z' },
  }));
  const ui = await screen({ readHabitHistory: async () => history({ occurrences: rows }) });
  const shown = ui.texts();
  assert.deepEqual(shown.filter(value => value.startsWith('State:')), [
    'State: In progress', 'State: Completed', 'State: Missed', 'State: Excuse pending', 'State: Excused', 'State: In progress', 'State: In progress',
  ]);
  for (const value of ['2026-10-04 · Original target', 'Saved description', 'Progress: 13 / 10 pages', 'Progress: 2 / 5',
    'Binary: Completed', 'Binary: Not completed', 'Schedule: Monday, Sunday', 'Schedule: Every day',
    'Saved reminder times: 08:00, 17:30', 'Timezone: Asia/Tokyo', 'Deadline: 2026-10-10T15:00:00Z',
    'Excuse: approved', 'Saved explanation', 'Submitted: 2026-10-04T08:00:00Z', 'Decision: Friend', 'Decided by: friend-id',
    'Decided at: 2026-10-05T08:00:00Z', 'Excuse: pending', 'Pending explanation']) assert.ok(shown.includes(value), value);
  assert.equal(shown.filter(value => value.startsWith('Decided at:')).length, 1);
  assert.equal(shown.filter(value => value.startsWith('Decided by:')).length, 1);
  assert.ok(!ui.render().some(node => ['Button', 'Pressable', 'TextInput', 'Link'].includes(node.type)));
  assert.ok(!shown.some(value => /Provisional/.test(value)));
});

test('automatic excuse decisions render without inventing a deciding friend', async () => {
  const ui = await screen({ readHabitHistory: async () => history({ occurrences: [occurrence({ excuse: {
    id: 'excuse', explanation: 'Travel', status: 'approved', decision_source: 'automatic', decided_by: null,
    created_at: '2026-10-10T10:00:00Z', decided_at: '2026-10-10T15:00:00Z',
  } })] }) });
  assert.ok(ui.texts().includes('Decision: Automatic'));
  assert.ok(!ui.texts().some(value => value.startsWith('Decided by:')));
});

for (const [error, message] of [
  [new ApiError('private auth detail', 401, 'http_401'), /verify your session/i],
  [new ApiError('private absent detail', 404, 'habit_not_found'), /no longer available to your account/i],
  [new ApiError('private network detail', null, 'network_error'), /connection/i],
  [new ApiError('private timeout detail', null, 'request_timeout'), /timed out/i],
  [new ApiError('private upstream detail', 503, 'http_503'), /unable to load/i],
]) test(`initial history ${error.code} leaves streak visible and has a guarded working retry`, async () => {
  const retry = deferred();
  let reads = 0, streakReads = 0;
  const ui = await screen({ readHabitHistory: async () => { if (++reads === 1) throw error; return retry.promise; },
    readHabitStreak: async () => { streakReads++; return streak(); } });
  assert.match(ui.texts().join(' '), message);
  assert.ok(ui.texts().includes('42 occurrences'));
  assert.ok(!ui.texts().some(value => /private|No history/.test(value)));
  const retryAction = ui.button('Retry history').props.onPress;
  const pending = retryAction();
  await retryAction();
  assert.equal(reads, 2);
  assert.equal(streakReads, 1);
  assert.ok(ui.spinner('Loading habit history'));
  retry.resolve(history({ occurrences: [] }));
  await pending;
  assert.ok(ui.texts().includes('No history yet for this habit.'));
  assert.equal(ui.button('Retry history'), undefined);
});

test('streak failure keeps successful history and pagination, and retries streak alone', async () => {
  const retry = deferred();
  let reads = 0, streakReads = 0;
  const ui = await screen({ readHabitHistory: async () => { reads++; return history({ next_cursor: 'opaque-cursor' }); },
    readHabitStreak: async () => { if (++streakReads === 1) throw new ApiError('private details', null, 'network_error'); return retry.promise; } });
  assert.deepEqual(rowIds(ui), ['occurrence-a']);
  assert.equal(ui.button('Load more').props.disabled, false);
  const action = ui.button('Retry streak').props.onPress;
  const pending = action();
  await action();
  assert.equal(streakReads, 2);
  assert.equal(reads, 1);
  assert.ok(ui.spinner('Loading current streak'));
  assert.deepEqual(rowIds(ui), ['occurrence-a']);
  retry.resolve(streak({ current_streak: 0, provisional: true }));
  await pending;
  assert.ok(ui.texts().includes('0 occurrences'));
  assert.equal(ui.button('Retry streak'), undefined);
});

test('Load more uses the opaque cursor once, deduplicates IDs, and orders by stored date then ID', async () => {
  const older = deferred();
  const calls = [];
  const latest = occurrence({ id: 'latest', local_date: '2026-10-12' });
  const ui = await screen({ readHabitHistory: (s, id, cursor) => {
    calls.push({ s, id, cursor });
    return cursor ? older.promise : Promise.resolve(history({ occurrences: [occurrence({ id: 'row-a' }), latest, latest], next_cursor: 'opaque+/=' }));
  } });
  assert.deepEqual(rowIds(ui), ['latest', 'row-a']);
  const action = ui.button('Load more').props.onPress;
  const pending = action();
  await action();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, 'opaque+/=');
  assert.equal(calls[1].id, habitA);
  assert.equal(calls[1].s.access_token, 'a-token');
  assert.equal(ui.button('Load more').props.disabled, true);
  assert.ok(ui.spinner('Loading older history'));
  older.resolve(history({ occurrences: [occurrence({ id: 'row-b' }), latest,
    occurrence({ id: 'oldest', local_date: '2026-10-01', timezone: 'Pacific/Honolulu' })], next_cursor: null }));
  await pending;
  assert.deepEqual(rowIds(ui), ['latest', 'row-b', 'row-a', 'oldest']);
  assert.equal(ui.button('Load more'), undefined);
  assert.ok(ui.texts().includes('You’ve reached the end of this habit’s history.'));
  await action();
  assert.equal(calls.length, 2);
});

test('failed older page preserves rows and cursor and offers a guarded retry', async () => {
  let reads = 0;
  const retry = deferred();
  const ui = await screen({ readHabitHistory: async (_s, _id, cursor) => {
    reads++;
    if (!cursor) return history({ next_cursor: 'cursor-1' });
    if (reads === 2) throw new ApiError('private pagination failure', null, 'network_error');
    assert.equal(cursor, 'cursor-1');
    return retry.promise;
  } });
  await ui.button('Load more').props.onPress();
  assert.deepEqual(rowIds(ui), ['occurrence-a']);
  assert.match(ui.texts().join(' '), /Unable to load older history/);
  const action = ui.button('Retry older history').props.onPress;
  const pending = action();
  await action();
  assert.equal(reads, 3);
  retry.resolve(history({ occurrences: [occurrence({ id: 'older', local_date: '2026-10-09' })] }));
  await pending;
  assert.deepEqual(rowIds(ui), ['occurrence-a', 'older']);
  assert.equal(ui.button('Retry older history'), undefined);
});

for (const outcome of ['success', 'failure']) test(`refresh resets pagination and rejects an old page ${outcome}`, async () => {
  const oldPage = deferred(), fresh = deferred();
  const calls = [];
  const ui = await screen({ readHabitHistory: (_s, _id, cursor) => {
    calls.push(cursor);
    return [Promise.resolve(history({ next_cursor: 'old-cursor' })), oldPage.promise, fresh.promise,
      Promise.resolve(history({ occurrences: [occurrence({ id: 'new-older', local_date: '2026-10-01' })] }))][calls.length - 1];
  } });
  const capturedMore = ui.button('Load more').props.onPress;
  const oldPending = capturedMore();
  const refresh = ui.list().onRefresh();
  await ui.list().onRefresh();
  await capturedMore();
  assert.equal(ui.list().refreshing, true);
  assert.equal(ui.button('Load more'), undefined);
  assert.deepEqual(calls, [undefined, 'old-cursor', undefined]);
  fresh.resolve(history({ occurrences: [occurrence({ id: 'fresh', local_date: '2026-10-11' })], next_cursor: 'new-cursor' }));
  await refresh;
  const accepted = ui.store().snapshot();
  if (outcome === 'success') oldPage.resolve(history({ occurrences: [occurrence({ id: 'stale' })], next_cursor: 'stale-cursor' }));
  else oldPage.reject(new Error('old page failed'));
  await oldPending;
  assert.equal(ui.store().snapshot(), accepted);
  assert.deepEqual(rowIds(ui), ['fresh']);
  await ui.button('Load more').props.onPress();
  assert.equal(calls[3], 'new-cursor');
  assert.deepEqual(rowIds(ui), ['fresh', 'new-older']);
});

test('failed refresh keeps loaded history/streak but invalidates the cursor until first-page retry succeeds', async () => {
  let reads = 0, streakReads = 0;
  const ui = await screen({ readHabitHistory: async () => {
    if (++reads === 2) throw new Error('offline');
    return history({ next_cursor: reads === 1 ? 'old-cursor' : 'new-cursor' });
  }, readHabitStreak: async () => { if (++streakReads === 2) throw new Error('offline'); return streak(); } });
  const capturedMore = ui.button('Load more').props.onPress;
  await ui.list().onRefresh();
  assert.deepEqual(rowIds(ui), ['occurrence-a']);
  assert.ok(ui.texts().includes('42 occurrences'));
  assert.ok(ui.texts().includes('Showing the last loaded streak.'));
  assert.ok(ui.texts().includes('Showing the last loaded history. Refresh successfully before loading older entries.'));
  await capturedMore();
  assert.equal(reads, 2);
  assert.equal(ui.button('Load more'), undefined);
  await ui.button('Retry history').props.onPress();
  assert.equal(ui.store().snapshot().nextCursor, 'new-cursor');
  assert.ok(ui.button('Load more'));
  assert.ok(ui.button('Retry streak'));
  assert.equal(streakReads, 2);
});

for (const outcome of ['success', 'failure']) test(`failed refresh still rejects an earlier continuation ${outcome}`, async () => {
  const oldPage = deferred();
  const calls = [];
  const ui = await screen({ readHabitHistory: async (_s, _id, cursor) => {
    calls.push(cursor);
    if (cursor) return oldPage.promise;
    if (calls.length === 3) throw new Error('refresh offline');
    return history({ next_cursor: calls.length === 1 ? 'old-cursor' : 'fresh-cursor' });
  } });
  const capturedMore = ui.button('Load more').props.onPress;
  const pending = capturedMore();
  await ui.list().onRefresh();
  const failedRefresh = ui.store().snapshot();
  assert.ok(ui.button('Retry history'));
  assert.equal(failedRefresh.nextCursor, null);
  if (outcome === 'success') oldPage.resolve(history({ occurrences: [occurrence({ id: 'stale' })], next_cursor: 'stale-cursor' }));
  else oldPage.reject(new Error('old page offline'));
  await pending;
  assert.equal(ui.store().snapshot(), failedRefresh);
  assert.deepEqual(rowIds(ui), ['occurrence-a']);
  assert.equal(ui.button('Retry older history'), undefined);
  await capturedMore();
  assert.deepEqual(calls, [undefined, 'old-cursor', undefined]);
  await ui.button('Retry history').props.onPress();
  assert.equal(ui.store().snapshot().nextCursor, 'fresh-cursor');
});

test('a successful history refresh supersedes an older pending streak response independently', async () => {
  const oldStreak = deferred();
  let streakReads = 0;
  const ui = await screen({ readHabitStreak: () => ++streakReads === 1 ? oldStreak.promise : Promise.resolve(streak({ current_streak: 9, provisional: true })) });
  assert.deepEqual(rowIds(ui), ['occurrence-a']);
  await ui.list().onRefresh();
  const accepted = ui.store().snapshot();
  oldStreak.resolve(streak({ current_streak: 100 }));
  await flush();
  assert.equal(ui.store().snapshot(), accepted);
  assert.ok(ui.texts().includes('9 occurrences'));
});

for (const outcome of ['success', 'failure']) test(`keyed habit navigation remounts and ignores old page/streak ${outcome}`, async () => {
  const oldPage = deferred(), oldStreak = deferred();
  const requested = [];
  const ui = await screen({ readHabitHistory: async (_s, id, cursor) => {
    requested.push({ id, cursor });
    if (id === habitB) return history({ habit_id: habitB, occurrences: [occurrence({ id: 'other-habit', habit_id: habitB })] });
    return cursor ? oldPage.promise : history({ next_cursor: 'old-cursor' });
  }, readHabitStreak: (_s, id) => id === habitB ? Promise.resolve(streak({ habit_id: habitB, current_streak: 3 })) : oldStreak.promise });
  const oldStore = ui.store();
  const capturedMore = ui.button('Load more').props.onPress;
  const pending = capturedMore();
  ui.changeHabit(habitB.toUpperCase());
  await flush();
  assert.notEqual(ui.store(), oldStore);
  assert.deepEqual(Array.from(oldStore.snapshot().occurrences), []);
  assert.deepEqual(rowIds(ui), ['other-habit']);
  assert.ok(ui.texts().includes('3 occurrences'));
  const accepted = ui.store().snapshot();
  if (outcome === 'success') { oldPage.resolve(history()); oldStreak.resolve(streak()); }
  else { oldPage.reject(new Error('previous habit page')); oldStreak.reject(new Error('previous habit streak')); }
  await pending;
  await flush();
  await capturedMore();
  assert.equal(ui.store().snapshot(), accepted);
  assert.deepEqual(requested, [{ id: habitA, cursor: undefined }, { id: habitA, cursor: 'old-cursor' }, { id: habitB, cursor: undefined }]);
});

for (const outcome of ['success', 'failure']) test(`account changes clear owner data while profile loads and reject old page/streak ${outcome}`, async () => {
  const oldPage = deferred(), oldStreak = deferred(), nextProfile = deferred();
  const ui = await screen({ readProfile: s => s.user.id === 'b' ? nextProfile.promise : Promise.resolve(profile('a')),
    readHabitHistory: async (s, _id, cursor) => s.user.id === 'b'
      ? history({ occurrences: [occurrence({ id: 'owner-b', owner_id: 'b' })] })
      : cursor ? oldPage.promise : history({ next_cursor: 'old-cursor' }),
    readHabitStreak: s => s.user.id === 'b' ? Promise.resolve(streak({ current_streak: 2 })) : oldStreak.promise,
  });
  const pending = ui.button('Load more').props.onPress();
  ui.event(session('b'));
  cleared(ui);
  assert.equal(ui.sessions.snapshot().status, 'loading');
  nextProfile.resolve(profile('b'));
  await flush();
  assert.deepEqual(rowIds(ui), ['owner-b']);
  const accepted = ui.store().snapshot();
  if (outcome === 'success') { oldPage.resolve(history()); oldStreak.resolve(streak()); }
  else { oldPage.reject(new ApiError('expired owner', 401, 'http_401')); oldStreak.reject(new Error('old streak')); }
  await pending;
  await flush();
  assert.equal(ui.store().snapshot(), accepted);
  assert.ok(ui.texts().includes('2 occurrences'));
});

for (const outcome of ['success', 'failure']) test(`returning to the original account never accepts its earlier page/streak ${outcome}`, async () => {
  const originalSession = session();
  const oldPage = deferred(), oldStreak = deferred();
  let ownerReads = 0, ownerStreakReads = 0;
  const ui = await screen({ initial: originalSession,
    readHabitHistory: async (s, _id, cursor) => {
      if (s.user.id === 'b') return history({ occurrences: [occurrence({ id: 'owner-b', owner_id: 'b' })] });
      if (cursor) return oldPage.promise;
      return history({ occurrences: [occurrence({ id: ++ownerReads === 1 ? 'old-a' : 'fresh-a' })], next_cursor: 'cursor' });
    },
    readHabitStreak: s => s.user.id === 'b' ? Promise.resolve(streak({ current_streak: 2 }))
      : ++ownerStreakReads === 1 ? oldStreak.promise : Promise.resolve(streak({ current_streak: 5, provisional: true })),
  });
  const pending = ui.button('Load more').props.onPress();
  ui.event(session('b'));
  cleared(ui);
  await flush();
  assert.deepEqual(rowIds(ui), ['owner-b']);
  // Reuse the exact original object: identity checks alone cannot reject these old responses.
  ui.event(originalSession);
  cleared(ui);
  await flush();
  assert.deepEqual(rowIds(ui), ['fresh-a']);
  const accepted = ui.store().snapshot();
  if (outcome === 'success') { oldPage.resolve(history()); oldStreak.resolve(streak()); }
  else { oldPage.reject(new Error('old owner page')); oldStreak.reject(new Error('old owner streak')); }
  await pending;
  await flush();
  assert.equal(ui.store().snapshot(), accepted);
  assert.ok(ui.texts().includes('5 occurrences'));
  assert.ok(ui.texts().includes('Provisional — pending excuse decisions may change this streak.'));
});

for (const outcome of ['success', 'failure']) test(`leaving clears owner history and refocus rejects previous requests with ${outcome}`, async () => {
  const oldPage = deferred(), oldStreak = deferred();
  let reads = 0, streakReads = 0;
  const ui = await screen({ readHabitHistory: async (_s, _id, cursor) => {
    reads++;
    if (cursor) return oldPage.promise;
    return history({ occurrences: [occurrence({ id: reads === 1 ? 'initial' : 'refocused' })], next_cursor: 'cursor' });
  }, readHabitStreak: () => ++streakReads === 1 ? oldStreak.promise : Promise.resolve(streak({ current_streak: 8 })) });
  const capturedMore = ui.button('Load more').props.onPress;
  const refresh = ui.list().onRefresh;
  const pending = capturedMore();
  ui.leave();
  cleared(ui);
  await capturedMore();
  await refresh();
  assert.equal(reads, 2);
  ui.focus();
  await flush();
  const accepted = ui.store().snapshot();
  if (outcome === 'success') { oldPage.resolve(history()); oldStreak.resolve(streak()); }
  else { oldPage.reject(new Error('old page')); oldStreak.reject(new Error('old streak')); }
  await pending;
  await flush();
  assert.equal(ui.store().snapshot(), accepted);
  assert.deepEqual(rowIds(ui), ['refocused']);
  assert.ok(ui.texts().includes('8 occurrences'));
});

test('sign-out clears history before Auth settles and stale reads never repopulate it', async () => {
  const oldPage = deferred(), logout = deferred();
  let reads = 0;
  const ui = await screen({ readHabitHistory: async (_s, _id, cursor) => { reads++; return cursor ? oldPage.promise : history({ next_cursor: 'cursor' }); } });
  const pending = ui.button('Load more').props.onPress();
  ui.auth.signOut = () => logout.promise;
  const signingOut = ui.sessions.signOut();
  cleared(ui);
  oldPage.resolve(history());
  await pending;
  cleared(ui);
  logout.resolve({ error: null });
  await signingOut;
  await ui.list().onRefresh();
  assert.equal(reads, 2);
  cleared(ui);
});

test('token renewal keeps visible data, restarts at page one, and ignores old-token authorization failures', async () => {
  const oldPage = deferred(), oldStreak = deferred(), renewedHistory = deferred(), renewedStreak = deferred();
  const supplied = [], streakSupplied = [];
  const ui = await screen({ readHabitHistory: (s, _id, cursor) => {
    supplied.push({ s, cursor });
    return [Promise.resolve(history({ next_cursor: 'old-cursor' })), oldPage.promise, renewedHistory.promise][supplied.length - 1];
  }, readHabitStreak: s => { streakSupplied.push(s); return s.access_token === 'renewed-token' ? renewedStreak.promise : oldStreak.promise; } });
  const pending = ui.button('Load more').props.onPress();
  const renewed = { ...session(), access_token: 'renewed-token' };
  ui.event(renewed);
  assert.deepEqual(rowIds(ui), ['occurrence-a']);
  assert.equal(ui.list().refreshing, true);
  assert.equal(supplied[2].s, renewed);
  assert.equal(supplied[2].cursor, undefined);
  assert.equal(streakSupplied[1], renewed);
  renewedHistory.resolve(history({ occurrences: [] }));
  renewedStreak.resolve(streak({ current_streak: 0 }));
  await flush();
  const accepted = ui.store().snapshot();
  oldPage.reject(new ApiError('old token', 401, 'http_401'));
  oldStreak.reject(new ApiError('old token', 401, 'http_401'));
  await pending;
  await flush();
  assert.equal(ui.store().snapshot(), accepted);
  assert.equal(ui.sessions.snapshot().session, renewed);
});

test('signed-out sessions never fetch owner data through screen refresh or retry methods', async () => {
  const ui = await screen({ initial: null, readHabitHistory: () => assert.fail('unauthenticated history'), readHabitStreak: () => assert.fail('unauthenticated streak') });
  await ui.list().onRefresh();
  await ui.store().retryHistory();
  await ui.store().retryStreak();
  await ui.store().loadMore();
  cleared(ui);
});

for (const changes of [
  { habit_id: habitB },
  { occurrences: [occurrence({ owner_id: 'b' })] },
  { occurrences: [occurrence({ habit_id: habitB })] },
]) test(`mismatched owner/history response cannot expose foreign data (${JSON.stringify(changes)})`, async () => {
  const ui = await screen({ readHabitHistory: async () => history(changes) });
  assert.deepEqual(rowIds(ui), []);
  assert.ok(ui.button('Retry history'));
  assert.ok(!ui.texts().includes('2026-10-10 · Original name'));
  assert.ok(ui.texts().includes('42 occurrences'));
});

test('foreign continuation rows and a nonadvancing cursor fail without appending rows', async () => {
  for (const page of [history({ occurrences: [occurrence({ owner_id: 'b', id: 'foreign' })] }),
    history({ occurrences: [occurrence({ id: 'older' })], next_cursor: 'cursor' })]) {
    const ui = await screen({ readHabitHistory: async (_s, _id, cursor) => cursor ? page : history({ next_cursor: 'cursor' }) });
    await ui.button('Load more').props.onPress();
    assert.deepEqual(rowIds(ui), ['occurrence-a']);
    assert.ok(ui.button('Retry older history'));
  }
});

for (const changes of [{ habit_id: habitB }, { current_streak: -1 }, { current_streak: 1.5 }, { current_streak: Number.MAX_SAFE_INTEGER + 1 }, { provisional: 'yes' }])
  test(`invalid streak response leaves history intact (${JSON.stringify(changes)})`, async () => {
    const ui = await screen({ readHabitStreak: async () => streak(changes) });
    assert.deepEqual(rowIds(ui), ['occurrence-a']);
    assert.equal(ui.store().snapshot().streak, null);
    assert.ok(ui.button('Retry streak'));
  });

for (const id of [undefined, '', 'not-a-uuid', [habitA, habitB]]) test(`invalid route ID renders a functional return action without API reads (${JSON.stringify(id)})`, async () => {
  // Pass explicit undefined after construction to exercise a missing search param.
  const invalid = id === undefined ? null : id;
  const ui = await screen({ id: invalid, readHabitHistory: () => assert.fail('invalid history ID'), readHabitStreak: () => assert.fail('invalid streak ID') });
  assert.ok(ui.texts().includes('This habit link is invalid.'));
  ui.button('Back to My habits').props.onPress();
  assert.deepEqual(ui.navigations, ['/my-habits']);
});

test('history route is protected by the ready-profile guard and navigation is keyed by account', () => {
  let current;
  const jsx = (type, props, key) => typeof type === 'function' ? type(props) : { type, props, key };
  const Stack = 'Stack';
  const StackComponent = props => ({ type: Stack, props });
  StackComponent.Protected = 'Protected';
  StackComponent.Screen = 'Screen';
  // Preserve the Stack key in this host mock so the actual account key is checked.
  const runtime = { jsx: (type, props, key) => type === StackComponent ? { type: Stack, props, key } : jsx(type, props, key),
    jsxs: (type, props, key) => type === StackComponent ? { type: Stack, props, key } : jsx(type, props, key) };
  const modules = {
    'react/jsx-runtime': runtime,
    'expo-router': { Stack: StackComponent },
    'expo-notifications': { setNotificationHandler() {} },
    '../lib/session': { SessionProvider: 'SessionProvider', useSession: () => current },
    '../lib/session-store': { routeAccess },
    '../lib/auth-link-context': { AuthLinkProvider: p => p.children, useAuthLink: () => ({ phase: 'idle' }) },
  };
  const Layout = compile('app/_layout.tsx', name => modules[name]).default;
  for (const status of ['startup', 'loading', 'signed_out', 'profile_required', 'failure', 'ready']) {
    current = { status, session: status === 'signed_out' ? null : session() };
    const rendered = nodes(Layout());
    const guarded = rendered.filter(node => node.type === 'Protected' && nodes(node.props.children).some(child => child.type === 'Screen' && child.props.name === 'habit-history'));
    assert.equal(guarded.length, 1);
    assert.equal(guarded[0].props.guard, status === 'ready');
    assert.equal(rendered.find(node => node.type === Stack).key, status === 'signed_out' ? 'signed-out' : 'a');
  }
  current = { status: 'ready', session: session('b') };
  assert.equal(nodes(Layout()).find(node => node.type === Stack).key, 'b');
});
