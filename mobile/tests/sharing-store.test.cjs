const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SharingStore, ApiError, alice, bob, charlie, habitId, session, profile, friend, habit,
  flush, deferred, setup, started, count, cleared } = require('./sharing-test-support.cjs');

test('private by default: accepted friends are not grants and all three reads must finish', async () => {
  const shares = deferred();
  const x = await setup({ listHabitShares: () => shares.promise });
  x.store.start();
  await flush();
  assert.equal(x.store.snapshot().hasLoaded, false);
  assert.equal(x.store.canMutate(), false);
  shares.resolve([]);
  await flush();
  assert.equal(x.store.snapshot().friends.length, 1);
  assert.equal(x.store.isShared(bob), false);
  assert.equal(x.store.canMutate(), true);
  assert.equal(count(x, 'grantHabitShare'), 0);
  assert.equal(count(x, 'revokeHabitShare'), 0);
});

for (const kind of ['grant', 'revoke']) test(`${kind} waits for confirmed post-write reads and guards repeated or stale row actions`, async () => {
  const mutation = deferred(), reconciliation = deferred();
  let committed = false;
  const x = await started({
    listHabitShares: () => committed ? reconciliation.promise : Promise.resolve(kind === 'revoke' ? [profile()] : []),
    grantHabitShare: () => mutation.promise, revokeHabitShare: () => mutation.promise,
  });
  const row = x.store.snapshot().friends[0];
  const pending = x.store[kind](row);
  await x.store[kind](row);
  assert.equal(count(x, kind === 'grant' ? 'grantHabitShare' : 'revokeHabitShare'), 1);
  assert.equal(x.store.snapshot().pendingAction.kind, kind);
  assert.equal(x.store.isShared(bob), kind === 'revoke', 'No optimistic grant or revoke');
  assert.equal(x.store.snapshot().notice, null);
  committed = true;
  mutation.resolve(kind === 'grant' ? profile() : undefined);
  await flush();
  assert.equal(x.store.canMutate(), false);
  assert.equal(x.store.snapshot().refreshRequired, true);
  assert.equal(x.store.snapshot().notice, null, 'Acknowledgement alone does not claim current access');
  reconciliation.resolve(kind === 'grant' ? [profile()] : []);
  await pending;
  assert.equal(x.store.isShared(bob), kind === 'grant');
  assert.match(x.store.snapshot().notice, /Current server state confirms/);
  assert.equal(x.store.canMutate(), true);
  await x.store[kind === 'grant' ? 'revoke' : 'grant'](row);
  assert.equal(count(x, kind === 'grant' ? 'revokeHabitShare' : 'grantHabitShare'), 0);
  const call = x.calls.find(call => call.name === (kind === 'grant' ? 'grantHabitShare' : 'revokeHabitShare'));
  assert.equal(call.args[1], habitId);
  assert.equal(call.args[2], bob);
});

test('archived owner habits retain grants, allow explicit changes, and preserve retained grants after restore', async () => {
  let archived = false, shared = true;
  const x = await started({
    readHabit: async () => habit({ archived_at: archived ? '2026-10-19T12:00:00Z' : null }),
    listHabitShares: async () => shared ? [profile()] : [],
    grantHabitShare: async () => { shared = true; return profile(); },
    revokeHabitShare: async () => { shared = false; },
  });
  archived = true;
  await x.store.refresh();
  assert.equal(x.store.isShared(bob), true);
  assert.equal(x.store.canMutate(), true);
  await x.store.revoke(x.store.snapshot().friends[0]);
  assert.equal(x.store.isShared(bob), false);
  await x.store.grant(x.store.snapshot().friends[0]);
  assert.equal(x.store.isShared(bob), true);
  archived = false;
  await x.store.refresh();
  assert.equal(x.store.snapshot().habit.archived_at, null);
  assert.equal(x.store.isShared(bob), true);
  assert.equal(count(x, 'grantHabitShare'), 1);
});

