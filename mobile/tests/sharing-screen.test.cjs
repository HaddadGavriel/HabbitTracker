const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, SharingStore, ApiError, alice, bob, charlie, habitId, session, profile, friend, habit,
  flush, deferred, setup, count } = require('./sharing-test-support.cjs');

// Actual route, sharing store and session lifecycle. Only native elements, Auth
// and the existing owner API are substituted; no device or shared data is used.
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
async function screen(options = {}) {
  const { api = {} } = options;
  let id = Object.hasOwn(options, 'id') ? options.id : habitId;
  const x = await setup(api);
  let store, focus, cleanup, sharingKey;
  const navigation = [], appStateListeners = new Set();
  // React remounts the keyed Sharing subtree when the route id changes.
  const routeJSX = (type, props, key) => {
    if (typeof type === 'function' && type.name === 'Sharing' && key !== sharingKey) {
      cleanup?.(); store = undefined; focus = undefined; sharingKey = key;
    }
    return jsx(type, props, key);
  };
  const modules = {
    'react/jsx-runtime': { jsx: routeJSX, jsxs: routeJSX, Fragment: 'Fragment' },
    react: { useCallback: fn => fn, useState: initial => [store ??= initial()], useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    'expo-router': { Link: 'Link', useFocusEffect: callback => { focus = callback; }, useLocalSearchParams: () => ({ id }),
      router: { dismissTo: target => navigation.push(target) } },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Button: 'Button', RefreshControl: 'RefreshControl',
      ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: value => value },
      AppState: { addEventListener: (event, callback) => {
        assert.equal(event, 'change'); appStateListeners.add(callback);
        return { remove: () => appStateListeners.delete(callback) };
      } } },
    '../components/form': { Form: 'Form', Message: ({ text }) => jsx('Text', { children: text }), styles: {} },
    '../lib/api': x.api,
    '../lib/sharing-store': { SharingStore },
    '../lib/session': { useSession: () => ({ ...x.sessions.snapshot(), store: x.sessions }) },
  };
  const Component = compile('app/manage-sharing.tsx', name => {
    assert.ok(modules[name], `Unexpected screen dependency: ${name}`); return modules[name];
  }).default;
  const render = () => nodes(Component());
  render(); cleanup = focus?.(); await flush();
  const ui = {
    ...x, render, navigation, appStateListeners, state: () => store?.snapshot(),
    text: () => render().filter(node => node.type === 'Text').map(text).join(' '),
    button: title => render().find(node => node.type === 'Button' && node.props.title === title),
    action: label => render().find(node => node.type === 'Button' && node.props.accessibilityLabel === label),
    spinner: label => render().find(node => node.type === 'ActivityIndicator' && node.props.accessibilityLabel === label),
    refresh: () => render().find(node => node.type === 'ScrollView').props.refreshControl.props,
    press: title => {
      const button = ui.button(title);
      assert.ok(button, `Missing button: ${title}`);
      assert.ok(!button.props.disabled, `Disabled button: ${title}`);
      return button.props.onPress();
    },
    leave: () => { cleanup?.(); cleanup = undefined; },
    focus: () => { cleanup = focus?.(); },
    foreground: value => { for (const callback of appStateListeners) callback(value); },
    changeId: value => { id = value; render(); cleanup = focus?.(); },
  };
  return ui;
}
function noPermissionClaim(ui) {
  assert.doesNotMatch(ui.text(), /No sharing grants\. This habit is private\./);
}
function noPrivateDetails(ui) {
  assert.doesNotMatch(ui.text(), /\bRead\b|Bob|@bob_2/);
  assert.equal(ui.button('Grant access'), undefined);
  assert.equal(ui.button('Revoke access'), undefined);
}

