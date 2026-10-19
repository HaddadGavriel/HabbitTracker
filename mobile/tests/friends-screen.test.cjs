const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Run the actual screen, friendship store, and session lifecycle with host
// elements and an isolated two-user API. No device, Auth, or shared data is used.
function compile(path, dependencies) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../${path}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Error, process: { env: {} }, require: dependencies });
  return exports;
}
const cache = {};
const lib = name => cache[name] ??= compile(`lib/${name}.ts`, path => lib(path.slice(2)));
const { FriendsStore } = lib('friends-store');
const { SessionStore, routeAccess } = lib('session-store');
const { ApiError } = lib('api');
const alice = 'aaaaaaaa-1111-4111-8111-111111111111';
const bob = 'bbbbbbbb-2222-4222-8222-222222222222';
const charlie = 'cccccccc-3333-4333-8333-333333333333';
const relationshipId = 'dddddddd-4444-4444-8444-444444444444';
const session = (id = alice) => ({ user: { id }, access_token: `${id}-token` });
const profile = (id = bob, changes = {}) => ({ user_id: id, username: id === alice ? 'alice_1' : id === bob ? 'bob_2' : 'charlie_3',
  display_name: id === alice ? 'Alice' : id === bob ? 'Bob' : 'Charlie', ...changes });
const fullProfile = id => ({ ...profile(id), timezone: 'UTC', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
const relationship = (changes = {}) => ({ id: relationshipId, direction: 'incoming', state: 'pending', profile: profile(),
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', accepted_at: null, ...changes });
const accepted = (changes = {}) => relationship({ state: 'accepted', accepted_at: '2026-10-02T00:00:00Z', ...changes });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const jsx = (type, props, key) => typeof type === 'function' ? type(props) : { type, props, key };
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree && typeof tree === 'object' ? text(tree.props.children) : '';
}
async function screen({ api = {}, initial = session(), readProfile = async s => fullProfile(s.user.id) } = {}) {
  let authEvent, store, focus, cleanup;
  const calls = [];
  const auth = {
    getSession: async () => ({ data: { session: initial } }),
    onAuthStateChange: callback => { authEvent = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: async () => ({ error: null }),
  };
  const sessions = new SessionStore(auth, { readProfile, createProfile: async s => fullProfile(s.user.id) });
  await sessions.start();
  const defaults = {
    listFriends: async () => [], listFriendRequests: async () => ({ incoming: [], outgoing: [] }),
    searchProfile: async () => profile(), sendFriendRequest: async () => relationship({ direction: 'outgoing' }),
    acceptFriendRequest: async () => accepted(), rejectFriendRequest: async () => {}, removeFriend: async () => {},
  };
  const mockedAPI = Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => [name, (...args) => {
    calls.push({ name, args });
    return (api[name] ?? fallback)(...args);
  }]));
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    react: { useCallback: fn => fn, useState: initial => [store ??= initial()], useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    'expo-router': { Link: 'Link', useFocusEffect: callback => { focus = callback; } },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Button: 'Button', KeyboardAvoidingView: 'KeyboardAvoidingView',
      Platform: { OS: 'android' }, RefreshControl: 'RefreshControl', ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: value => value } },
    '../components/form': { Field: 'Field', styles: {} },
    '../lib/api': mockedAPI,
    '../lib/friends-store': { FriendsStore },
    '../lib/session': { useSession: () => ({ ...sessions.snapshot(), store: sessions }) },
  };
  const Component = compile('app/friends.tsx', name => { assert.ok(modules[name], `Unexpected screen dependency: ${name}`); return modules[name]; }).default;
  const render = () => nodes(Component());
  render();
  cleanup = focus();
  await flush();
  const ui = {
    render, calls, sessions, auth, state: () => store.snapshot(),
    texts: () => render().filter(node => node.type === 'Text').map(text),
    text: () => ui.texts().join(' '),
    button: title => render().find(node => node.type === 'Button' && node.props.title === title),
    action: label => render().find(node => node.type === 'Button' && node.props.accessibilityLabel === label),
    spinner: label => render().find(node => node.type === 'ActivityIndicator' && node.props.accessibilityLabel === label),
    field: () => render().find(node => node.type === 'Field'),
    refresh: () => render().find(node => node.type === 'ScrollView').props.refreshControl.props,
    section: title => render().find(node => node.type === 'View' && nodes(node.props.children).some(child =>
      child.type === 'Text' && child.props.accessibilityRole === 'header' && text(child) === title)),
    press: title => {
      const button = ui.button(title);
      assert.ok(button, `Missing button: ${title}`);
      assert.ok(!button.props.disabled, `Disabled button: ${title}`);
      return button.props.onPress();
    },
    search: async query => { ui.field().props.onChangeText(query); await ui.press('Search'); },
    event: value => authEvent(value ? 'SIGNED_IN' : 'SIGNED_OUT', value),
    leave: () => cleanup(),
    focus: () => { cleanup = focus(); },
    remount: () => { cleanup(); store = undefined; render(); cleanup = focus(); },
  };
  return ui;
}

