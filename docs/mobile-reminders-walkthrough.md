# Mobile friend reminders: two-device walkthrough

Use two onboarded test accounts, Alice (owner) and Bob (sender), on separate
physical development/preview builds against an authorized test backend. Follow
[sharing](mobile-sharing-walkthrough.md) and [notification setup](mobile-notifications.md)
first. The mobile workflow uses the existing [reminder contract](reminders.md);
it adds no backend route or migration. This walkthrough is a manual release check,
not an instruction to send pushes during automated implementation verification.
A successful real reminder request can send an actual notification. Use mocks for
provider errors, timeouts, and storage failures.

## Sending and eligibility

1. Make Alice and Bob accepted friends. As Alice, create a private daily habit,
   enable notifications in Settings, and explicitly share the habit with Bob.
   As Bob, open **Friends’ habits**, refresh, then open the detail. **Remind** is
   available in both views when the server returns an incomplete `in_progress`
   occurrence due today in Alice's timezone and its original deadline is open.
   Bob does not need to enable notifications to send a reminder to Alice.
2. Verify no Remind action for an unshared/archived habit, no occurrence due today,
   completed, missed, pending-excuse, or excused occurrence. Complete/undo a binary
   occurrence and raise/lower target progress as Alice; refresh Bob's view after
   each action. Use the occurrence snapshot and original deadline, not edited
   targets or Bob's date. A timezone-transition day without an occurrence remains
   ineligible. After the original deadline or owner-local midnight passes, the
   button disappears without a local scheduler sending anything.
3. Tap Remind once. Repeated taps and list/detail navigation must not create a
   second logical request. The app saves a key scoped to Bob and this habit before
   dispatch. A storage failure blocks dispatch and offers recovery of that same
   key. No account credential, push token, notification text, or friend name is
   stored in the reminder journal.
4. Confirm each mocked result is described accurately:

   | Result | Expected explanation |
   | --- | --- |
   | `provider_accepted` | Provider accepted all selected devices; phone delivery unconfirmed |
   | `partially_accepted` | Some accepted; others failed or unknown; phone delivery unconfirmed |
   | `failed` | All selected devices failed/rejected, no confirmed acceptance |
   | `unknown` | A notification may already have been accepted |
   | `no_devices` | Owner had no registered devices; no provider submission |
   | `reserved` | No recorded final result; may be running or may never finish |

5. With a mocked timeout, 503, or malformed success, navigate away and back, then
   force-stop/restart the app. No request is dispatched by mounting, restoring,
   foregrounding, or signing in. **Check same request** uses the original key.
   This can complete the original request if it never reached the server; an
   existing reservation is only read, never redispatched. Check `reserved` the
   same way. Do not clear app storage to recover an ambiguous request: clearing
   data/reinstalling loses the installation's saved keys.
6. Complete today's habit, or advance the mocked owner date, after reserving a
   request. Its saved key remains checkable while access is active, even when a
   new reminder is ineligible. Earlier unresolved requests remain available as
   **Check earlier request N** after an explicitly chosen new request.
7. Every reservation, including failed/no-devices/unknown, consumes its cooldown.
   A 429 uses `detail.retry_at`. **Request new reminder** stays disabled until a
   refreshed server timestamp reaches that time; a fast device clock cannot
   unlock it. If no cooldown deadline was confirmed, check the saved request
   first. After cooldown, refresh and explicitly request a new reminder. Unknown
   or reserved outcomes require confirmation of the possible duplicate warning.
   Cancelling the warning sends nothing. There are no timed resends or receipt
   polls. Correct device/provider issues before deliberately requesting another
   reminder after failed/no-devices results.
8. Revoke sharing or remove friendship as Alice while Bob is checking a request.
   Denial hides reminder outcomes, retains the saved keys, and requires refreshed
   access. Archive/restore has the same access boundary. Switch Bob's device to a
   third account during a delayed read/save/send: no Bob outcome appears there,
   no pending save starts a dispatch under the wrong account, and captured old
   handlers cannot send as the new account. Sign back into Bob, regain current
   access, and recover the original key with fresh credentials.

## Receiving and tap navigation

1. On Alice's device, tap a reminder banner with the app foregrounded, tap it from
   the system tray while backgrounded, then repeat with a terminated app. Each
   tap enters the same handler. Cold-start capture happens before lifecycle
   cleanup clears the native last response. The handler waits for sign-in,
   onboarding, the normal auth-link flow, foreground state, and Router readiness.
2. Current backend pushes intentionally contain only `{"type":"habit_reminder"}`
   and generic visible text. They open **Today** only after fetching Alice's
   authorized current Today data. There is no specific habit identifier to follow.
   No notification title/body or arbitrary payload URL becomes a route.
3. Use a mocked notification response with the legacy payload in `reminders.md`
   (valid UUID `reminder_id`, `habit_id`, `occurrence_id`). For an owned active
   occurrence in the authorized Today result, open Today. For an old date or an
   archived owned habit, fetch authorized history and open **Habit history**.
   An older occurrence may require **Load more**; the app does not infer dates
   from a payload or navigate directly to unverified content.
4. Mock partial/malformed identifiers, a wrong type, URL-only data, or a custom
   notification action: ignore it. For deleted, inaccessible, or wrong-account
   habit references, or a failed authorization read, fall back to **Home** with
   a generic message. Never disclose the old habit/owner from a payload.
5. Tap while signed out and sign in, pause on onboarding, or enter password
   recovery before Router is ready. No protected content opens early. Switch
   accounts or start signing out while the authorization request is in flight:
   discard the bound tap, even if the old read later succeeds or the original
   account signs back in. An old notification tapped in a different account must
   pass that account's current owner checks; a generic notification can only open
   that account's freshly fetched Today.
6. Deliver the same tap through the cold-start response and warm listener, and
   leave the native last response uncleared across a restart. Handle it only once.
   Handled identifiers are persisted before navigation, across accounts. If that
   storage cannot be read/written, navigate nowhere and offer ordinary Home/Today
   navigation. A newer warm tap takes precedence over stale initial capture.
7. An infrastructure-test tap opens only **Diagnostics** after account readiness;
   it never invokes real habit navigation or automatically runs another test.
   A real habit reminder received while Diagnostics is visible must not appear
   as an infrastructure-test receipt.

## Automated verification and limits

Run `npm test` and `npm run typecheck` in `mobile/`. Tests exercise actual API,
services, controls, shared screens, Router guards and native listener adapters
with mocked storage/Auth/API/native components. They cover all statuses,
write-before-dispatch, save failures, process recovery, cooldowns, duplicate
warnings, access loss, account switches, invalid payloads and cold/warm taps.
No automated test sends a real push or polls provider receipts.

Physical-device notification presentation/taps, Back behavior, accessibility,
OS process restoration, live Supabase/Expo/FCM, and two-device delivery still need
this manual walkthrough after an authorized release. Provider acceptance alone
never establishes phone delivery. No chat, custom messages, automatic nudges,
separate encouragement delivery, or scheduling is introduced.
