# Durable Android local reminder foundation

This PR adds scheduling and its authoritative inputs. It does not enable local
reminders from product screens yet. The next PR must connect session restoration,
explicit device preferences, permission flows, every habit/lifecycle/profile action,
foreground server refresh, and local taps to this API. Existing friend reminders
continue through their existing remote service; this engine never calls that API.
Habit configuration still requires at least one reminder time, independently of
OS permission, channel settings or an installation's notification preference.

## Authoritative plan

`GET /local-reminder-plan` requires the existing bearer authentication and profile.
The backend alone derives the owner. The new service-role-only RPC takes the same
owner lock as habit/profile changes and calls the existing stable-date Today
reconciliation. It returns version, owner ID, authoritative database server time,
profile IANA timezone/current date, and two minimal scheduling projections:

- `effective`: every still-open stored occurrence's date, timezone, deadline and
  snapshotted reminder times. This deliberately includes a different local date
  retained after travel. It includes completed/excused occurrences too: the product
  contract asks for all configured reminders, with no local completion suppression.
- `future`: active habits' current schedule, ISO weekdays, times, and public
  `eligible_from` boundary. This boundary is at least tomorrow in the profile zone,
  the private cursor's next date, and the timezone transition floor. No private
  cursor objects, historical reconciliation details or future occurrences escape.

An absent effective row means no current obligation; a configuration edit cannot
invent one. Archive retains an effective occurrence but removes future rules.
Creation/cutover and repeated timezone transitions cannot rewind eligibility.
No future occurrence rows are inserted; no local completion, progress or streaks
are calculated. No previously applied migration is edited. Apply the new migration
only through a separately authorized release process, before distributing consumers.

## Native engine and persistence

`mobile/modules/local-reminders` is an Expo local module, automatically linked on
Android. Its manifest supplies receivers/permissions; no custom prebuild patch is
needed. Expo Go, web, and iOS have no engine (`localReminders` is null).

The pure Java `Planner` is used by the actual native adapter. It selects the next
batch directly from unbounded recurrence rules, using `java.time` with core-library
desugaring for supported Android versions. The phone timezone is never an input.
DST gaps shift by the gap duration (02:30 becomes 03:30 for a one-hour gap).
Overlaps use the earlier offset once. Entirely skipped civil dates are skipped.
An effective reminder cannot occur at or after its original deadline.

The native `Journal` holds an active recurrence cursor, compact overdue recurrence
windows, and a counted presentation outbox. A complete owner, lease, plan, clock
anchor and journal are written together through Android `AtomicFile` in
`noBackupFilesDir`, before scheduling. There are no stored credentials or push
identities. Event identities are deterministic owner/habit/date/configured-time
strings; an overlap cannot duplicate them. A single stable immutable PendingIntent
replaces the one earliest OS alarm. Repeating reconciliation cannot grow a queue.
Replacement freezes undelivered old rules into finite **time windows**, not a finite
list of notifications. Each window retains its own cursor and inclusive end; newly
introduced rules start strictly after the replacement cutover. Repeated refreshes
cannot move a backlog cursor, replay newly introduced past times, or add empty
windows. Empty windows are pruned as work drains. The Android adapter uses the
same `Journal.replacement` transition tested by the Java coordinator.

Already accepted occurrence snapshots remain immutable, including after their
original deadline removes them from the server's still-open projection. For
predicted dates at or after the new profile date, overdue work must intersect the
new authoritative rules (same habit, date, configured time, zone, schedule and
deadline). An absent current occurrence cancels that prediction; archive retains
the current snapshot and removes future recurrence. Older elapsed dates retain
the rules accepted when they became due: the minimal plan contains no historical
revocation feed. Remote edits made while offline cannot be reconstructed from
this projection; a fresh plan governs its current/future coverage. Account
cancellation always discards all windows and the outbox.

An old account lease cannot replace/cancel a new account's schedule; cancellation
persists a tombstone before OS cleanup. A fresh acquire after cancellation creates
a new lease. Older server plans cannot overwrite a newer plan.

The alarm receiver computes subsequent reminders and re-arms natively. Boot,
package replacement, clock/timezone changes, and exact-alarm grant broadcasts
restore from disk. Unique WorkManager registration is awaited before acquire succeeds. Persistent
WorkManager work repairs an interrupted
write/arm/delivery transition without requiring JavaScript. This is a recovery
mechanism, not a finite notification horizon. Each pass drains at most 64 batches;
remaining work stays durable and reports `catchup_pending` for subsequent recovery.
The receiver holds a short bounded wake lock. A process killed between OS presentation
and outbox acknowledgement can retry the same notification; absolute exactly-once physical
notification delivery is not possible across that OS boundary.