test('loads all owner data before claiming private state and distinguishes accepted friends from grants', async () => {
  const grants = deferred();
  const ui = await screen({ api: {
    listHabitShares: () => grants.promise,
    listFriends: async () => [friend({ profile: profile(bob, { email: 'secret@example.test', auth_metadata: 'private metadata' }) })],
  } });
  assert.ok(ui.spinner('Loading sharing'));
  noPermissionClaim(ui);
  assert.equal(ui.button('Grant access'), undefined);
  grants.resolve([]); await flush();
  assert.equal(ui.spinner('Loading sharing'), undefined);
  assert.match(ui.text(), /private by default.*Accepted friendship alone does not grant permission/s);
  assert.match(ui.text(), /Accepted friends.*Bob @bob_2 Accepted friend No permission to view this habit/s);
  assert.match(ui.text(), /No sharing grants\. This habit is private\./);
  assert.doesNotMatch(ui.text(), /secret@example|private metadata/);
  assert.equal(ui.action('Grant access for @bob_2').props.disabled, false);
  assert.equal(count(ui, 'grantHabitShare'), 0);
  assert.equal(count(ui, 'revokeHabitShare'), 0);
  assert.equal(count(ui, 'readHabit'), 1);
  assert.equal(count(ui, 'listFriends'), 1);
  assert.equal(count(ui, 'listHabitShares'), 1);
});

test('empty accepted-friend list offers friendship navigation without creating any sharing grants', async () => {
  const ui = await screen({ api: { listFriends: async () => [] } });
  assert.match(ui.text(), /No accepted friends\. Add friends before choosing who may view this habit\./);
  assert.match(ui.text(), /No sharing grants\. This habit is private\./);
  assert.equal(ui.button('Grant access'), undefined);
  for (const href of ['/my-habits', '/home', '/friends']) {
    assert.ok(ui.render().some(node => node.type === 'Link' && node.props.href === href));
  }
  assert.equal(count(ui, 'grantHabitShare') + count(ui, 'revokeHabitShare'), 0);
});

for (const kind of ['grant', 'revoke']) test(`${kind} controls show pending state and wait for server reconciliation before claiming success`, async () => {
  const mutation = deferred(), reconciliation = deferred();
  let committed = false;
  const ui = await screen({ api: {
    listHabitShares: () => committed ? reconciliation.promise : Promise.resolve(kind === 'revoke' ? [profile()] : []),
    grantHabitShare: () => mutation.promise, revokeHabitShare: () => mutation.promise,
  } });
  const title = kind === 'grant' ? 'Grant access' : 'Revoke access';
  const captured = ui.button(title).props.onPress;
  const sending = ui.press(title);
  await captured();
  assert.equal(count(ui, kind === 'grant' ? 'grantHabitShare' : 'revokeHabitShare'), 1);
  assert.ok(ui.spinner('Updating sharing'));
  assert.match(ui.text(), kind === 'grant' ? /Granting permission…/ : /Revoking permission…/);
  assert.match(ui.text(), /Showing last loaded permissions\. Current access has not yet been confirmed\./);
  assert.match(ui.text(), kind === 'grant' ? /Last loaded: No permission/ : /Last loaded: Sharing grant enabled/);
  assert.equal(ui.button(title).props.disabled, true);
  noPermissionClaim(ui);
  committed = true; mutation.resolve(kind === 'grant' ? profile() : undefined); await flush();
  assert.equal(ui.spinner('Updating sharing'), undefined);
  assert.ok(ui.spinner('Refreshing sharing'), 'Post-write reads have a visible pending state');
  assert.equal(ui.refresh().refreshing, true);
  assert.equal(ui.button('Refresh current server state').props.disabled, true);
  assert.doesNotMatch(ui.text(), /Current server state confirms/);
  noPermissionClaim(ui);
  reconciliation.resolve(kind === 'grant' ? [profile()] : []); await sending;
  assert.equal(ui.spinner('Refreshing sharing'), undefined);
  assert.match(ui.text(), kind === 'grant' ? /Current server state confirms this friend has a sharing grant\./
    : /Current server state confirms this friend has no sharing grant\./);
  assert.doesNotMatch(ui.text(), /Last loaded:|Current access has not yet been confirmed/);
  const nextTitle = kind === 'grant' ? 'Revoke access' : 'Grant access';
  assert.equal(ui.button(nextTitle).props.disabled, false);
  await captured();
  assert.equal(count(ui, kind === 'grant' ? 'grantHabitShare' : 'revokeHabitShare'), 1);
});