function twoUserAPI() {
  let nextId = 0;
  const profiles = new Map([[alice, profile(alice)], [bob, profile(bob)]]);
  let rows = [];
  const rowFor = (row, actor) => relationship({ id: row.id, direction: row.sender === actor ? 'outgoing' : 'incoming',
    state: row.state, profile: { ...profiles.get(row.sender === actor ? row.recipient : row.sender) },
    accepted_at: row.state === 'accepted' ? '2026-10-02T00:00:00Z' : null });
  const involved = (row, actor) => row.sender === actor || row.recipient === actor;
  const requests = actor => ({ incoming: rows.filter(row => row.state === 'pending' && row.recipient === actor).map(row => rowFor(row, actor)),
    outgoing: rows.filter(row => row.state === 'pending' && row.sender === actor).map(row => rowFor(row, actor)) });
  const api = {
    listFriends: async s => rows.filter(row => row.state === 'accepted' && involved(row, s.user.id)).map(row => rowFor(row, s.user.id)),
    listFriendRequests: async s => requests(s.user.id),
    searchProfile: async (s, username) => {
      const match = [...profiles.values()].find(item => item.user_id !== s.user.id && item.username === username);
      if (!match) throw new ApiError('No other profile has that username', 404, 'profile_not_found');
      return { ...match };
    },
    sendFriendRequest: async (s, recipient) => {
      const previous = rows.find(row => involved(row, s.user.id) && involved(row, recipient));
      if (previous) throw new ApiError('conflict', 409, previous.state === 'accepted' ? 'friendship_exists'
        : previous.sender === s.user.id ? 'outgoing_request_exists' : 'incoming_request_exists');
      const row = { id: `dddddddd-4444-4444-8444-${String(++nextId).padStart(12, '0')}`, sender: s.user.id, recipient, state: 'pending' };
      rows.push(row);
      return rowFor(row, s.user.id);
    },
    acceptFriendRequest: async (s, id) => {
      const row = rows.find(row => row.id === id && row.recipient === s.user.id && row.state === 'pending');
      if (!row) throw new ApiError('already processed', 404, 'friend_request_not_found');
      row.state = 'accepted';
      return rowFor(row, s.user.id);
    },
    rejectFriendRequest: async (s, id) => {
      if (!rows.some(row => row.id === id && row.recipient === s.user.id && row.state === 'pending')) throw new ApiError('already processed', 404, 'friend_request_not_found');
      rows = rows.filter(row => row.id !== id);
    },
    removeFriend: async (s, other) => {
      const row = rows.find(row => row.state === 'accepted' && involved(row, s.user.id) && involved(row, other));
      if (!row) throw new ApiError('already removed', 404, 'friendship_not_found');
      rows = rows.filter(item => item !== row);
    },
  };
  return { api, profiles };
}
const count = (ui, name) => ui.calls.filter(call => call.name === name).length;
const cleared = ui => {
  assert.equal(ui.state().friends.length + ui.state().incoming.length + ui.state().outgoing.length, 0);
  assert.equal(ui.field().props.value, '');
  assert.equal(ui.button('Send request'), undefined);
  assert.equal(ui.button('Confirm removal'), undefined);
  assert.doesNotMatch(ui.text(), /Bob|Charlie|@bob_2|@charlie_3/);
};