There is only one outstanding alarm and one local notification slot. Simultaneous
reminders are represented by one counted notification; delayed batches accumulate
a persistent unread count instead of exceeding Android's active-notification cap.
Batch consumption, the monotonic total count and a pending-presentation flag commit
atomically **before** posting. A failed write consumes nothing; a failed post or
post-acknowledgement write leaves the counted outbox retryable. Replacement carries
that outbox unchanged. Retry cannot increment the same batch again, even if the
new plan changes the batch composition. A tap carries the lease and displayed
sequence, so an old notification cannot acknowledge newer unpresented work or a
new enable/account epoch. Acknowledgement never advances recurrence cursors.
The version-2 journal also upgrades the earlier PR format's counted batch without
counting it again.
Scheduling exceptions/capacity failures retain desired state and report
`repair_required`; nothing is silently truncated to a platform queue length.

## Native API for the integration PR

1. Call `acquire(authenticatedOwnerId)` after deciding this installation is enabled.
   Persisted ownership survives process death. Switching owners invalidates old work.
2. Call `clock()` immediately before the authenticated `readLocalReminderPlan` read.
3. Pass the lease, JSON plan and that monotonic clock sample to `replace`.
   Validation completes before writing. Samples older than two minutes are rejected.
4. Call `status()` for foreground repair/status. It never prompts for permission.
5. Call `cancel(lease)` for explicit disable/logout. Await/handle failures. It cancels
   the alarm, periodic repair and presented local notification. Do not acquire a
   different account until the product knows its intended local preference.
6. Listen for native `onLaunch` signals and consume `launchMetadata()` after startup
   and on native notification launches; validate it using
   `localReminderDestination(metadata, currentAuthenticatedOwnerId)`, then use the
   existing authenticated Today flow. The native launch itself opens the app only.
   Metadata has a validated owner UUID, fixed type and fixed Today target; payload
   URLs and arbitrary route names are not used. Product tap wiring is deferred.

Server time anchors scheduling; elapsed realtime prevents manual phone-clock edits
from changing it within the same boot. The server sample is a lower-bound anchor at receipt: network delay can make
delivery late by up to the full sampled request duration, returned as
`clockUncertaintyMs`. The engine does not guess a one-way delay that could fire
early or skip an imminent reminder. After reboot, restoration estimates elapsed time using
the saved wall clock and reports `clock_unverified` until a new server plan arrives.
Offline native code cannot establish authoritative current server time after reboot.
The OS timezone database must be current. Changes made on another device need a
new authenticated plan; this engine has no remote mutation subscription.

## Honest platform statuses and limits

`scheduled_os_limited` means Android accepted an exact alarm, not that delivery was
observed or guaranteed. `inexact` means exact-alarm access was unavailable and
`setAndAllowWhileIdle` was used. `permission_blocked` means app or local channel
notifications are disabled; configured habit times remain intact. `awaiting_plan`,
`idle` (no upcoming reminders), `clock_unverified`, `catchup_pending`, `repair_required`, `stale_lease`, and
`cancelled` describe other explicit states. Product integration must show these
states rather than interpreting every resolved native call as success.

Exact alarms use `SCHEDULE_EXACT_ALARM`, never the policy-restricted `USE_EXACT_ALARM`.
There is no automatic special-access prompt. Android idle quotas can delay closely
spaced configured times even with exact access; inexact alarms and WorkManager can
be deferred further. Deferred reminders are counted during recovery. Device off,
force-stop, OEM battery restrictions and app-data deletion cannot promise delivery.
Android force-stop prevents restoration until the user launches the app again;
app data deletion/reinstall removes the local schedule. The periodic worker may
be delayed in Doze and is not a delivery SLA. No screen, JS timer, rolling finite
queue, or iOS calendar trigger is the basis of continued scheduling.

## Verification

Run `npm ci`, `npm test`, and `npm run typecheck` in mobile. With JDK installed,
`bash scripts/test-local-reminders.sh` compiles and runs the exact production pure
planner/journal with injected persistence, scheduling and process-restart faults.
Run the backend suite with all migrations in a fresh disposable PostgreSQL database
using `backend/tests/postgres_scaffold.sql`, including its default table grants.
Never point these tests at a shared database.

