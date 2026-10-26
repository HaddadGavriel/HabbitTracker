# Android local-reminder verification

Use a rebuilt native development/preview app from the proposed commit, an approved
test backend with all committed migrations, and test accounts. Expo Go does not
contain this native module. No diagnostics screen or remote reminder send is needed.
This checklist is a procedure, **not a record of completed device tests**. Record
PASS, FAIL, BLOCKED or NOT RUN for each scenario, the app commit, API level, device/OEM,
profile timezone, server date, permission state, and observed times.

For legacy timezone coverage, use isolated test data created before the stricter
[timezone contract](timezone-contract.md). Confirm an unsupported profile still
loads Settings and can be corrected. Reminders must show the timezone pause and
cancel the old alarm/notification; background/restart must preserve that pause.
An unsupported occurrence retains its original date/deadline after profile repair
and stays paused until it is no longer eligible. A fresh supported plan resumes
future reminders without replaying missed times. Also verify logout/account
switching clears the pause together with the previous owner's schedule.

## Setup and evidence

1. Sign in, finish profile onboarding, and choose **Enable habit reminders** in Settings. Read
   both permission and local scheduling status. A successful scheduling status
   means Android accepted work; it is not proof that a notification appeared.
2. Create an active daily habit with times a few minutes ahead in the **profile**
   timezone. Confirm the save succeeds, return to Settings, and retry/resync if
   needed. Use times far enough apart to distinguish notifications; also run a
   separate closely spaced/Doze case to observe OS limits.
3. Note the current occurrence snapshot and future configuration. Do not change
   the phone clock to simulate a different server date: the scheduler uses a server
   time anchor and elapsed realtime within a boot. For midnight/DST scenarios,
   use the real transition or a separately isolated backend/native test fixture.
4. Collect read-only evidence before and after each scenario:

   ```sh
   cd mobile
   # Set ANDROID_SERIAL to a device serial when more than one device is connected.
   bash scripts/capture-local-reminder-device.sh before-background
   bash scripts/capture-local-reminder-device.sh after-background
   ```

   The script collects device/version, package permissions, appops and matching
   alarm/notification lines. It does not change the device, send notifications,
   read private app storage, or mark a scenario passed. Enter observations in the
   generated `observations.txt`; review identifiers before publishing evidence.
   OEM dumpsys output differs, so verify Settings and the tray directly too.

## Lifecycle and delivery matrix

| Scenario | Procedure | Required observations and limits |
| --- | --- | --- |
| Foreground | Keep Today open across a configured future time. | Observe one local summary; tap uses validated current Today. Repeated refresh does not duplicate a consumed time. |
| Background | Press Home and lock the screen before a future time. | Record delivery time and any delay. No screen or JavaScript timer must be required. Doze/OEM delay is possible. |
| Swipe away | Background the app, then swipe its task from Recents. Do **not** use Force stop. | On standard Android this removes the task and can kill the process without placing the package in the stopped state; the pending native alarm can still fire. Record OEM differences. |
| Process termination | Background first; run `adb shell am kill com.haddadgavriel.habittracker`. Verify the PID disappears; some devices may refuse the kill. | Wait for a future time without reopening. Record whether the receiver restarts the process and posts once. This is not force-stop. |
| Normal restart | Close/reopen the app after one reminder has appeared, then refresh repeatedly. | The already consumed time is not duplicated. Future reminders remain; Settings shows current status. |
| Reboot | Configure a future time, run `adb reboot`, unlock the device after boot, and wait without opening the app. | Boot restoration should re-arm persisted future work when Android permits. Record `clock_unverified` until a fresh authenticated plan; elapsed times are skipped, not replayed in a burst. No delivery is promised while powered off or before unlock. |
| Force-stop | Separately run `adb shell am force-stop com.haddadgavriel.habittracker`, or Settings → Apps → Habit Tracker → Force stop. | Android stops alarms/work/receivers for the stopped package. No background delivery or reboot recovery is promised until the user explicitly launches the app. Relaunch, refresh and verify only future times resume. |
| Doze/battery limits | Test a locked, idle device; record battery optimization and OEM restrictions. Optionally use Android's documented test-device idle commands. | Exact-alarm access does not remove allow-while-idle quotas; inexact work can be delayed further. A delayed scheduled batch may appear once. Recovery must not emit a burst for all missed times. Restore any test-only settings. |
| Routine repair before a delayed alarm | In the isolated native test harness, advance the clock past two configured times, run status and periodic repair before the alarm callback, then deliver duplicate callbacks. | Repairs retain the overdue batch and one alarm without posting. The callback posts only the first due batch once, skips the other elapsed times, and arms the next future time. |
| Explicit missed-backlog recovery | In the isolated native test harness, advance far beyond the stored cursor, then invoke boot/package-replacement recovery. | Recovery skips missed times without posting or draining a large backlog. Routine repair after recovery still preserves the next alarm if its callback is delayed. |
| App upgrade | Install a compatible newer build without clearing data, then relaunch/refresh. | Existing journal and preference recover, no already consumed reminder replays, current account owns the schedule. |

