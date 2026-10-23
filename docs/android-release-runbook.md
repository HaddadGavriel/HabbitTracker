# Habit Tracker Android release candidate

This PR prepares a release; it does not deploy, apply shared migrations, change
live settings or establish production readiness. See [requirements](android-release-checklist.md)
and [validation evidence](android-release-validation.md). Device checks below are
release gates, not claimed results.

## Release order (separately authorized)

1. Back up the target Supabase database and record existing API/APK versions and
   signing fingerprint. First rehearse against a **dedicated staging project** with
   two disposable accounts. Never use production credentials in automation.
2. Review `supabase migration list`, then apply **every unapplied migration in filename
   order**, `202610050001_infrastructure_proof.sql` through
   `202610220001_account_deletion.sql`. Use the same reviewed files as tested locally.
   Do not edit/reapply old migrations. This PR adds no schema migration. The last
   migration wraps 31 service RPCs, fences pending deletion and preserves anonymous
   final decisions; skipping it breaks the matching API. Follow [deletion recovery](account-deletion.md).
3. Deploy matching FastAPI source to the existing Render service (`backend`, Python
   3.12, `pip install -r requirements.txt`, `uvicorn app.main:app --host 0.0.0.0 --port $PORT`).
   Check `/health`, then authenticated profile, Today and reminder-plan reads in
   staging. `/health` alone does not verify Auth/database readiness.
4. Configure staging callback/FCM settings, build the preview APK with the existing
   EAS project and signing key, install/update on two Android devices, and complete
   the acceptance checklist. Record APK SHA256, commit, EAS build ID, versionCode,
   device/Android versions, timestamps and expected/observed outcomes.
5. Only after separate approval and device acceptance repeat the reviewed release
   sequence for the intended live environment. No automated real push test is part
   of ordinary CI.

## Supabase Auth callbacks

Keep Email enabled and confirmation enabled for release acceptance. In Auth URL
configuration allow **`habittrackerinfra://auth-callback`** and the supported legacy
root **`habittrackerinfra://`** (and `habittrackerinfra:///` if previously configured).
Do not rename the scheme. Configure the Site URL to your intended fallback, not a
random localhost URL. Signup uses `emailRedirectTo`; recovery and resend use the
same callback. Test actual email redirects on a cold and running installed APK.

The parser accepts `type=signup` or `type=recovery`, with an implicit
`access_token`/`refresh_token` pair or `token_hash`. For customized email templates,
link `habittrackerinfra://auth-callback?token_hash={{ .TokenHash }}&type=signup`
(or `type=recovery` for recovery). PKCE `?code=` links are not supported by this
implicit-flow app. Links are consumed in an isolated nonpersistent Auth client,
never silently replacing the signed-in account. Verify expired/reused links and
recovery for B while A remains signed in. Never paste callback tokens into logs,
screenshots, tickets or PR evidence.

## Configuration ownership

| Where | Variables/settings | Visibility |
|---|---|---|
| EAS preview/production and local mobile build | `EXPO_PUBLIC_API_URL` (HTTPS Render origin), `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public, compiled into APK; all must target the same environment |
| Existing EAS project | `EXPO_PUBLIC_EAS_PROJECT_ID=4f31560d-6323-41f7-ae0a-f792a4814c98` unless an already-authorized environment explicitly overrides it | Public identifier; do not run `eas init` to create a replacement project |
| EAS file variable/local ignored file | `GOOGLE_SERVICES_JSON` | Firebase **client** configuration, matching Android package and Firebase project; not an FCM private key |
| Render only | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | Secret key must remain private, absent from Expo public variables/artifacts/logs |
| Render only | `EXPO_PUSH_URL=https://exp.host/--/api/v2/push/send`, `CORS_ORIGINS` JSON list | Native traffic does not rely on CORS for authorization |
| Support diagnostics | `ENABLE_DIAGNOSTICS=false` on backend; `EXPO_PUBLIC_ENABLE_DIAGNOSTICS=false` in APK | Both opt-ins required. Keep off normally. Auth/deletion guards still apply; explicit confirmation before a real diagnostic push |
| EAS credentials | Existing Android signing keystore and Firebase service-account **FCM V1 private key** | Private, never mobile env/git/Render |

Create the Firebase Android app for **`com.haddadgavriel.habittracker`**. Download
its client `google-services.json` into the ignored path/EAS file variable. Enable
FCM HTTP v1 and associate the matching service-account key through EAS Android
credentials. Enable Android app and channel notification permissions. An Expo
acceptance ticket is not evidence of FCM delivery. Full setup: [Firebase/EAS guide](android-push-setup.md).