The `Local reminder native verification` GitHub workflow installs JDK 17/21 and
Android tools, generates an ignored Android project with a fake Firebase file,
and runs `:local-reminders:testDebugUnitTest :local-reminders:assembleDebug`.
It then asserts that the built AAR contains `LocalRemindersModule.class` and that
all 19 or more adapter tests ran with zero failures, errors or skips. The AAR and
XML/HTML test reports are uploaded for inspection.
`AndroidAdapterTest` exercises the production adapter against Robolectric’s Android
framework: real adapter serialization/atomic persistence, alarm restoration and
cancellation, ownership fencing, notification/channel and exact-alarm denial,
overdue replacement, repeated refreshes, snapshot expiry, timezone cutovers, 130
batches across three recovery passes, and persistence/presentation failures.
Fault tests shadow only AtomicFile and NotificationManager boundaries; they use
the production planner, coordinator and adapter.
These tests do not establish device delivery. A local equivalent is:

```sh
cd mobile
npm ci
export RUNNER_TEMP=/absolute/path/to/scratch
node scripts/native-test-config.cjs
GOOGLE_SERVICES_JSON="$RUNNER_TEMP/reminder-google-services.json" npx expo prebuild --platform android --no-install
cd android
./gradlew :local-reminders:testDebugUnitTest :local-reminders:assembleDebug
```

For engine-only verification without React Native artifacts, after prebuild run
`REMINDER_NATIVE_WORK_DIR="$RUNNER_TEMP/reminder-native" bash scripts/verify-reminder-android.sh`
from mobile. This copies the unchanged production Engine/Planner/Journal sources
and Android adapter tests into a standalone Android library and assembles/tests
that library. It excludes only the Expo bridge. CI runs both paths, and uploads
reports even if the subsequent full Expo module build fails.

For a distributable native app, supply the real Firebase configuration and follow
the existing Android build guide. The generated project is not committed. Device
verification must cover process death without force-stop, reboot, force-stop then
relaunch, exact permission denial/revocation, notification/channel blocking,
phone/profile timezone differences, DST, multiple close times in Doze, account
replacement, cancellation, and capacity/partial-failure recovery. No device delivery,
real remote send, deployment, shared migration or merge is claimed by this PR.

## Actual results for this PR

Based on merged main `ff5d531` (PR #28), verified against origin before changes:

- All 1,660 backend tests passed against a fresh disposable PostgreSQL 16 database
  with all migrations and the repository's Supabase-style table/function grants.
- All 31 mobile test files passed; TypeScript checking passed.
- The production Java planner/journal runner passed on JDK 17, including DST gaps,
  overlaps and a half-hour transition; phone/profile zone differences; skipped
  civil dates; selected weekdays; snapshot deadlines; 1,000 simultaneous reminders;
  overdue replacement without retroactive new times; repeated refreshes; 132 daily
  batches with refresh/restart between bounded passes; and durable count/outbox
  recovery across persistence and presentation failures.
- The updated production Android engine compiled and assembled locally; all 19
  Robolectric adapter tests passed (zero failures, errors or skips), including
  replacement, 130 batches across multiple passes, actual persistence and notification
  boundary failures, old tap receipt isolation, and earlier journal migration.
- The CI setup fix in `7a43ad82` is preserved (`packages: platform-tools`). Its
  [native workflow run](https://github.com/HaddadGavriel/HabbitTracker/actions/runs/39515322237)
  succeeded, including the full Expo module build and Android adapter tests.
  Verification of the replacement/outbox changes is recorded below after CI.
- The local environment still cannot download the locked React Native debug AAR
  redirected to `repo.reactnative.dev` (network policy HTTP 403). Full Expo module
  verification uses GitHub's runner; the local standalone path compiles the exact
  production engine and adapter tests, excluding only the Expo bridge.

No physical-device or emulator delivery check ran. No shared migration, deployment,
remote notification send, or merge was performed. The PR remains draft until the replacement regression suite and full Expo module
build pass on the updated branch. Device delivery remains a separate manual check.

## Official documentation checked on 2026-10-21

- [Expo Notifications](https://docs.expo.dev/versions/latest/sdk/notifications/):
  `CalendarTriggerInput` and its timezone option are iOS-only. Installed
  expo-notifications 57.0.21 Android `DailyTrigger`/`WeeklyTrigger` use
  `Calendar.getInstance()` with the device zone and have no profile-zone input.
- [Android scheduling guide](https://developer.android.com/develop/background-work/services/alarms):
  PendingIntent alarms survive application exit; restore alarms after boot, and
  check exact-alarm special access. Repeating alarms are inexact.
- [AlarmManager reference](https://developer.android.com/reference/android/app/AlarmManager):
  allow-while-idle quota/throttling, cancellation, and PendingIntent-based scheduling.
- [Android 14 exact-alarm changes](https://developer.android.com/about/versions/14/changes/schedule-exact-alarms):
  special access is denied by default for many installations; check and degrade.
