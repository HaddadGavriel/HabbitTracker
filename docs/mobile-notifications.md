# Account-aware notifications

Settings → **Notifications** owns the enable/disable controls and status.
Diagnostics embeds the same controls and uses the same application service; it
only listens for infrastructure-test receipts. Merely opening either screen does
not prompt for permission. An explicit **Enable notifications** action records
opt-in for the current account on this installation. Logout/account switching and
permission denial clear that opt-in. A normal restart of the same signed-in
account retains it. The [Android local-reminder service](android-local-reminders.md)
has a separate **Enable habit reminders** installation preference and integrates
authenticated loads, foreground refresh, and relevant successful mutations. It schedules independently of remote
friend-reminder delivery. Habit saves and tracking remain available when notification
permission is denied or scheduling fails; Settings provides status and retry/resync.

## Setup and release order

Use the [Android Firebase/EAS setup](android-push-setup.md), a configured EAS
project ID, and a physical development or preview build. This repository remains
on SDK 57. `expo-crypto` is now a direct dependency for registration UUIDs; rebuild
the native app after installing dependencies. App configuration sets the FCM
default channel to `friend-reminders`.

For a separately authorized release, apply unapplied migrations in filename order
through the latest committed migration, including device registration cleanup and
local-reminder eligibility, deploy the matching
backend, then distribute the new native build. Do not edit/reapply old migrations.
The old three-argument registration RPC remains compatible. Old clients omit the
intent ID and receive a server-generated one, but do not gain lifecycle cleanup;
retire those clients. No shared migration, deployment, or real push is performed
by the automated verification for this change.

For an upgrade from the diagnostics-only client, **enable once while signed in
to the original account** to replace its earlier registration with a journaled
identity. Then Disable/sign-out can remove it. The earlier client never stored
cleanup identities. Likewise, clearing app data or reinstalling can lose the
journal. Do not describe those earlier registrations as remotely removed. Block
notifications in OS settings immediately if needed; re-enable then disable with
the original account/token while available, or have an authorized operator remove
or investigate the orphaned registration. Do not copy tokens into bug reports.

## Channels, permissions, and transitions

The remote service creates `friend-reminders` and `infrastructure-tests` before requesting
Android permission or obtaining a token. Backend reminder sends explicitly use
`friend-reminders`; infrastructure sends use `infrastructure-tests`. Users control
channel settings; creating a channel does not override their blocked importance.
App permission denial or a blocked friend-reminder channel stops registration,
turns off opt-in, and attempts cleanup. Foreground checks never prompt. Settings
explains denial and opens Android's app notification settings, falling back to
app settings when that intent is unsupported. After allowing notifications, tap
Enable again. iOS authorized, provisional, and ephemeral states are supported for remote notifications.
Android local reminders use a separate **Habit reminders** (`local-habit-reminders`)
channel. Its blocked state and exact-alarm limitations appear in local scheduling
status. Foreground/resync observes OS changes; allowing a channel never replays
missed reminder times. Local scheduling is unavailable in Expo Go, web and iOS.

The application has one `NotificationService`, wired directly into `SessionStore`
and native listeners. It reconciles restored/auth-refreshed sessions, foreground
transitions, and native token changes. A native token event triggers a fresh
**Expo** token lookup; its FCM/APNs token is never sent as an Expo token. Work is
serialized and concurrent refresh requests share work. Foreground/session renewal
rotates the registration identity. Token renewal removes the old installation
registration before registering the new token; other installations are untouched.

Auth changes/disable invalidate async work immediately. A token lookup resolving
for an old account cannot start a POST. If a POST already began, cleanup waits for
its bounded result and cancels its journaled intent. Session callbacks do not await
notification network work. Sign-out requests cleanup before discarding the active
session, then still attempts local Auth sign-out even if notification cleanup
failed. A concurrent new account prevents a queued old Auth sign-out from starting.

## Registration and cancellation protocol

Both endpoints require a valid Supabase bearer session. FastAPI alone supplies
`p_user` from the verified session; no client owner ID is accepted for unregister.
The device tables, intent ledger, and RPCs remain inaccessible to client roles.
The service role executes security-definer RPCs with fixed empty search paths.

```http
POST /devices/register
{"expo_push_token":"ExpoPushToken[example]","platform":"android","registration_id":"<UUID>"}
```

Success returns `registered`, `platform`, `updated_at`, and `registration_id`.
The app generates and durably journals the UUID **before** POST; a lost response
therefore cannot lose the only cleanup handle. Registration maintains the existing
global token uniqueness and strictly increasing `updated_at`. A refresh or
transfer gets a different identity, including a transfer back to the same user.

```http
POST /devices/unregister
{"registration_id":"<UUID>"}
```

