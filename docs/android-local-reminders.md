# Android local habit reminders

Habit reminders are integrated into the application. In Settings, choose **Enable
habit reminders** on this Android installation. This preference is separate from
remote friend-reminder registration and does not require an Expo push token.
Configured reminder times remain mandatory even when notification permission is
denied or this installation is disabled. Tracking and confirmed saves still work.
Expo Go, web and iOS do not contain this Android local module.

## Application lifecycle and mutations

`LocalReminderService` owns one coalescing reconciliation pump and a separate queue
for native writes and preference persistence. It refreshes the authenticated owner
plan after the initial profile load/sign-in, profile updates, successful Today
loads, foreground activation, and relevant confirmed mutations. A one-minute
foreground poll also catches midnight and connectivity returning while the app
stays open. Native recurrence continues independently while JavaScript is suspended.

Creation, editing, archive/restore, binary completion/undo, target progress changes,
and excuse submission call the service through the real application stores. A
confirmed completion, completed target, or any submitted excuse immediately
suppresses the habit/date in native storage before fetching another plan. Archive
suppresses the entire habit. These confirmations still suppress when the next
network read fails. Reopening/restoring requires current server eligibility and
only reinstalls reminder times strictly in the future.

Scheduling is a separate outcome from server persistence. Store hooks do not await
scheduling and contain synchronous/rejected adapter errors. Settings reports a
scheduling failure and offers **Retry / resync reminders**; the app must not report
a confirmed habit save as failed or invite a second creation.

Session and plan revisions invalidate old results before every native installation.
Only one plan read/reconciliation runs at a time; multiple refresh requests coalesce.
Cancellation uses the native queue without waiting for an old account's HTTP read.
Confirmed mutations from a token renewed within the same uninterrupted account
session are accepted, but results from before sign-out or A→B→A are ignored.

Initial Auth/profile hydration preserves a matching persisted preference. Startup
foreground events wait for authentication rather than interpreting a loading screen
as logout. Preference hydration failures cancel unknown native ownership. A durable
native cancellation tombstone prevents stale preference storage from re-enabling
reminders after a failed preference removal.

Sign-out, account replacement, and **Disable habit reminders** clear native alarms,
repair work, and the presented local summary. **Disable notifications** clears both
local and remote notification state. Permission/channel revocation is observed on
app refresh or native repair/alarm activity and clears local scheduled/presented
work. Android itself blocks presentation immediately when permission is revoked.
Remote unregister failures remain separately visible. Local cleanup failures remain
visible even after sign-out, with a retry button. `beforeAccountDeletion()` provides
a cleanup hook that must succeed before a future deletion flow removes credentials;
this repository currently has no account-deletion screen or endpoint.

## Authoritative plan and snapshot policy

`GET /local-reminder-plan` requires authentication and derives the owner from the
bearer session. The service-role-only RPC takes the same owner lock as mutations,
uses `get_today`, and returns version 1, owner ID, server time, profile IANA timezone,
profile local date, and two minimal projections:

- `effective`: open, incomplete, in-progress occurrences of active habits with no
  submitted excuse. Each row retains its stored date, timezone, deadline, and
  snapshotted reminder times, including a different local date retained after travel.
- `future`: active habits' current configuration and public `eligible_from` boundary,
  at least tomorrow, the private next-date cursor, and the timezone-transition floor.

Completion/excuses remove only the corresponding effective occurrence; later dates
remain scheduled. Archive removes both projections for the habit. Restore cannot
invent an absent occurrence or reopen a completed/excuse-locked one. Editing a
habit or profile timezone does not rewrite the existing day's snapshot. No future
occurrences, local progress/streak calculations, or private cursors are introduced.

The append-only migration `202610210002_local_reminder_eligibility.sql` changes the
foundation projection to enforce eligibility. Apply all migrations in a separately
authorized release before distributing the integrated app. This PR does not apply
migrations to a shared database.

## Native persistence, recovery and delivery

`mobile/modules/local-reminders` is automatically linked into Android builds. Its
manifest supplies the receivers and permissions. The production Java planner uses
`java.time` with Android desugaring and the profile/snapshot IANA zone, never the
phone timezone. DST gaps shift by the gap duration; overlaps use the earlier offset
once. Entirely skipped civil dates are skipped. Effective times must precede their
original deadline.

The native journal stores owner, lease, validated plan, clock anchor, recurrence
cursor, suppression exclusions and presentation counters atomically in
`noBackupFilesDir`. It stores no credentials or push tokens. One stable alarm and
one generic local notification summary avoid platform queue limits. Same-time
reminders form one batch. Native account leases fence old replace/cancel/suppress
calls; app code serializes installation-wide `cancelAll` with acquisition.

The integrated app calls **`reconcile`**, which drops elapsed work, intersects
current eligibility through the authoritative plan, and starts strictly after the
latest durable cursor/server time. It clears the previous generic presented summary
because that summary has no per-occurrence membership. `suppress` persists a
habit/date exclusion (or all dates for archive) and clears that same summary, while
retaining other future dates. Only a new authoritative reconciliation removes the
exclusion. Stale reads started before a local confirmation cannot replace it.