for (const kind of ['grant', 'revoke']) test(`lost ${kind} response reconciles without replay, and failed reconciliation offers a working read retry`, async () => {
  let shared = kind === 'revoke', offline = false;
  const x = await started({
    listHabitShares: async () => { if (offline) throw new ApiError('private network detail', null, 'network_error'); return shared ? [profile()] : []; },
    [kind === 'grant' ? 'grantHabitShare' : 'revokeHabitShare']: async () => {
      shared = kind === 'grant'; offline = true; throw new ApiError('response lost', null, 'request_timeout');
    },
  });
  const row = x.store.snapshot().friends[0];
  await x.store[kind](row);
  assert.equal(x.store.canMutate(), false);
  assert.equal(x.store.snapshot().refreshRequired, true);
  assert.match(x.store.snapshot().actionError, /may have succeeded/);
  assert.match(x.store.snapshot().error, /connection/);
  await x.store[kind](row);
  assert.equal(count(x, kind === 'grant' ? 'grantHabitShare' : 'revokeHabitShare'), 1);
  offline = false;
  await x.store.refresh();
  assert.equal(x.store.snapshot().refreshRequired, false);
  assert.equal(x.store.snapshot().actionError, null);
  assert.equal(x.store.isShared(bob), kind === 'grant');
  assert.match(x.store.snapshot().notice, /Current server state confirms/);
});

test('friendship removal and replacement never restore grants or make old callbacks valid', async () => {
  let friends = [friend()], shared = true;
  const x = await started({ listFriends: async () => friends, listHabitShares: async () => shared ? [profile()] : [] });
  const old = x.store.snapshot().friends[0];
  friends = []; shared = false;
  await x.store.refresh();
  assert.equal(x.store.snapshot().friends.length, 0);
  assert.equal(x.store.isShared(bob), false);
  friends = [friend({ id: 'replacement-friendship' })];
  await x.store.refresh();
  await x.store.grant(old);
  await x.store.revoke(old);
  assert.equal(count(x, 'grantHabitShare'), 0);
  assert.equal(count(x, 'revokeHabitShare'), 0);
  assert.equal(x.store.isShared(bob), false);
  await x.store.grant(x.store.snapshot().friends[0]);
  assert.equal(count(x, 'grantHabitShare'), 1, 'New grants require a new explicit action');
});

test('friendship_required removes the stale row immediately and refreshes without re-granting after replacement', async () => {
  const friends = deferred();
  let attempted = false;
  const x = await started({
    listFriends: () => attempted ? friends.promise : Promise.resolve([friend()]),
    grantHabitShare: async () => { attempted = true; throw new ApiError('private relationship detail', 409, 'friendship_required'); },
  });
  const old = x.store.snapshot().friends[0];
  const pending = x.store.grant(old);
  await flush();
  assert.equal(x.store.snapshot().friends.length, 0);
  assert.match(x.store.snapshot().actionError, /no longer an accepted friend/);
  friends.resolve([friend({ id: 'new-friendship' })]);
  await pending;
  assert.equal(x.store.isShared(bob), false);
  assert.equal(x.store.canMutate(), true);
  await x.store.grant(old);
  assert.equal(count(x, 'grantHabitShare'), 1);
  assert.doesNotMatch(x.store.snapshot().actionError, /private relationship detail/);
});

test('inconsistent friendship and grant reads block actions until a consistent fresh snapshot', async () => {
  let mismatch = true;
  const x = await started({ listFriends: async () => mismatch ? [] : [friend()], listHabitShares: async () => [profile()] });
  assert.equal(x.store.snapshot().hasLoaded, false);
  assert.equal(x.store.canMutate(), false);
  assert.match(x.store.snapshot().error, /Friendships changed/);
  mismatch = false;
  await x.store.refresh();
  assert.equal(x.store.isShared(bob), true);
  assert.equal(x.store.canMutate(), true);
});

for (const [code, status, message] of [
  ['habit_not_found', 404, /no longer available/], ['profile_not_found', 404, /onboarding/], ['http_401', 401, /verify your session/],
]) test(`${code} clears loaded owner details and gives safe recovery`, async () => {
  let missing = false;
  const x = await started({ listHabitShares: async () => { if (missing) throw new ApiError('private details', status, code); return [profile()]; } });
  const row = x.store.snapshot().friends[0];
  missing = true;
  await x.store.refresh();
  cleared(x.store);
  assert.match(x.store.snapshot().error, message);
  assert.equal(x.store.snapshot().unavailable, code === 'habit_not_found');
  await x.store.revoke(row);
  assert.equal(count(x, 'revokeHabitShare'), 0);
  missing = false;
  await x.store.refresh();
  assert.equal(x.store.canMutate(), true);
});