for (const kind of ['grant', 'revoke']) test(`ambiguous ${kind} errors require a working read retry and never replay a write`, async () => {
  let shared = kind === 'revoke', offline = false;
  const write = kind === 'grant' ? 'grantHabitShare' : 'revokeHabitShare';
  const ui = await screen({ api: {
    listHabitShares: async () => { if (offline) throw new ApiError('secret gateway detail', null, 'network_error'); return shared ? [profile()] : []; },
    [write]: async () => { shared = kind === 'grant'; offline = true; throw new ApiError('secret response lost', null, 'request_timeout'); },
  } });
  await ui.press(kind === 'grant' ? 'Grant access' : 'Revoke access');
  assert.match(ui.text(), /Unable to load sharing\. Check your connection and retry\./);
  assert.match(ui.text(), /could not confirm this change\. It may have succeeded/);
  assert.doesNotMatch(ui.text(), /secret|Current server state confirms/);
  noPermissionClaim(ui);
  assert.equal(ui.button(kind === 'grant' ? 'Grant access' : 'Revoke access').props.disabled, true);
  assert.equal(ui.button('Refresh current server state').props.disabled, false);
  assert.equal(ui.button('Retry loading').props.disabled, false);
  await ui.press('Retry loading');
  assert.equal(count(ui, write), 1);
  assert.match(ui.text(), /may have succeeded/);
  offline = false; await ui.press('Refresh current server state');
  assert.equal(count(ui, write), 1);
  assert.equal(ui.button('Refresh current server state'), undefined);
  assert.equal(ui.button('Retry loading'), undefined);
  assert.doesNotMatch(ui.text(), /may have succeeded|Last loaded:/);
  assert.match(ui.text(), kind === 'grant' ? /confirms this friend has a sharing grant/ : /confirms this friend has no sharing grant/);
  assert.equal(ui.button(kind === 'grant' ? 'Revoke access' : 'Grant access').props.disabled, false);
});

test('a rejected change has a meaningful error and another explicit current-row action can retry', async () => {
  let denied = true, shared = false;
  const ui = await screen({ api: {
    listHabitShares: async () => shared ? [profile()] : [],
    grantHabitShare: async () => { if (denied) throw new ApiError('private validation details', 422, 'validation_error'); shared = true; return profile(); },
  } });
  await ui.press('Grant access');
  assert.match(ui.text(), /Unable to change sharing\. Please try again after refreshing\./);
  assert.doesNotMatch(ui.text(), /private validation details|Current server state confirms/);
  assert.equal(ui.button('Grant access').props.disabled, false);
  denied = false; await ui.press('Grant access');
  assert.equal(count(ui, 'grantHabitShare'), 2);
  assert.doesNotMatch(ui.text(), /Unable to change sharing/);
  assert.equal(ui.button('Revoke access').props.disabled, false);
});

test('archived habits explain paused access, allow grant changes and show retained grants after restore', async () => {
  let archived = true, shared = true;
  const ui = await screen({ api: {
    readHabit: async () => habit({ archived_at: archived ? '2026-10-19T12:00:00Z' : null }),
    listHabitShares: async () => shared ? [profile()] : [],
    grantHabitShare: async () => { shared = true; return profile(); },
    revokeHabitShare: async () => { shared = false; },
  } });
  assert.match(ui.text(), /Archiving keeps grants, but recipients cannot view the habit while archived/);
  assert.match(ui.text(), /Archived — recipients cannot currently view this habit/);
  assert.match(ui.text(), /Grant retained — access paused while archived/);
  await ui.press('Revoke access');
  assert.match(ui.text(), /No sharing grants\. This habit is private\./);
  await ui.press('Grant access');
  assert.match(ui.text(), /Grant retained — access paused while archived/);
  archived = false; await ui.press('Refresh sharing');
  assert.match(ui.text(), /Active habit.*Sharing grant enabled/s);
  assert.doesNotMatch(ui.text(), /Grant retained —|Archived —/);
  assert.equal(count(ui, 'grantHabitShare'), 1);
  assert.equal(count(ui, 'revokeHabitShare'), 1);
});