test('two users can search, send, accept, remove with confirmation, send again, and reject through actual controls', async () => {
  const server = twoUserAPI();
  const sender = await screen({ api: server.api });
  const recipient = await screen({ api: server.api, initial: session(bob) });
  assert.match(sender.text(), /No friends yet.*No incoming requests.*No outgoing requests/s);
  assert.ok(sender.render().some(node => node.type === 'Link' && node.props.href === '/home'));
  await sender.search('  BOB_2  ');
  assert.equal(sender.calls.find(call => call.name === 'searchProfile').args[1], 'bob_2');
  assert.match(sender.text(), /Bob @bob_2/);
  await sender.press('Send request');
  assert.equal(count(sender, 'sendFriendRequest'), 1);
  assert.equal(count(sender, 'listFriends'), 2);
  assert.equal(count(sender, 'listFriendRequests'), 2);
  assert.match(sender.text(), /awaiting a response/);
  assert.match(text(sender.section('Outgoing requests')), /Bob@bob_2/);
  assert.equal(nodes(sender.section('Outgoing requests')).filter(node => node.type === 'Button').length, 0);
  assert.match(sender.text(), /Outgoing requests cannot be cancelled/);

  recipient.leave();
  recipient.focus();
  await flush();
  assert.match(text(recipient.section('Incoming requests')), /Alice@alice_1/);
  assert.ok(recipient.action('Accept request from @alice_1'));
  await recipient.press('Accept');
  assert.equal(count(recipient, 'acceptFriendRequest'), 1);
  assert.match(text(recipient.section('Accepted friends')), /Alice@alice_1/);
  assert.match(text(recipient.section('Incoming requests')), /No incoming requests/);

  server.profiles.set(bob, profile(bob, { display_name: 'Robert now', username: 'robert_2' }));
  await sender.refresh().onRefresh();
  assert.match(text(sender.section('Accepted friends')), /Robert now@robert_2/);
  assert.doesNotMatch(text(sender.section('Accepted friends')), /Bob|@bob_2/);
  sender.press('Remove friend');
  assert.match(sender.text(), /removes habit sharing in both directions.*Becoming friends again does not restore those sharing grants/);
  assert.equal(count(sender, 'removeFriend'), 0);
  sender.press('Cancel removal');
  assert.equal(sender.button('Confirm removal'), undefined);
  assert.equal(count(sender, 'removeFriend'), 0);
  sender.press('Remove friend');
  await sender.press('Confirm removal');
  assert.equal(count(sender, 'removeFriend'), 1);
  assert.match(text(sender.section('Accepted friends')), /No friends yet/);
  await sender.search('robert_2');
  await sender.press('Send request');
  await recipient.refresh().onRefresh();
  await recipient.press('Reject');
  assert.equal(count(recipient, 'rejectFriendRequest'), 1);
  assert.match(text(recipient.section('Incoming requests')), /No incoming requests/);
  await sender.refresh().onRefresh();
  assert.match(text(sender.section('Outgoing requests')), /No outgoing requests/);
  assert.equal(count(sender, 'sendFriendRequest'), 2);
});

test('relationship and search cards display only public names and usernames, never extra profile or relationship fields', async () => {
  const privateFields = { email: 'secret@example.test', timezone: 'Private/Timezone', auth_metadata: 'secret auth metadata', created_at: 'private profile timestamp' };
  const ui = await screen({ api: {
    listFriends: async () => [accepted({ profile: profile(bob, privateFields), created_at: 'private relationship timestamp' })],
    listFriendRequests: async () => ({ incoming: [relationship({ id: 'incoming', profile: profile(charlie, privateFields) })], outgoing: [] }),
    searchProfile: async () => profile(charlie, privateFields),
  } });
  await ui.search('charlie_3');
  assert.match(ui.text(), /Bob @bob_2/);
  assert.match(ui.text(), /Charlie @charlie_3/);
  assert.doesNotMatch(ui.text(), /secret|Private\/Timezone|timestamp|aaaaaaaa|bbbbbbbb|cccccccc/);
  assert.match(ui.text(), /This person sent you a request/);
  assert.equal(ui.button('Send request'), undefined);
});

test('exact search validates locally, supports keyboard submission, and reports no result without creating a request', async () => {
  const ui = await screen({ api: { searchProfile: async () => { throw new ApiError('No other profile has that username', 404, 'profile_not_found'); } } });
  assert.equal(ui.button('Search').props.disabled, true);
  for (const query of ['bo', 'a'.repeat(31), 'bob*', 'bob name', 'bøb']) {
    await ui.search(query);
    assert.match(ui.text(), /3.?30.*letters.*digits.*underscores/i);
    assert.equal(count(ui, 'searchProfile'), 0);
    assert.equal(ui.button('Send request'), undefined);
  }
  ui.field().props.onChangeText('  BOB_2  ');
  await ui.field().props.onSubmitEditing();
  assert.equal(count(ui, 'searchProfile'), 1);
  assert.equal(ui.calls.find(call => call.name === 'searchProfile').args[1], 'bob_2');
  assert.match(ui.text(), /No other profile has that username/);
  assert.equal(ui.button('Send request'), undefined);
  assert.equal(count(ui, 'sendFriendRequest'), 0);
});