Success returns `{"removed":true}` if that owner's exact registration was deleted,
or `{"removed":false}` if absent/superseded. Both confirm that the intent is fenced;
neither asserts that unrelated/newer registrations were removed. A cancellation
also inserts a credential-free tombstone, under the same transaction lock used by
registration. A delayed register with that owner/UUID cannot recreate the row.
Registration replay returns its original timestamp only while that exact identity
still owns a row; otherwise it returns HTTP 409 `registration_superseded`.
The ledger retains owner/UUID pairs until account deletion: do not prune these
fences while delayed/replayed requests could exist. It contains no push tokens,
bearers, or refresh credentials. Existing reminder reservation/cooldown and
invalid-token version checks are unchanged.

## Offline and failed cleanup

A timeout, 401, malformed result, storage failure, or network failure is never
reported as remote removal. Native/network operations are bounded (30 seconds per
operation). Only owner/intent IDs and opt-in are persisted in AsyncStorage. No old
bearer, refresh credential, or push token is saved there for cleanup. The old
session is used only during its current transition; retry after restart/sign-in
uses the newly authenticated session.

A persistent banner remains visible, including on sign-in, whenever known cleanup
is unconfirmed. **Retry notification cleanup**, returning to foreground, or signing
back into that original account retries cancellation. While any previous account
has unresolved cleanup, enabling on a different account is blocked. This is
intentional: an unconfirmed old POST must be fenced before a new account can
register. If that account is unavailable, the immediate protection is to disable
notifications in OS settings; account recovery/operator cleanup is required for
remote removal. Multiple previous owners must each authenticate for their own
cleanup. Clearing local app storage is not a cleanup solution.

The app dismisses presented notifications, clears the badge, and clears the last
notification response on disable/account transitions and cleanup retries where
supported. Failure to clear is shown separately. Foreground presentation is
suppressed unless the active account has a confirmed enabled registration.

## Delivery boundary and privacy

Unregister does **not** revoke an already committed reminder reservation, recall
an Expo/FCM/APNs send, or guarantee no notification arrives after logout. A push
already authorized for the former account can appear after switching, even after
successful cancellation and tray dismissal. The backend therefore enforces generic
outgoing content: **Habit Tracker — Open Habit Tracker to check your updates.**
The payload includes only `type: habit_reminder`, with no friend/habit names,
account IDs, habit/occurrence IDs, explanations, or navigation target. Sanitization
is at dispatch, so even a previously stored detailed reservation cannot disclose
its contents through this backend. An already transmitted older detailed push
cannot be retroactively changed. Android channels additionally request private
lock-screen visibility. Tokens and provider errors are never ordinary UI content.

## Reminder taps

The [two-device reminder walkthrough](mobile-reminders-walkthrough.md) covers
sending and foreground/background/cold-start taps. Generic current pushes fetch
current authorized Today before opening it. Legacy structured payloads validate
UUIDs and fetch current owned habit/Today/history data; deleted or wrong-account
references fall back safely. The tap handler waits for authentication/onboarding
and Router readiness, binds pending work to an account, and persistently deduplicates
handled taps. It never follows payload URLs. Infrastructure taps remain separate
and never trigger a send. Generic push content and registration cleanup behavior
are unchanged. Local reminder taps enter the same authenticated, validated navigation
flow after checking native owner metadata and the current account; they fetch current
Today and never follow a payload URL.

## Offline local reminders

This device can continue its persisted schedule without JavaScript or connectivity.
A completion, excuse, edit or archive on another device cannot instantly cancel
notifications on this offline device. Foreground activity and retry/resync fetch
current server eligibility when connectivity permits. Reconciliation skips elapsed
times; it cannot retract a notification the user already saw. See the [local engine
guide](android-local-reminders.md) and [Android device checklist](android-local-reminders-verification.md).

## Verification

Run `npm test` and `npm run typecheck` in `mobile/`, and `python -m pytest -q` in
`backend/` with `TEST_DATABASE_URL` targeting only disposable PostgreSQL. API/native
adapters are mocked; no automated test sends real notifications. Tests cover
registration/transfer/replay, owner-scoped stale cancellation, delayed POST fencing,
renewal, denial/channel blocking, logout failures, account switching, restored
journals, credential-free recovery, permissions, and retained reminder semantics.

After an authorized release, manually verify the native device UI: enable/deny,
permanently deny, block only the reminders channel, allow in Android settings,
foreground/background, disable, sign out offline, sign in as a different account,
then return to the original account to finish cleanup. Inspect the tray and banner.
Remote delivery/FCM credentials and OS behavior still require that physical-device
check; use the diagnostics send only when real notification delivery is intended.

## Documentation checked

Reviewed on 2026-10-20 against the installed SDK and current official guidance:

- [Expo SDK 57 Notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/) and [current Notifications docs](https://docs.expo.dev/versions/latest/sdk/notifications/): channel-before-token ordering, permission states, token listeners, Expo lookup failures, presented-notification dismissal.
- [Expo Push Service request format](https://docs.expo.dev/push-notifications/sending-notifications/#message-request-format): Android `channelId` selects an existing channel; provider acceptance is separate from device delivery.
- [React Native Linking](https://reactnative.dev/docs/linking#sendintent-android): Android intents and app-settings fallback.
