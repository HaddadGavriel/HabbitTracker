# Test the reminder fixes in the installed Android app

These changes include Kotlin/Java and journal recovery. Install a rebuilt APK;
Metro reload, restarting the existing APK, and an over-the-air JavaScript update
cannot install the complete fix. No backend deployment or database migration is
required for this change. Keep the existing backend, EAS project and signing key.

## Build and install

From your existing full repository checkout, fetch the fix branch:

```bash
git fetch origin
git switch codex/fix-local-reminder-delivery
git pull --ff-only
git log -1 --oneline
cd mobile
npm ci
```

For the existing EAS internal-testing installation, reuse its configured preview
environment and existing remote signing credentials:

```bash
bash scripts/build-internal-apk.sh > ../reminder-build-result.json
```

Run this in Git Bash on Windows or Bash on macOS/Linux. If EAS is not logged in,
run `npx --yes eas-cli@26.0.0 login` on your computer, then repeat. The wrapper
checks the existing isolated testing configuration and waits for the APK build.
It does not change production services or submit to Google Play. If your installed
APK used another EAS profile, build with that same profile/environment/signing key
instead; do not change which backend the app uses just for this update.

Open the successful build's APK download link on the phone and install the update
over the existing app. Alternatively, download that APK and run:

```bash
adb install -r path/to/updated.apk
```

Do not uninstall or clear app data. A signature/version mismatch should be fixed
by using the existing signing key and a higher versionCode, not by erasing data.
Record the build ID and source commit shown by EAS. A build started from an old
checkout or an old download link does not contain these fixes.

For an app previously built locally with Expo/USB, keep your existing `.env` and
Firebase configuration, connect the same phone with USB debugging enabled, and
run `npx expo run:android --device` from `mobile`. Expo prebuild must include the
current local-reminders module and the app-level desugaring plugin. A local debug
APK cannot update an EAS-signed release APK because their certificates differ.

## Prepare a short, controlled test

1. Open the updated app while connected. In Settings, enable habit reminders if
   needed and press **Retry / resync reminders**. Confirm permission is Allowed
   and the message reaches scheduled/idle or an actionable error. It must not
   remain indefinitely on Refreshing. A native wait times out after 15 seconds;
   a network fetch can take about 30–35 seconds.
2. Check **Next scheduled reminder** and **Last notification posted**. The former
   uses the phone's display timezone. Reminder configuration uses the profile
   timezone; the notification itself labels the original schedule timezone.
3. For a precise baseline, allow Habit Tracker in Android Settings → Special app
   access → **Alarms & reminders**, if your Android version exposes it. Confirm
   the Habit reminders notification channel is enabled. Test inexact access and
   normal battery restrictions separately, recording delays.
4. Create a **new** daily test habit with one time at least five minutes ahead and
   a second time at least fifteen minutes after the first. Use the profile
   timezone. Do not complete or excuse it before the first reminder. Today's
   existing occurrences retain their saved times when edited, so changing an old
   habit's times is not a reliable same-day test.

## Expected results

| Test | Procedure | Pass condition |
| --- | --- | --- |
| Foreground delivery | Leave the app open across the first time. | One notification names the scheduled date/time/timezone; its count describes this batch. |
| Resync after delivery | Leave that notification unread, resync, and wait at least two minutes. | It remains visible; resync neither dismisses it nor alerts again. |
| Background delivery | Press Home and lock the phone before the second time. | Another delivery updates the notification to the second scheduled time; a single habit still says 1, rather than accumulating the first reminder. Record Android delay. |
| Completion | In a separate new habit test, complete it before a later time. | Its remaining reminders for that date stop; tomorrow remains eligible. |
| Shared batch | Give two test habits the same future time. After delivery, complete one. | The count changes from 2 to 1 silently; completing both clears the summary. |
| Offline startup | After a successful schedule, close the app, disable network, reopen, then reconnect and retry. | The enabled preference survives the profile-load failure and scheduling resumes without enabling again. |
| Ordinary process restart | Swipe the task away and reopen. | Consumed times do not replay; future times remain scheduled. |
| Tap | Tap a new local reminder. | The app opens authenticated Today for the current account. |
| Disable/sign-out | Disable reminders or sign out with future work scheduled. | The local notification and future alarms are cancelled. |

A delayed existing batch may still arrive up to one hour late while its occurrence
is open. Resync must preserve it during that grace period; newly added past times
must never generate catch-up reminders. Exact alarms and WorkManager remain
subject to Android idle/OEM limits. Force-stop suppresses alarms until the app is
launched again, so do not use it as the background-delivery test.

## If anything fails

Record the exact Settings message, last sync, next scheduled time, last posted
time, profile timezone, configured times, actual arrival time, phone model/API,
and build ID/commit. A timestamp showing sync before the reminder time is normal.
If a native operation repeatedly times out, Android Settings → Apps → Habit
Tracker → Force stop, then immediately reopen online and resync. Do not clear data.
This restarts a stalled bridge; no delivery is expected while force-stopped.

If USB debugging is available, the existing read-only capture script helps:

```bash
bash scripts/capture-local-reminder-device.sh reminder-fix-check
```

Use the resulting observations template to distinguish an alarm registration
from actual notification delivery. Stalled bridge, failed posting and crash-window
cases are covered by injected automated tests; ordinary network toggling does
not reproduce every native failure.