for (const outcome of ['success', 'failure']) test(`new query hides old identity and ignores late search ${outcome}`, async () => {
  const old = deferred(), current = deferred();
  const ui = await screen({ api: { searchProfile: (_s, query) => query === 'bob_2' ? old.promise : current.promise } });
  ui.field().props.onChangeText('bob_2');
  const staleSearch = ui.press('Search');
  assert.ok(ui.spinner('Searching for username'));
  assert.equal(ui.button('Searching…').props.disabled, true);
  ui.field().props.onChangeText('charlie_3');
  const freshSearch = ui.press('Search');
  current.resolve(profile(charlie));
  await freshSearch;
  assert.match(ui.text(), /Charlie @charlie_3/);
  const before = ui.state();
  if (outcome === 'success') old.resolve(profile());
  else old.reject(new ApiError('expired old request', 401, 'http_401'));
  await staleSearch;
  assert.equal(ui.state(), before);
  assert.doesNotMatch(ui.text(), /Bob|@bob_2|expired/);
  ui.field().props.onChangeText('bob_2');
  assert.equal(ui.button('Send request'), undefined);
  assert.doesNotMatch(ui.text(), /Charlie|@charlie_3/);
});

test('initial loading, empty state, failure, retry, and pull refresh render honest state and guard repeated reads', async () => {
  const loading = deferred();
  let reads = 0;
  const ui = await screen({ api: { listFriends: () => ++reads === 1 ? loading.promise : Promise.resolve([]) } });
  assert.ok(ui.spinner('Loading friends'));
  assert.doesNotMatch(ui.text(), /No friends yet|No incoming requests|No outgoing requests/);
  loading.reject(new ApiError('private network detail', null, 'network_error'));
  await flush();
  assert.match(ui.text(), /connection|retry/i);
  assert.doesNotMatch(ui.text(), /private network detail|No friends yet/);
  await ui.press('Retry loading');
  assert.match(ui.text(), /No friends yet.*No incoming requests.*No outgoing requests/s);
  assert.equal(ui.spinner('Loading friends'), undefined);
  assert.equal(reads, 2);

  const refresh = deferred();
  // A separate fixture keeps the initial rows visible during a deferred refresh.
  let refreshReads = 0;
  const retained = await screen({ api: { listFriends: () => ++refreshReads === 1 ? Promise.resolve([accepted()]) : refresh.promise } });
  const captured = retained.refresh().onRefresh;
  const pending = captured();
  await captured();
  assert.equal(refreshReads, 2);
  assert.equal(retained.refresh().refreshing, true);
  assert.match(retained.text(), /Bob @bob_2/);
  assert.equal(retained.button('Remove friend').props.disabled, true);
  refresh.reject(new ApiError('offline', null, 'network_error'));
  await pending;
  assert.match(retained.text(), /Showing your last loaded relationships/);
  assert.match(retained.text(), /Bob @bob_2/);
});

test('Home links to Friends and shared habits; friendship and sharing routes require a ready session', () => {
  let state;
  const Stack = { Protected: 'Protected', Screen: 'Screen' };
  const dependencies = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'expo-router': { Stack, Link: 'Link' },
    'expo-notifications': { setNotificationHandler() {} },
    'react-native': { Button: 'Button', Text: 'Text' },
    '../components/form': { Form: 'Form', styles: {} },
    '../lib/session': { SessionProvider: ({ children }) => children, useSession: () => state },
    '../lib/session-store': { routeAccess },
  };
  const requireModule = name => { assert.ok(dependencies[name], `Unexpected route dependency: ${name}`); return dependencies[name]; };
  const Layout = compile('app/_layout.tsx', requireModule).default;
  const Home = compile('app/home.tsx', requireModule).default;
  for (const status of ['startup', 'loading', 'signed_out', 'profile_required', 'failure', 'ready']) {
    state = { status, session: status === 'signed_out' ? null : session(), profile: status === 'ready' ? fullProfile(alice) : null, store: { signOut() {} } };
    const tree = Layout();
    for (const route of ['friends', 'manage-sharing', 'shared-habits', 'shared-habit']) {
      const groups = nodes(tree).filter(node => node.type === 'Protected'
        && nodes(node.props.children).some(child => child.type === 'Screen' && child.props.name === route));
      assert.equal(groups.length, 1);
      assert.equal(groups[0].props.guard, status === 'ready', `${route} access for ${status}`);
      assert.equal(nodes(tree).filter(node => node.type === 'Screen' && node.props.name === route).length, 1);
    }
  }
  const home = nodes(Home());
  assert.equal(home.filter(node => node.type === 'Link' && node.props.href === '/friends' && text(node) === 'Friends').length, 1);
  assert.equal(home.filter(node => node.type === 'Link' && node.props.href === '/shared-habits' && text(node) === 'Friends’ habits').length, 1);
  const aliceKey = Layout().key;
  state = { ...state, session: session(bob), profile: fullProfile(bob) };
  assert.notEqual(Layout().key, aliceKey, 'Account switches remount the protected stack');
});