for (const outcome of ['success', 'failure']) test(`navigation and account changes reject stale read ${outcome}`, async () => {
  const old = deferred();
  let calls = 0;
  const x = await setup({ listHabitShares: () => ++calls === 1 ? old.promise : Promise.resolve([]) });
  x.store.start();
  x.store.stop();
  cleared(x.store);
  x.event(session(charlie));
  await flush();
  x.store.start();
  await flush();
  const state = x.store.snapshot();
  if (outcome === 'success') old.resolve([profile()]);
  else old.reject(new ApiError('old private failure', 401, 'http_401'));
  await flush();
  assert.equal(x.store.snapshot(), state);
  assert.equal(state.habit.owner_id, charlie);
});

test('token replacement invalidates old reads and captured rows, and reconciles a pending write using the new token', async () => {
  const mutation = deferred();
  const x = await started({ grantHabitShare: () => mutation.promise });
  const oldRow = x.store.snapshot().friends[0];
  const pending = x.store.grant(oldRow);
  x.event(session(alice, 'new-token'));
  await flush();
  assert.equal(x.store.snapshot().hasLoaded, false);
  assert.equal(x.store.canMutate(), false);
  mutation.resolve(profile());
  await pending;
  assert.equal(x.store.snapshot().hasLoaded, true);
  assert.equal(x.calls.filter(call => call.name === 'listHabitShares').at(-1).args[0].access_token, 'new-token');
  await x.store.grant(oldRow);
  assert.equal(count(x, 'grantHabitShare'), 1);
});

test('outstanding mutation guard survives full route remount and returning to the same account', async () => {
  const mutation = deferred(), reconciliation = deferred();
  let settled = false;
  const x = await started({
    listHabitShares: s => settled && s.user.id === alice ? reconciliation.promise : Promise.resolve([]),
    grantHabitShare: () => mutation.promise,
  });
  const sending = x.store.grant(x.store.snapshot().friends[0]);
  x.store.stop();
  const remount = SharingStore.forSession(x.sessions, x.api, habitId);
  assert.equal(remount, x.store);
  remount.start();
  await flush();
  assert.equal(remount.snapshot().pendingAction.kind, 'grant');
  assert.equal(remount.canMutate(), false);
  x.event(session(charlie));
  await flush();
  assert.equal(remount.snapshot().pendingAction, null);
  assert.equal(remount.snapshot().habit.owner_id, charlie);
  x.event(session());
  await flush();
  assert.equal(remount.snapshot().pendingAction.kind, 'grant');
  settled = true;
  mutation.reject(new ApiError('old timeout', null, 'request_timeout'));
  await flush();
  assert.equal(remount.snapshot().refreshRequired, true);
  assert.equal(remount.canMutate(), false);
  reconciliation.resolve([profile()]);
  await sending;
  assert.equal(remount.isShared(bob), true);
  assert.equal(remount.canMutate(), true);
  assert.equal(count(x, 'grantHabitShare'), 1);
});

test('read dispatched while a write is pending cannot establish the write outcome', async () => {
  const mutation = deferred(), midRead = deferred(), finalRead = deferred();
  let reads = 0;
  const x = await started({
    listHabitShares: () => ++reads === 1 ? Promise.resolve([]) : reads === 2 ? midRead.promise : finalRead.promise,
    grantHabitShare: () => mutation.promise,
  });
  const sending = x.store.grant(x.store.snapshot().friends[0]);
  const reading = x.store.reload();
  mutation.resolve(profile());
  await flush();
  midRead.resolve([profile()]);
  await reading;
  assert.equal(x.store.isShared(bob), false);
  assert.equal(x.store.snapshot().refreshRequired, true);
  finalRead.resolve([]);
  await sending;
  assert.equal(x.store.isShared(bob), false);
  assert.match(x.store.snapshot().notice, /has no sharing grant/);
});

test('definite errors are safe, reconciled, and retry only on another explicit current-row action', async () => {
  let failure = true, shared = false;
  const x = await started({
    listHabitShares: async () => shared ? [profile()] : [],
    grantHabitShare: async () => { if (failure) throw new ApiError('private backend text', 422, 'validation_error'); shared = true; return profile(); },
  });
  await x.store.grant(x.store.snapshot().friends[0]);
  assert.equal(x.store.canMutate(), true);
  assert.match(x.store.snapshot().actionError, /Unable to change sharing/);
  assert.doesNotMatch(x.store.snapshot().actionError, /private backend text/);
  failure = false;
  await x.store.grant(x.store.snapshot().friends[0]);
  assert.equal(x.store.isShared(bob), true);
  assert.equal(x.store.snapshot().actionError, null);
  assert.equal(count(x, 'grantHabitShare'), 2);
});