A real delayed alarm may present its first due batch once; other elapsed batches
are skipped. Boot, package replacement, clock/timezone broadcasts, WorkManager
repair, status checks and process recovery skip missed times without presenting a
catch-up burst. The cursor/count commits before presentation. Recovery discards an
ambiguous presentation outbox instead of reposting it, so a crash at that boundary
can lose that reminder. Future reminders remain recoverable. No exactly-once phone
delivery guarantee is made. Alarm/persistence failures report `repair_required` and
remain retryable. Repeated refreshes/restarts neither accumulate alarms nor replay
elapsed events.

The older foundation `replace` API and its backlog tests remain for compatibility;
product code does not call it. Its historical catch-up policy is **not** the policy
of the integrated `reconcile` mode, which is persisted across restart.

The engine uses the sampled server time as a lower-bound clock anchor and Android
elapsed realtime within a boot. Network delay may make delivery late by the sampled
request duration. After reboot it estimates elapsed time from saved wall time and
reports `clock_unverified` until a fresh server plan arrives. Offline code cannot
verify authoritative server time after reboot.

## Permission, settings and offline limits

Settings shows permission state, last successful schedule sync, scheduling result,
and retry/resync. `scheduled_os_limited` means an exact alarm was accepted;
`inexact` means `SCHEDULE_EXACT_ALARM` access was unavailable and Android's inexact
allow-while-idle fallback was used. No special-access prompt is launched
automatically, and policy-restricted `USE_EXACT_ALARM` is not requested.
`idle` means no eligible upcoming times; `permission_blocked`, `repair_required`,
`stale_lease`, `awaiting_plan`, and `clock_unverified` require attention/refresh.
Permission denial does not disable habit tracking.

Android idle quotas, battery/OEM restrictions, channel settings, device shutdown,
and force-stop may delay or prevent delivery, even with exact-alarm access.
WorkManager can also be deferred and provides no delivery deadline. Swiping the app
from Recents is different from force-stop; standard PendingIntent alarms can
survive process exit, though OEM policies vary. Android force-stop suppresses
alarms/jobs and broadcasts until the user launches the app again. Reboot restoration
requires a previously enabled installation and OS execution of the receiver/worker.
App data deletion/reinstall removes the local schedule. See the
[device checklist](android-local-reminders-verification.md) for precise procedures.

Changes on another device cannot instantly cancel this device's offline local
notifications. There is no remote mutation subscription. Until a fresh authenticated
plan is available, the native engine uses its last accepted plan and local confirmed
suppressions. Open/refresh the app when connected; foreground polling retries while
active. This is a local scheduling feature, not instantaneous cross-device delivery
or cancellation.

## Validated notification taps

Capture `launchMetadata()` at startup and on `onLaunch`. Native metadata is emitted
only for a current owner/lease and a valid positive counted sequence and includes a
stable `receipt_id`. `NotificationTaps.receiveLocal` validates the type, fixed Today
target, owner UUID and receipt, then uses the same durable deduplication,
authentication/onboarding/foreground/router gate as friend reminders. It fetches and
validates current owner Today before navigation. Account changes discard pending
taps; offline/unauthorized reads fall back safely. Payload URLs never choose routes.

## Verification

- `cd mobile && npm test` and `npm run typecheck` run application tests and types.
  New integration tests execute real Session/Create/Edit/Habits/Today stores with
  `LocalReminderService`; only HTTP, Auth, storage and native boundaries are mocked.
- `bash scripts/test-local-reminders.sh` compiles the production Java planner and
  journal, including DST, future-only reconciliation, suppression/reopening,
  restart, capacity and injected-failure regressions.
- The native workflow generates a nonproduction Expo Android project and runs the
  production adapter tests both independently and through the full Expo module.
  It checks the AAR contains `LocalRemindersModule.class` and uploads test reports.
- Backend PostgreSQL tests apply every migration only to a disposable database with
  `backend/tests/postgres_scaffold.sql`; never run them against a shared database.
- `bash scripts/capture-local-reminder-device.sh --help` describes the read-only
  evidence script. Follow the [Android checklist](android-local-reminders-verification.md).
  Automated tests do not establish physical-device delivery.

The foundation PR's historical results are recorded in
[PR #29](https://github.com/HaddadGavriel/HabbitTracker/pull/29). They are not results
for this integration revision. The integration PR records its own actual checks;
no device/emulator delivery, shared migration, deployment or merge is claimed.

## Platform references

- [Expo Notifications](https://docs.expo.dev/versions/latest/sdk/notifications/)
- [Android alarm scheduling](https://developer.android.com/develop/background-work/services/alarms)
- [AlarmManager](https://developer.android.com/reference/android/app/AlarmManager)
- [Android exact-alarm changes](https://developer.android.com/about/versions/14/changes/schedule-exact-alarms)