test('screen focus fetches both lists again and rejects old search and row controls after leaving', async () => {
  const searching = deferred();
  let reads = 0;
  const ui = await screen({ api: {
    listFriends: async () => [accepted({ profile: profile(++reads === 1 ? bob : charlie) })],
    searchProfile: () => searching.promise,
  } });
  const oldRemove = ui.button('Remove friend').props.onPress;
  ui.field().props.onChangeText('bob_2');
  const oldSearch = ui.press('Search');
  ui.leave();
  cleared(ui);
  ui.focus();
  await flush();
  assert.equal(count(ui, 'listFriends'), 2);
  assert.equal(count(ui, 'listFriendRequests'), 2);
  assert.match(ui.text(), /Charlie @charlie_3/);
  oldRemove();
  assert.equal(ui.button('Confirm removal'), undefined);
  searching.resolve(profile());
  await oldSearch;
  assert.equal(ui.field().props.value, '');
  assert.doesNotMatch(ui.text(), /Bob|@bob_2/);
  assert.equal(ui.button('Send request'), undefined);
});

for (const outcome of ['success', 'failure']) test(`account switch clears identities immediately and ignores old list and search ${outcome}`, async () => {
  const oldRead = deferred(), oldSearch = deferred(), nextProfile = deferred();
  let aliceReads = 0;
  const ui = await screen({
    readProfile: s => s.user.id === charlie ? nextProfile.promise : Promise.resolve(fullProfile(s.user.id)),
    api: {
      listFriends: s => s.user.id === alice ? ++aliceReads === 1 ? Promise.resolve([accepted()]) : oldRead.promise : Promise.resolve([]),
      searchProfile: () => oldSearch.promise,
    },
  });
  ui.press('Remove friend');
  const oldConfirm = ui.button('Confirm removal').props.onPress;
  ui.field().props.onChangeText('bob_2');
  const searching = ui.press('Search');
  const reading = ui.refresh().onRefresh();
  ui.event(session(charlie));
  assert.equal(ui.sessions.snapshot().status, 'loading');
  cleared(ui);
  nextProfile.resolve(fullProfile(charlie));
  await flush();
  assert.equal(ui.sessions.snapshot().status, 'ready');
  const current = ui.state();
  if (outcome === 'success') { oldRead.resolve([accepted()]); oldSearch.resolve(profile()); }
  else { oldRead.reject(new ApiError('old private read failure', 401, 'http_401')); oldSearch.reject(new ApiError('old private search failure', 401, 'http_401')); }
  await Promise.all([reading, searching, oldConfirm()]);
  assert.equal(ui.state(), current);
  cleared(ui);
  assert.equal(count(ui, 'removeFriend'), 0);
  assert.equal(ui.calls.filter(call => call.name === 'listFriends').at(-1).args[0].user.id, charlie);
});

test('sign-out hides account data before storage completes and invalidates captured confirmation and search', async () => {
  const logout = deferred(), searching = deferred();
  const ui = await screen({ api: { listFriends: async () => [accepted()], searchProfile: () => searching.promise } });
  ui.press('Remove friend');
  const confirm = ui.button('Confirm removal').props.onPress;
  ui.field().props.onChangeText('bob_2');
  const oldSearch = ui.press('Search');
  ui.auth.signOut = () => logout.promise;
  const signingOut = ui.sessions.signOut();
  assert.equal(ui.sessions.snapshot().status, 'loading');
  cleared(ui);
  searching.resolve(profile());
  await Promise.all([oldSearch, confirm()]);
  cleared(ui);
  assert.equal(count(ui, 'removeFriend'), 0);
  logout.resolve({ error: null });
  await signingOut;
  assert.equal(ui.sessions.snapshot().status, 'signed_out');
  cleared(ui);
});

for (const outcome of ['success', 'failure']) test(`a late mutation ${outcome} cannot alter a different account's Friends screen`, async () => {
  const mutation = deferred();
  const ui = await screen({ api: {
    listFriends: async s => s.user.id === charlie ? [accepted({ profile: profile(alice) })] : [],
    listFriendRequests: async s => ({ incoming: s.user.id === alice ? [relationship()] : [], outgoing: [] }),
    acceptFriendRequest: () => mutation.promise,
  } });
  const accept = ui.button('Accept').props.onPress;
  const pending = accept();
  ui.event(session(charlie));
  cleared(ui);
  await flush();
  const current = ui.state();
  assert.match(ui.text(), /Alice @alice_1/);
  if (outcome === 'success') mutation.resolve(accepted());
  else mutation.reject(new ApiError('old account failure', null, 'network_error'));
  await Promise.all([pending, accept()]);
  assert.equal(ui.state(), current);
  assert.match(ui.text(), /Alice @alice_1/);
  assert.doesNotMatch(ui.text(), /Bob|@bob_2|old account failure|may have succeeded/);
  assert.equal(count(ui, 'acceptFriendRequest'), 1);
  assert.equal(ui.spinner('Updating friendship'), undefined);
});