`am kill`, swiping Recents, process crashes, and Android **Force stop** are different
operations. Never report a force-stop result as evidence for ordinary process death,
or promise delivery after force-stop. Clearing app data/reinstalling removes the
local journal and preferences; it is not a cancellation test or recovery strategy.

## Supported permission states

Run the applicable rows for each API level in the supported test matrix. Do not use
`USE_EXACT_ALARM`; the app declares `SCHEDULE_EXACT_ALARM`. Special access is never
a prerequisite for habit tracking.

| OS/state | Procedure and expected result |
| --- | --- |
| Android API 30 and below | There is no Android 12 exact-alarm special-access gate. Verify allowed notifications and app/channel blocking. System app notification settings still matter. |
| API 31+ exact access allowed | Settings → Apps → Special app access → Alarms & reminders → Habit Tracker; allow where available. Refresh/resync and observe the accepted exact-alarm status, while retaining idle/OEM caveats. |
| API 31+ exact access denied | Deny that access, relaunch/refresh if Android stops the process, and observe inexact scheduling. Verify future delivery may be delayed and no permission prompt or failure blocks habit saves. On many fresh API 34+ installations this is the initial state. |
| Exact access revoked while scheduled | Revoke after scheduling. Android can cancel exact alarms and kill the process. Relaunch/refresh and verify recovery uses the currently permitted mode; periodic repair itself is OS-constrained. Do not promise uninterrupted delivery across revocation. |
| API 33+ notification permission denied | Deny the runtime prompt. Create/edit/complete habits successfully; Settings must explain the blocked state and provide system settings/retry. No notification is expected. |
| App notifications disabled in OS | Disable the app in system notification settings. Return to the app so the change is observed. Verify local scheduled/presented work is cancelled; account/habit state remains usable. |
| Only **My habit reminders** blocked | Block `local-habit-reminders` while other channels remain allowed. Refresh and inspect local blocked status. No local display is expected; friend-reminder channel settings are separate. |
| Permission/channel restored | Allow in system settings and explicitly re-enable if the installation preference was cleared; retry/resync. Verify only future eligible times are scheduled, with no catch-up notification burst. |
| In-app Disable | Disable notifications in Settings. Verify local alarm and presented local summary are cleared, status reports cancellation, and later future times do not fire. Remote unregister failures remain separately visible. |

Permission/channel changes made outside the app are observed on app activity or
native recovery. The app cannot run arbitrary JavaScript instantly when a user
changes an OS setting. The OS itself blocks presentation while notifications are
disabled. Always record the status **after** returning and refreshing.

## Product and account checklist

- Create a habit, edit times/weekdays/target, and refresh without Diagnostics. Verify
  each confirmed save remains successful even when scheduling is unavailable.
  Today's stored occurrence keeps its original reminders, timezone, target and
  deadline; changed configuration governs future eligible dates.
- Complete a binary occurrence before its second reminder. Verify that date's
  remaining reminders stop while tomorrow's remain. Undo while still eligible:
  only times still in the future on that date return.
- Reach a target, then reduce progress below the snapshotted target. Verify the same
  suppression/reopening behavior. Editing the habit's target must not rewrite the
  already stored occurrence's target.
- Submit automatic and pending excuses. Both lock the occurrence and suppress its
  remaining reminders; a later friend decision does not unlock completion/progress.
- Archive before a future reminder. Verify pending reminders for that habit stop.
  Restore and refresh: the server decides current eligibility; elapsed times never
  replay. Check today's eligibility boundaries as well as tomorrow's recurrence.
- Cross midnight with the app open and with it closed. Verify current dates and
  eligibility refresh, future recurrence continues, and consumed times do not
  duplicate. Use profiles spanning DST gaps/overlaps; gaps shift by the gap length,
  overlaps use the earlier offset once. Test a profile timezone different from the
  device zone, and a profile change that leaves an older still-open snapshot.
- On device A, schedule; on device B, complete/excuse/archive while A is offline.
  A may still show stale local notifications. Reconnect and foreground/resync A;
  current server eligibility must replace its schedule. A remote mutation cannot
  instantly revoke an offline device's already scheduled notification.
- Sign out and switch A → B during a delayed refresh/save. Verify A's late results
  cannot install reminders for B; A's scheduled and displayed local summary clear.
  Restart signed out and verify persisted A work is cancelled without needing a
  screen visit. Verify account-deletion cleanup through Settings with a disposable
  staging account, including interrupted deletion and saved-receipt recovery.
- Tap a foreground/background/cold-start local notification, an old notification
  after account switching, and a repeated tap. Navigation must await current auth
  and onboarding, validate the owner, fetch current Today, deduplicate handling,
  and ignore arbitrary payload routes. It must never send a friend reminder.
- Inject native scheduling/persistence/presentation failure in the test harness.
  Confirm a successful server save does not show a save failure or invite creating
  the habit again. Settings must retain actionable failure/retry state, and repair
  must preserve account isolation and consumed-time deduplication.

The engine uses one generic local summary slot. Suppressing a date/habit clears
that shared presented summary conservatively; it does not promise selective
removal of an individual habit's line. Screenshots, logs and alarm listings support
manual observations but do not prove that a human saw a notification. Automated
store/native tests do not establish physical-device delivery or OEM behavior.