## APK build, install and update

Use the lockfile: `cd mobile && npm ci && npm test && npm run typecheck`.
Validate with `npx expo config --type public`, then use existing EAS credentials:

```bash
eas build --platform android --profile preview
# Download that exact build, then on each authorized test device:
adb install -r habit-tracker-preview.apk
```

Preview is an APK/internal distribution and now increments the remote Android
versionCode; production remains an AAB. Preserve the application ID, slug
`habit-tracker-infrastructure-proof`, EAS project and signing certificate. The
launcher name is **Habit Tracker**. Do not uninstall to test an update: `-r` with
the same certificate retains session, notification journals and local schedules.
OS backups are disabled so session and account journals cannot be restored onto a different installation. In-place updates still retain app data.
A signature mismatch requires the correct original signing key, not a workaround.
Keep the prior signed APK for compatibility testing.

Native smoke builds are separate, local-only, debug-signed artifacts. After using
`mobile/e2e/build.sh`, cleanly regenerate untracked `mobile/android` with the real
release environment (`npx expo prebuild --clean --platform android --no-install`)
before building a release. Never distribute the smoke build or its loopback config.

## Rollback compatibility

Database migrations are forward-only; do not drop tables/functions to roll back an
APK/API deployment. Account deletion is irreversible, and completed deletion
receipts/fences must survive API rollback. Keep an API version that understands
deletion guards and the current schema; reverting before #31 is unsafe. Releasing
an older UI still requires a **new higher versionCode** signed with the same key.
Do not downgrade/uninstall a user's app to sidestep Android update rules.

This PR adds a native `expo-system-ui` dependency for consistent light-theme
contrast. It needs a new APK, not a JS-only update to an older native runtime.
The repository does not configure `expo-updates`/runtimeVersion/channels; do not
invent an OTA channel or change EAS identity during this release. Existing schemes,
notification channel IDs, registration and reminder journal formats are preserved.
A push accepted before logout/deletion can still arrive; content stays generic and
taps must reauthorize. Offline devices cannot instantly learn changes made elsewhere.

## Two-device acceptance (record evidence for each)

Use staging accounts A/B on two physical Android devices, including Android 13+
notification permission behavior. Include one small display, large font scale and
TalkBack pass. Restore normal device settings after testing.

- [ ] Fresh install, signup/confirmation, sign-in and profile onboarding; expired,
  malformed and reused email links; recovery while signed out and while another
  account is signed in; Back/Menu cannot bypass recovery or session guards.
- [ ] Visit Today, My habits, Friends, Friends’ habits, Pending decisions, Settings
  from Menu. Check hardware/header Back and cold deep links. Diagnostics absent by
  default. Keyboard never covers final form actions; all controls scroll/reflow,
  have intelligible labels and remain operable with large text/TalkBack.
- [ ] Create daily binary and selected-weekday target habits with multiple times;
  complete/undo/set/lower progress, edit, archive/restore, history and current streak.
  Check timezone change, fixed existing deadlines, selected-day boundaries and midnight.
- [ ] A/B request, accept, reject and confirmed remove; exact search; share only one
  habit; unshared habit absent; archive hides and restore preserves explicit grants;
  revoke/remove clears recipient access on refresh/foreground and blocks stale writes.
- [ ] A submits shared excuse; B sees pending/provisional streak and confirms a final
  decision; A refreshes Today/history. Check unshared automatic approval, immutable
  explanation/decision and preserved progress/deadline.
- [ ] B sends remote reminder while A has an eligible habit and enabled registration.
  Record actual A tray/display, cold/warm tap navigation, duplicate-key and cooldown
  behavior. Repeat with denied permission/no registered device; distinguish acceptance
  from delivery and ensure no stale-account content after switching/sign-out.
- [ ] Enable/resync local scheduling; check remaining reminders after completion,
  undo, excuse, archive, timezone changes, foreground, process death and reboot.
  Test alarm/notification denial and force-stop limits using the [native checklist](android-local-reminders-verification.md).
- [ ] Offline reads show errors/last-loaded status; writes never claim offline success.
  Reconnect and explicitly reconcile uncertain saves before retry. Foreground on both
  devices updates statuses without duplicate mutation or notification handlers.
- [ ] Update prior signed APK in place; session and journals remain valid. Sign-out
  cancels local reminders and recovers unconfirmed remote cleanup. Delete disposable
  A with password/typed confirmation; interrupt/recover deletion, verify A is fenced,
  B loses A's shares and final decisions by A remain “Deleted friend”.