test('returning to an account with an outstanding write remains blocked until settlement and a new read', async () => {
  const mutation = deferred(), recovery = deferred();
  let settling = false;
  const ui = await screen({ api: {
    listFriends: s => settling && s.user.id === alice ? recovery.promise : Promise.resolve([]),
    sendFriendRequest: () => mutation.promise,
  } });
  await ui.search('bob_2');
  const sending = ui.press('Send request');
  ui.event(session(charlie));
  await flush();
  ui.event(session());
  await flush();
  await ui.search('bob_2');
  assert.equal(ui.button('Send request').props.disabled, true);
  assert.ok(ui.spinner('Updating friendship'));
  await ui.button('Send request').props.onPress();
  assert.equal(count(ui, 'sendFriendRequest'), 1);
  settling = true;
  mutation.reject(new ApiError('old timeout', null, 'request_timeout'));
  await flush();
  assert.equal(ui.spinner('Updating friendship'), undefined);
  assert.equal(ui.state().refreshRequired, true);
  assert.equal(ui.button('Send request').props.disabled, true);
  recovery.resolve([]);
  await sending;
  assert.equal(ui.state().refreshRequired, false);
  assert.equal(ui.button('Send request').props.disabled, false);
  assert.equal(count(ui, 'sendFriendRequest'), 1);
});

test('a full Friends route remount preserves pending-write protection under the same session owner', async () => {
  const mutation = deferred();
  let committed = false;
  const ui = await screen({ api: {
    sendFriendRequest: () => mutation.promise,
    listFriendRequests: async () => ({ incoming: [], outgoing: committed ? [relationship({ direction: 'outgoing' })] : [] }),
  } });
  await ui.search('bob_2');
  const sending = ui.press('Send request');
  ui.remount();
  await flush();
  assert.equal(ui.field().props.value, '');
  assert.ok(ui.spinner('Updating friendship'));
  await ui.search('bob_2');
  assert.equal(ui.button('Send request').props.disabled, true);
  await ui.button('Send request').props.onPress();
  assert.equal(count(ui, 'sendFriendRequest'), 1);
  committed = true;
  mutation.resolve(relationship({ direction: 'outgoing' }));
  await sending;
  assert.equal(ui.spinner('Updating friendship'), undefined);
  assert.match(text(ui.section('Outgoing requests')), /Bob@bob_2/);
  assert.equal(ui.button('Send request'), undefined);
  assert.equal(count(ui, 'sendFriendRequest'), 1);
});

for (const kind of ['send', 'accept', 'reject', 'remove']) test(`${kind} controls guard repeated taps and refresh both lists after success`, async () => {
  const mutation = deferred();
  let committed = false;
  const method = { send: 'sendFriendRequest', accept: 'acceptFriendRequest', reject: 'rejectFriendRequest', remove: 'removeFriend' }[kind];
  const ui = await screen({ api: {
    listFriends: async () => kind === 'remove' && !committed || kind === 'accept' && committed ? [accepted()] : [],
    listFriendRequests: async () => ({ incoming: ['accept', 'reject'].includes(kind) && !committed ? [relationship()] : [],
      outgoing: kind === 'send' && committed ? [relationship({ direction: 'outgoing' })] : [] }),
    [method]: () => mutation.promise,
  } });
  if (kind === 'send') await ui.search('bob_2');
  if (kind === 'remove') ui.press('Remove friend');
  const title = { send: 'Send request', accept: 'Accept', reject: 'Reject', remove: 'Confirm removal' }[kind];
  const action = ui.button(title).props.onPress;
  const pending = action();
  await action();
  assert.equal(count(ui, method), 1);
  assert.ok(ui.spinner('Updating friendship'));
  for (const button of ui.render().filter(node => node.type === 'Button' && ['Send request', 'Accept', 'Reject', 'Remove friend'].includes(node.props.title))) {
    assert.equal(button.props.disabled, true);
  }
  committed = true;
  mutation.resolve(kind === 'send' ? relationship({ direction: 'outgoing' }) : kind === 'accept' ? accepted() : undefined);
  await pending;
  await action();
  assert.equal(count(ui, method), 1);
  assert.equal(count(ui, 'listFriends'), 2);
  assert.equal(count(ui, 'listFriendRequests'), 2);
  assert.equal(ui.spinner('Updating friendship'), undefined);
  assert.equal(ui.state().refreshRequired, false);
  assert.match(ui.text(), /Friend request sent|Friend request accepted|Friend request rejected|Friend removed/);
  assert.equal(ui.calls.find(call => call.name === method).args[1], ['send', 'remove'].includes(kind) ? bob : relationshipId);
});