test('foreground refresh observes friendship removal, and re-friending never restores a grant or stale handler', async () => {
  let friends = [friend()], shared = true;
  const ui = await screen({ api: {
    listFriends: async () => friends,
    listHabitShares: async () => shared ? [profile()] : [],
    grantHabitShare: async () => { shared = true; return profile(); },
  } });
  const oldRevoke = ui.button('Revoke access').props.onPress;
  friends = []; shared = false; ui.foreground('active'); await flush();
  assert.match(ui.text(), /No accepted friends/);
  assert.match(ui.text(), /Removing a friendship deletes its grants\. Becoming friends again does not restore them/);
  assert.equal(ui.button('Revoke access'), undefined);
  friends = [friend({ id: 'new-friendship' })]; await ui.refresh().onRefresh();
  assert.match(ui.text(), /Accepted friend No permission to view this habit/);
  await oldRevoke();
  assert.equal(count(ui, 'grantHabitShare') + count(ui, 'revokeHabitShare'), 0);
  await ui.press('Grant access');
  assert.equal(count(ui, 'grantHabitShare'), 1);
  assert.match(ui.text(), /Sharing grant enabled/);
});

test('friendship_required removes a stale friend immediately and explains explicit sharing after replacement', async () => {
  const replacement = deferred();
  let attempted = false;
  const ui = await screen({ api: {
    listFriends: () => attempted ? replacement.promise : Promise.resolve([friend()]),
    grantHabitShare: async () => { attempted = true; throw new ApiError('private relationship text', 409, 'friendship_required'); },
  } });
  const staleGrant = ui.button('Grant access').props.onPress;
  const sending = ui.press('Grant access'); await flush();
  assert.match(ui.text(), /change was rejected because this person was no longer an accepted friend/);
  assert.doesNotMatch(ui.text(), /private relationship text|@bob_2/);
  assert.equal(ui.button('Grant access'), undefined);
  noPermissionClaim(ui);
  assert.doesNotMatch(ui.text(), /No accepted friends\./);
  replacement.resolve([friend({ id: 'replacement' })]); await sending;
  assert.match(ui.text(), /Accepted friend No permission to view this habit/);
  await staleGrant();
  assert.equal(count(ui, 'grantHabitShare'), 1);
});

test('load failures show a safe message and retry control that actually loads server state', async () => {
  let failing = true;
  const ui = await screen({ api: {
    listHabitShares: async () => { if (failing) throw new ApiError('private backend text', null, 'network_error'); return []; },
  } });
  assert.match(ui.text(), /Unable to load sharing\. Check your connection and retry/);
  assert.doesNotMatch(ui.text(), /private backend text/);
  noPermissionClaim(ui);
  noPrivateDetails(ui);
  failing = false; await ui.press('Retry loading');
  assert.equal(count(ui, 'listHabitShares'), 2);
  assert.match(ui.text(), /No sharing grants\. This habit is private\./);
  assert.equal(ui.button('Grant access').props.disabled, false);
});

for (const status of [403, 404]) test(`${status} inaccessible owner habit clears details and offers a safe return path`, async () => {
  let inaccessible = false;
  const ui = await screen({ api: {
    listHabitShares: async () => { if (inaccessible) throw new ApiError('private resource detail', status, status === 404 ? 'habit_not_found' : 'forbidden'); return [profile()]; },
  } });
  const staleRevoke = ui.button('Revoke access').props.onPress;
  inaccessible = true; await ui.press('Refresh sharing');
  noPrivateDetails(ui);
  assert.match(ui.text(), /This habit was not found or is no longer available to your account/);
  assert.doesNotMatch(ui.text(), /private resource detail|Showing last loaded permissions/);
  assert.equal(ui.button('Refresh sharing'), undefined);
  await staleRevoke();
  assert.equal(count(ui, 'revokeHabitShare'), 0);
  await ui.press('Back to My habits');
  assert.deepEqual(ui.navigation, ['/my-habits']);
});