test('a committed send with a lost response reconciles before another write and exposes refresh recovery when offline', async () => {
  const mutation = deferred();
  let committed = false, offline = false;
  const ui = await screen({ api: {
    sendFriendRequest: () => mutation.promise,
    listFriends: async () => { if (offline) throw new ApiError('private network detail', null, 'network_error'); return []; },
    listFriendRequests: async () => ({ incoming: [], outgoing: committed ? [relationship({ direction: 'outgoing' })] : [] }),
  } });
  await ui.search('bob_2');
  const send = ui.button('Send request').props.onPress;
  const pending = send();
  committed = true;
  offline = true;
  mutation.reject(new ApiError('response lost', null, 'request_timeout'));
  await pending;
  assert.equal(count(ui, 'sendFriendRequest'), 1);
  assert.equal(count(ui, 'listFriends'), 2);
  assert.equal(count(ui, 'listFriendRequests'), 2);
  assert.match(ui.text(), /may have succeeded/);
  assert.equal(ui.button('Send request').props.disabled, true);
  assert.ok(ui.button('Refresh current server state'));
  await send();
  assert.equal(count(ui, 'sendFriendRequest'), 1);
  offline = false;
  await ui.press('Refresh current server state');
  assert.equal(ui.button('Refresh current server state'), undefined);
  assert.equal(ui.button('Send request'), undefined);
  assert.match(text(ui.section('Outgoing requests')), /Bob@bob_2/);
  assert.match(ui.text(), /Current friendship state refreshed/);
  await send();
  assert.equal(count(ui, 'sendFriendRequest'), 1);
});

test('a read during an outstanding send cannot mix accepted and outgoing cards before reconciliation', async () => {
  const mutation = deferred();
  let serverAccepted = false;
  const ui = await screen({ api: {
    sendFriendRequest: () => mutation.promise,
    listFriends: async () => serverAccepted ? [accepted()] : [],
  } });
  await ui.search('bob_2');
  const sending = ui.press('Send request');
  serverAccepted = true;
  await ui.refresh().onRefresh();
  assert.equal(ui.state().friends.length, 0);
  assert.equal(ui.button('Send request').props.disabled, true);
  mutation.resolve(relationship({ direction: 'outgoing' }));
  await sending;
  assert.match(text(ui.section('Accepted friends')), /Bob@bob_2/);
  assert.match(text(ui.section('Outgoing requests')), /No outgoing requests/);
  assert.match(ui.text(), /You are already friends/);
  assert.equal(count(ui, 'sendFriendRequest'), 1);
});

for (const [kind, code, message, finalKind] of [
  ['send', 'outgoing_request_exists', /outgoing request is already pending/, 'outgoing'],
  ['send', 'incoming_request_exists', /already sent you a request/, 'incoming'],
  ['send', 'friendship_exists', /already friends/, 'friend'],
  ['accept', 'friend_request_not_found', /already been processed/, 'friend'],
  ['reject', 'friend_request_not_found', /already been processed/, null],
  ['remove', 'friendship_not_found', /already been removed/, null],
]) test(`${code} from ${kind} explains conflict and renders current server lists without repeating the write`, async () => {
  let attempted = false;
  const method = { send: 'sendFriendRequest', accept: 'acceptFriendRequest', reject: 'rejectFriendRequest', remove: 'removeFriend' }[kind];
  const ui = await screen({ api: {
    listFriends: async () => attempted ? finalKind === 'friend' ? [accepted()] : [] : kind === 'remove' ? [accepted()] : [],
    listFriendRequests: async () => ({ incoming: attempted ? finalKind === 'incoming' ? [relationship()] : [] : ['accept', 'reject'].includes(kind) ? [relationship()] : [],
      outgoing: attempted && finalKind === 'outgoing' ? [relationship({ direction: 'outgoing' })] : [] }),
    [method]: async () => { attempted = true; throw new ApiError('private database detail', code.endsWith('exists') ? 409 : 404, code); },
  } });
  if (kind === 'send') await ui.search('bob_2');
  if (kind === 'remove') ui.press('Remove friend');
  const action = ui.button({ send: 'Send request', accept: 'Accept', reject: 'Reject', remove: 'Confirm removal' }[kind]).props.onPress;
  await action();
  assert.match(ui.text(), message);
  assert.doesNotMatch(ui.text(), /private database detail/);
  assert.equal(count(ui, 'listFriends'), 2);
  assert.equal(count(ui, 'listFriendRequests'), 2);
  assert.equal(ui.state().friends.length, finalKind === 'friend' ? 1 : 0);
  assert.equal(ui.state().incoming.length, finalKind === 'incoming' ? 1 : 0);
  assert.equal(ui.state().outgoing.length, finalKind === 'outgoing' ? 1 : 0);
  await action();
  assert.equal(count(ui, method), 1);
});

test('cancelled removal handlers cannot confirm or cancel a new confirmation for the same friend', async () => {
  const ui = await screen({ api: { listFriends: async () => [accepted()] } });
  ui.press('Remove friend');
  const oldConfirm = ui.button('Confirm removal').props.onPress;
  const oldCancel = ui.button('Cancel removal').props.onPress;
  oldCancel();
  ui.press('Remove friend');
  const current = ui.state().removeConfirmation;
  oldCancel();
  await oldConfirm();
  assert.equal(ui.state().removeConfirmation, current);
  assert.ok(ui.button('Confirm removal'));
  assert.equal(count(ui, 'removeFriend'), 0);
  await ui.press('Confirm removal');
  assert.equal(count(ui, 'removeFriend'), 1);
});

test('an old recipient failure cannot erase the identity returned for the current username', async () => {
  const mutation = deferred();
  const ui = await screen({ api: {
    searchProfile: async (_s, query) => profile(query === 'bob_2' ? bob : charlie),
    sendFriendRequest: () => mutation.promise,
  } });
  await ui.search('bob_2');
  const sending = ui.press('Send request');
  await ui.search('charlie_3');
  mutation.reject(new ApiError('Bob profile deleted', 404, 'recipient_not_found'));
  await sending;
  assert.equal(ui.field().props.value, 'charlie_3');
  assert.match(ui.text(), /Charlie @charlie_3/);
  assert.equal(ui.state().searchError, null);
  assert.equal(ui.button('Send request').props.accessibilityLabel, 'Send request to @charlie_3');
  assert.equal(ui.button('Send request').props.disabled, false);
  assert.equal(count(ui, 'sendFriendRequest'), 1);
});

test('missing recipient removes the unusable search card and offers a new exact search', async () => {
  const ui = await screen({ api: { sendFriendRequest: async () => { throw new ApiError('deleted', 404, 'recipient_not_found'); } } });
  await ui.search('bob_2');
  await ui.press('Send request');
  assert.match(ui.text(), /no longer available.*current username/);
  assert.equal(ui.button('Send request'), undefined);
  assert.doesNotMatch(ui.text(), /Bob @bob_2/);
  assert.equal(ui.button('Search').props.disabled, false);
  assert.equal(count(ui, 'sendFriendRequest'), 1);
});

test('expired authentication exposes recovery without leaking backend detail or automatically repeating mutations', async () => {
  const ui = await screen({ api: { sendFriendRequest: async () => { throw new ApiError('private token details', 401, 'http_401'); } } });
  await ui.search('bob_2');
  await ui.press('Send request');
  assert.match(ui.text(), /verify your session.*sign out and sign in again/);
  assert.doesNotMatch(ui.text(), /private token details/);
  assert.equal(count(ui, 'sendFriendRequest'), 1);
  assert.equal(ui.spinner('Updating friendship'), undefined);
  assert.equal(ui.sessions.snapshot().status, 'ready', 'The existing session owner remains responsible for auth');
});

test('a missing caller profile clears relationship and search cards and explains onboarding recovery', async () => {
  let missing = false;
  const ui = await screen({ api: {
    listFriends: async () => { if (missing) throw new ApiError('missing', 404, 'profile_not_found'); return [accepted()]; },
    searchProfile: async () => profile(charlie),
    sendFriendRequest: async () => { missing = true; throw new ApiError('missing', 404, 'profile_not_found'); },
  } });
  await ui.search('charlie_3');
  await ui.press('Send request');
  assert.match(ui.text(), /profile is unavailable.*complete onboarding/);
  assert.doesNotMatch(ui.text(), /Bob|Charlie|@bob_2|@charlie_3/);
  assert.equal(ui.button('Remove friend'), undefined);
  assert.equal(ui.button('Send request'), undefined);
  assert.equal(ui.state().hasLoaded, false);
  assert.ok(ui.button('Retry loading'));
});