test('focus, explicit refresh and foreground read again; leaving removes the foreground listener and clears private data', async () => {
  const ui = await screen();
  assert.equal(ui.appStateListeners.size, 1);
  ui.foreground('background'); await flush();
  assert.equal(count(ui, 'listHabitShares'), 1);
  ui.foreground('active'); await flush();
  assert.equal(count(ui, 'listHabitShares'), 2);
  await ui.refresh().onRefresh();
  assert.equal(count(ui, 'listHabitShares'), 3);
  const staleGrant = ui.button('Grant access').props.onPress;
  ui.leave();
  assert.equal(ui.appStateListeners.size, 0);
  noPrivateDetails(ui);
  ui.foreground('active'); await staleGrant();
  assert.equal(count(ui, 'listHabitShares'), 3);
  assert.equal(count(ui, 'grantHabitShare'), 0);
  ui.focus(); await flush();
  assert.equal(ui.appStateListeners.size, 1);
  assert.equal(count(ui, 'listHabitShares'), 4);
  await staleGrant();
  assert.equal(count(ui, 'grantHabitShare'), 0);
});

for (const id of [undefined, 'bad-id', [habitId], `${habitId}/shares`]) test(`invalid sharing link ${JSON.stringify(id)} makes no API requests and offers safe navigation`, async () => {
  const ui = await screen({ id });
  assert.match(ui.text(), /This habit link is invalid/);
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.appStateListeners.size, 0);
  await ui.press('Back to My habits');
  assert.deepEqual(ui.navigation, ['/my-habits']);
});

test('uppercase UUID links normalize the id before loading permissions', async () => {
  const ui = await screen({ id: habitId.toUpperCase() });
  assert.equal(ui.calls.find(call => call.name === 'readHabit').args[1], habitId);
  assert.equal(ui.calls.find(call => call.name === 'listHabitShares').args[1], habitId);
  assert.equal(ui.button('Grant access').props.disabled, false);
});

for (const outcome of ['success', 'failure']) test(`account changes clear visible rows and reject stale ${outcome} responses and captured actions`, async () => {
  const old = deferred();
  let waiting = false;
  const ui = await screen({ api: {
    listFriends: async s => s.user.id === alice ? [friend()] : [friend({ profile: profile(alice) })],
    listHabitShares: s => waiting && s.user.id === alice ? old.promise : Promise.resolve([]),
  } });
  const captured = ui.button('Grant access').props.onPress;
  waiting = true; const refreshing = ui.refresh().onRefresh();
  ui.event(session(charlie));
  noPrivateDetails(ui);
  await flush();
  assert.match(ui.text(), /Alice @alice_1/);
  const latest = ui.text();
  await captured();
  if (outcome === 'success') old.resolve([profile()]);
  else old.reject(new ApiError('old private error', 401, 'http_401'));
  await refreshing;
  assert.equal(ui.text(), latest);
  assert.equal(count(ui, 'grantHabitShare'), 0);
  assert.doesNotMatch(ui.text(), /@bob_2|old private error|verify your session/);
});

for (const outcome of ['success', 'failure']) test(`route-id changes reject stale ${outcome} responses and handlers from the previous habit`, async () => {
  const nextId = 'eeeeeeee-5555-4555-8555-555555555555', old = deferred();
  let waiting = false;
  const ui = await screen({ api: {
    readHabit: async (s, id) => habit({ id, owner_id: s.user.id, name: id === habitId ? 'Read' : 'Walk' }),
    listHabitShares: (_s, id) => waiting && id === habitId ? old.promise : Promise.resolve([]),
  } });
  const captured = ui.button('Grant access').props.onPress;
  waiting = true; const refreshing = ui.refresh().onRefresh();
  ui.changeId(nextId); await flush();
  assert.equal(ui.appStateListeners.size, 1);
  assert.match(ui.text(), /Walk/);
  assert.doesNotMatch(ui.text(), /\bRead\b/);
  const latest = ui.text();
  await captured();
  if (outcome === 'success') old.resolve([profile()]);
  else old.reject(new ApiError('old route error', 404, 'habit_not_found'));
  await refreshing;
  assert.equal(ui.text(), latest);
  assert.equal(count(ui, 'grantHabitShare'), 0);
  assert.equal(ui.calls.filter(call => call.name === 'listHabitShares').at(-1).args[1], nextId);
});
