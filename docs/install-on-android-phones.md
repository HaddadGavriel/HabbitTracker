# Install Habit Tracker on two Android phones

This is the complete private-testing path for the Supabase + Render + Expo/EAS +
GitHub app. It produces a standalone Android APK; Expo Go, Google Play submission,
Android Studio and a running Metro server are not needed. An APK cannot run on an
iPhone. No APK exists until the EAS build below actually finishes successfully.

Use `codex/release-hardening-and-evidence` after PR #35 is merged into PR #33.
Keep production and `main` unchanged. The npm advisory gate and deferred leaked-
password protection remain open release items; they are not reported as resolved
by this internal test. Physical-device testing starts after installation.

## 1. Accounts, tools and the values you will collect

Run these steps on **your own computer**, not the network-restricted Codex worker.
The worker's `api.expo.dev` HTTP 403 is an environment restriction, not evidence
that your Expo account is broken. Interactive EAS login on your computer does
**not** require creating or sharing an `EXPO_TOKEN`.

Install Git and Node.js **22.13 or newer on the supported Node 22 line**. On
Windows use **Git Bash**, installed with Git for Windows. On macOS/Linux use a
terminal with Bash available. The commands below use Bash syntax. Reopen the
terminal after installing tools and check:

```bash
git --version
node --version
npm --version
```

Have browser access to GitHub, Supabase, Render, Expo and the existing Firebase
project. Firebase is required for Android remote notifications even though the
application's main services are Supabase, Render, Expo and GitHub.

| Item | Use this |
|---|---|
| GitHub repository | `HaddadGavriel/HabbitTracker` |
| Source branch for API and APK | `codex/release-hardening-and-evidence` |
| Render workspace | `My Workspace`, ID `tea-dak30qgjo6nc73bab7fg` |
| Supabase organization | `haddadgavrielorg`, ID `celfocnmmhpsdbpgofxx` |
| Existing production Supabase project | `zsqzenswefkjaundwyct` — do not use for this test |
| Existing EAS project ID | `4f31560d-6323-41f7-ae0a-f792a4814c98` |
| Existing Android application ID | `com.haddadgavriel.habittracker` |
| Existing app URL scheme | `habittrackerinfra` |
| New test API name | `habit-tracker-pr33-internal` |
| EAS build profile / environment | `internal-testing` / `preview` |

You will collect the **new test Supabase ref**, its URL, publishable key and
server secret; the **new Render API URL**; and the **existing Firebase project ID**.
Keep the database password, server secret, signing keystore and Firebase service-
account private key in credential stores. None belongs in Git, chat or APK public
variables. The `sb_publishable_...` key is intentionally included in the APK.

## 2. Get the correct code from GitHub

Use a fresh directory so old `.env` files and generated native projects do not
accidentally become part of this build:

```bash
git clone --branch codex/release-hardening-and-evidence https://github.com/HaddadGavriel/HabbitTracker.git HabbitTracker-phone-test
cd HabbitTracker-phone-test
git branch --show-current
git rev-parse HEAD
```

If GitHub asks, authenticate using your normal account/credential manager.
Record the printed commit. Confirm `mobile/eas.json` contains `internal-testing`
and `scripts/internal-testing/start-api.py` exists. These files require PR #35's
changes; a checkout of `main` will not contain this setup. Do not run `eas init`.

## 3. Create an empty Supabase test project

In [Supabase Dashboard](https://supabase.com/dashboard), choose organization
`haddadgavrielorg`, then **New project**. Name it `HabbitTracker Internal Test`.
Create and store a strong database password. Choose a suitable region and review
the actual plan/quota/price before creating it. Do not assume an additional
project is free on every organization plan.

A normal separate project is sufficient. You do not have to buy a development
branch. If you already have a suitable empty development branch, use its own ref,
keys and migration history instead. Do not copy production users/data.

Wait until the project is ready. In its **Connect / Settings / API keys** pages,
record:

- Project ref: the 20-letter identifier in its Dashboard URL.
- Project URL: `https://YOUR_TEST_REF.supabase.co`.
- A current **publishable** key beginning `sb_publishable_`.
- A **secret** server key beginning `sb_secret_`, for Render only.

The key labels can vary slightly with Dashboard updates. The internal build
requires a modern publishable key, not the legacy `anon` JWT. Every key must
belong to this new project. Its ref must differ from `zsqzenswefkjaundwyct`.

## 4. Apply the repository migrations to the test database

In the terminal, start from the repository root (`HabbitTracker-phone-test`).
Replace `REPLACE_WITH_YOUR_TEST_REF` with the new project's actual ref:

```bash
npx --yes supabase@2.122.0 login
if [ ! -f supabase/config.toml ]; then npx --yes supabase@2.122.0 init; fi
export TEST_SUPABASE_REF='REPLACE_WITH_YOUR_TEST_REF'
```

Verify the value before proceeding. It must be the **test** ref, never production.
Then run:

```bash
npx --yes supabase@2.122.0 link --project-ref "$TEST_SUPABASE_REF"
npx --yes supabase@2.122.0 migration list --linked
npx --yes supabase@2.122.0 db push --linked --dry-run --skip-vault
```

Complete Supabase's browser login and enter the **test database password** when
prompted. The dry run should list only the missing repository migrations. On a
new empty project that is all **17**, ending with
`20261026063642_fair_deletion_maintenance.sql`. After confirming the target and
list, apply them and verify both local/remote columns align:

```bash
npx --yes supabase@2.122.0 db push --linked --skip-vault
npx --yes supabase@2.122.0 migration list --linked
```

Do not run `db reset`, copy the test scaffold into Supabase, or manually paste all
SQL into the editor. The CLI records migration history. Do not run `supabase
config push`; Auth is configured in the test project's Dashboard below. If a
migration fails, stop and retain the error with credentials redacted. Do not
mark failed migrations as applied to get past the error.

## 5. Configure test Auth and two accounts

In the **test project**, enable Email/password authentication. Under
**Authentication → URL Configuration**, set the app-only Site URL fallback to
`habittrackerinfra://auth-callback`, and add these Redirect URLs:

```text
habittrackerinfra://auth-callback
habittrackerinfra://
```

For the quickest first installation test, open **Authentication → Users → Add
user → Create new user**. Create two disposable users with different email
addresses you control, known strong test passwords and **Auto Confirm User**
enabled. Use **Create user**, not an email invitation. Later, sign into these
accounts in the app; their app profiles are created during onboarding.

This lets you test login, habits, friendships and notifications immediately.
It does not test signup email or recovery email delivery. Keep email confirmation
enabled for later acceptance; creating confirmed test users does not require
turning it off for all users. Leave the existing production Auth settings alone.

Before testing real signup/recovery for arbitrary testers, configure **custom
SMTP** in this test project's Auth email settings. Supabase's built-in sender
restricts recipients to organization-team addresses and has low rate limits.
Choose an email provider, verify your sender/domain, and enter its SMTP host,
port, username/password and From address. Do not add testers as organization
administrators merely to receive Auth mail. See
[Supabase SMTP documentation](https://supabase.com/docs/guides/auth/auth-smtp).
Use the app's exact callback URLs and the
[email-template instructions](android-release-runbook.md#supabase-auth-callbacks)
when testing confirmation/recovery links. This app does not handle PKCE `?code=`
links; preserve its existing implicit/token-hash flow.

## 6. Create the separate Render test API

In [Render Dashboard](https://dashboard.render.com), choose **My Workspace**.
Create **New → Web Service**, connect the existing GitHub repository and set:

| Render setting | Value |
|---|---|
| Name | `habit-tracker-pr33-internal` |
| Branch | `codex/release-hardening-and-evidence` |
| Runtime | Python |
| Root directory | Leave blank; commands start from the repository root |
| Build command | `pip install -r backend/requirements.txt` |
| Start command | `python scripts/internal-testing/start-api.py` |
| Health-check path | `/health` |
| Auto-deploy | Off |
| Region | Singapore matches the prepared Blueprint; choose the intended supported region |
| Instance plan | Free if available and adequate for this private test; review any paid price before selecting it |

Add these **service environment variables before deploying**:

| Name | Value |
|---|---|
| `PYTHON_VERSION` | `3.12.12` |
| `ENABLE_DIAGNOSTICS` | `false` |
| `INTERNAL_TESTING_SUPABASE_REF` | Your new test ref |
| `SUPABASE_URL` | `https://YOUR_TEST_REF.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | That project's `sb_publishable_...` key |
| `SUPABASE_SECRET_KEY` | That project's private `sb_secret_...` key |

The last value stays in Render only. Do not copy production service secrets into
this service. No Render PostgreSQL database is needed: the database is in Supabase.
The application uses Expo's normal push endpoint by default; leave diagnostics off.

Alternatively create a new Blueprint using **`render.internal-testing.yaml`**
from the release branch. Choose that exact Blueprint path, not the production
`render.yaml`. Its current platform validation must succeed before syncing; the
manual Web Service path above avoids depending on a custom Blueprint-path UI.
The separate file describes the same service and should not also be applied as
a second deployment owner after manually creating the service.

Deploy and wait for **Live**. Record the deployed commit and the actual HTTPS
service URL. If Render adds a suffix, use its exact URL everywhere below. The
guard accepts `habit-tracker-pr33-internal.onrender.com` and names beginning
`habit-tracker-pr33-internal-`; do not rename the service arbitrarily.

Open `https://YOUR_TEST_SERVICE.onrender.com/health` in a browser. Expect HTTP 200
with a healthy JSON response. An unauthenticated `/profiles/me` should reject
access. The first request on a sleeping free service may take longer; wait for it
to wake and retry in the app. A successful health response alone does not prove
Auth/database compatibility; successful app onboarding/habit creation will.

## 7. Log into the existing Expo project and verify credentials

From the repository root:

```bash
cd mobile
npm ci
npx --yes eas-cli@26.0.0 login
npx --yes eas-cli@26.0.0 whoami
npx --yes eas-cli@26.0.0 project:info
```

Log into the Expo account that owns or has access to project
`4f31560d-6323-41f7-ae0a-f792a4814c98`. Confirm `project:info` reports that ID.
If it reports another project, fix the checkout/environment/account before
proceeding. Do not create a replacement project or rerun `eas init`.

Inspect the existing Android credentials:

```bash
npx --yes eas-cli@26.0.0 credentials --platform android
npx --yes eas-cli@26.0.0 build:version:get --platform android --profile internal-testing
```

Select `internal-testing` if asked for a profile, and inspect the keystore for
`com.haddadgavriel.habittracker`. Record its certificate fingerprint and existing
versionCode. Reuse the original key; do not choose Generate, Replace or Delete.
If access/credentials are missing, restore them from the existing owner/backup.
The frozen-credentials build intentionally stops rather than generating a new
identity. If no app has ever been signed, first establish that fact and deliberately
provision its initial key as a separate setup action; do not guess that an existing
key is disposable. The profile increments the remote versionCode for new builds.

## 8. Supply the existing Firebase Android configuration

In [Firebase Console](https://console.firebase.google.com), open the **existing**
project used by this app. Under Project settings → General → Your apps, select
the Android app with package `com.haddadgavriel.habittracker`. Download its
**`google-services.json`** into the checkout's `mobile/` directory. Git ignores it.
Record the Firebase **Project ID**, not its display name or numeric project number.
Do not use the synthetic file generated by native CI.

There are two different Firebase files/credentials:

| Item | Where it belongs |
|---|---|
| `google-services.json`: Android client configuration | EAS `GOOGLE_SERVICES_JSON` file variable; its client configuration is packaged into the APK |
| FCM V1 service-account JSON containing a private key | EAS Android **push-notification credentials** only; never in the APK, Git, Render or `EXPO_PUBLIC_` variables |

In Firebase ensure Cloud Messaging HTTP v1 is enabled. Use `eas credentials
--platform android` to verify the matching existing Google service-account key
under **Push Notifications / FCM V1**. If none is configured, obtain the authorized
service-account credential for that existing Firebase project and upload it to
the FCM V1 slot. This is separate from Play Store submission credentials and the
Android signing keystore. A missing FCM credential can leave tracking usable but
prevent remote notifications; complete it before claiming push delivery works.

## 9. Configure EAS's preview environment

In Expo Dashboard open this existing project's **Environment variables** page.
Create/update the following **project-scoped** variables for **preview only**.
Use type **string** and visibility **Plain text** for this table. These identifiers
and publishable values are intentionally client-readable; the build preflight
must be able to read them before starting a cloud build.

| Name | Exact value to use |
|---|---|
| `EXPO_PUBLIC_EAS_PROJECT_ID` | `4f31560d-6323-41f7-ae0a-f792a4814c98` |
| `EXPO_PUBLIC_SUPABASE_URL` | `https://YOUR_TEST_REF.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | New test project's `sb_publishable_...` key |
| `EXPO_PUBLIC_API_URL` | Actual test Render HTTPS origin, with no `/api`, `/health`, port, query or other path |
| `INTERNAL_TESTING_SUPABASE_REF` | Same test ref, without a URL |
| `INTERNAL_TESTING_API_ORIGIN` | Exactly the same URL as `EXPO_PUBLIC_API_URL` |
| `INTERNAL_TESTING_FIREBASE_PROJECT_ID` | Existing Firebase Project ID from step 8 |
| `EXPO_PUBLIC_ENABLE_DIAGNOSTICS` | `false` |

Add the client file as a **file** variable with **Secret** visibility. From the
`mobile` directory, where the downloaded file now exists:

```bash
npx --yes eas-cli@26.0.0 env:set --name GOOGLE_SERVICES_JSON --value ./google-services.json --type file --environment preview --visibility secret --scope project
npx --yes eas-cli@26.0.0 env:list --environment preview
```

EAS uploads/materializes the file and supplies its temporary path during the
remote build. Do not enter your computer's path as a string environment variable.
`SUPABASE_SECRET_KEY` must not appear in the mobile configuration. Do not alter
EAS's production variables. Do not copy an old production `.env` into this clone.
If using the CLI instead of the Dashboard for a string, the verified syntax is:

```bash
npx --yes eas-cli@26.0.0 env:set --name VARIABLE_NAME --value 'ACTUAL_VALUE' --type string --environment preview --visibility plaintext --scope project
```

## 10. Build the standalone APK

Still in `mobile`, check the checkout and configuration:

```bash
npm test
npm run typecheck
npx --yes eas-cli@26.0.0 env:exec preview 'node scripts/internal-apk-preflight.cjs --configuration-only' --non-interactive
git rev-parse HEAD
```

Expect the preflight to say the internal configuration is verified. It checks
matching IDs/endpoints; authenticated live access and Firebase credentials are
separate checks. The remote post-install hook additionally checks the real client
file and resolved app/package identity.

Start the cloud build:

```bash
bash scripts/build-internal-apk.sh > ../internal-build-result.json
```

Progress and preflight messages go to the terminal's stderr; successful build
JSON goes to the file. The wrapper uses EAS CLI 26.0.0, profile `internal-testing`,
remote credentials, `--freeze-credentials`, `--wait` and `--json`. It does not
submit anything to Google Play. Your EAS plan may impose queue/build quotas;
review the account's actual limits before choosing a paid option.

Wait for a successful build, then inspect the result. If your terminal disconnects,
check the existing job before starting another:

```bash
cat ../internal-build-result.json
npx --yes eas-cli@26.0.0 build:list --platform android
npx --yes eas-cli@26.0.0 build:view YOUR_BUILD_ID --json
```

The successful job must have an actual build ID, Android APK artifact and download
link. A project Dashboard URL, a successful preflight or a Hermes export is not
an APK. Download the artifact and keep it with the source commit/build ID,
versionCode and certificate fingerprint. It must be an **`.apk`**, not `.aab`.
Optionally record SHA-256 using `sha256sum` (Linux/Git Bash), `shasum -a 256`
(macOS), or PowerShell `Get-FileHash -Algorithm SHA256`.

## 11. Install that APK on both phones

Use Android test phones or a fresh secondary Android user profile, if supported.
This APK uses the **same package and signing identity** as the existing app. In
the same Android profile it updates/replaces that app; it is not a second icon
running beside production. Use a separate phone/profile if you need to retain
the existing app/session unchanged. Start with clean test-profile storage so old
production sessions or reminder journals are not carried into the test backend.

On each phone:

1. Open the actual EAS build/download page and download the APK. Share the same
   private test build with the second tester.
2. Tap the downloaded file. When prompted, open Android Settings and allow
   **Install unknown apps / Allow from this source** for the browser or file
   manager doing the installation. Return and tap Install.
3. Open **Habit Tracker**. You do not need Expo Go or a QR scanner inside Expo Go.
4. Once installed, you may turn that browser's installation permission off again.

USB/ADB is optional. With Android platform-tools installed and USB debugging
authorized, `adb install -r PATH_TO_APK` installs an update. Multiple attached
phones require `adb -s DEVICE_SERIAL install -r PATH_TO_APK`.

If Android reports a signature mismatch or lower versionCode, use the correct
original certificate and a higher versionCode. Do not bypass verification or
uninstall the existing app merely to hide an update-compatibility problem.

## 12. First test session on the phones

1. Warm the test API's `/health` URL if using a sleeping free Render service.
2. **Phone A:** sign in as test user A. **Phone B:** sign in as test user B. If you
   pre-created users in Supabase, choose Sign in, not Sign up.
3. Finish onboarding with distinct usernames, for example `tester_a`/`tester_b`,
   display names and your real supported timezone, such as `Asia/Jerusalem`.
4. On A, create one daily binary habit and one target habit. Check Today,
   complete/undo, target progress and history; close/reopen the app and verify
   the data persists. Repeat basic tracking on B.
5. Use Friends to search the other exact username, send a request and accept it
   on the other phone. Share A's habit with B and verify B sees it under Friends'
   habits but cannot edit A's habit or progress.
6. On each phone, open Settings and **Enable notifications**. Grant Android's
   notification permission. Separately enable **local habit reminders**. If the
   UI reports inexact alarms, allow **Alarms & reminders** in Android special app
   access for more precise timing, then resync.
7. Set A's local reminder a few minutes in the future, leave the app in the
   background and observe the notification. Do not use Android Force stop for
   this first check; force-stop intentionally suppresses background behavior.
8. On B, send a friend reminder for A's open, shared, due-today habit. Background
   A's app first. Verify actual notification display and tap navigation. The
   server has a 60-minute sender/habit cooldown: repeated sends can be correctly
   blocked. Use a different eligible habit when testing another send.
9. Submit an excuse on A for a shared occurrence and approve/reject it on B.
   Verify the correct owner identity and final state. Test share revocation,
   archive/restore and profile-name editing.
10. Test sign-out/account switching and notification cleanup. Use an extra
    disposable account when testing permanent deletion. If deletion remains
    pending, retain its recovery state and retry; staging maintenance/alert
    rehearsal remains part of later release acceptance.

Keep a small results sheet: build ID/commit, phone model/Android version, account
label, steps, expected result, actual result and time. Redact passwords, tokens
and personal data from screenshots/logs. For failures, check **test** Render logs
and **test** Supabase Auth/database records. An Expo ticket is acceptance by Expo,
not proof that a phone displayed the push.

Continue with the [complete release checklist](android-release-runbook.md) for
cold email links, real recovery, reboot/Doze, accessibility, lost-network/deletion
recovery, cron alerts and signed in-place updates. Those checks follow a working
installation and are not prerequisites to downloading the APK.

## Troubleshooting and subsequent test builds

| Symptom | First action |
|---|---|
| `Not logged in` / project denied | Run EAS login and `project:info` with the account authorized on the existing project. |
| Expo CONNECT 403 in Codex | Use the local-computer workflow above or configure the managed environment's supported network/secret settings. A token alone does not fix denied networking. |
| Internal preflight fails | Read the named field; match both Supabase refs and both Render origins, use the required API name and publishable key, and check preview visibility. |
| Firebase file missing or mismatched | Upload the real existing Android client file as an EAS file variable for preview; verify project ID/package. |
| Frozen credentials fail | Restore access to the existing keystore; do not generate a replacement key. |
| Render startup exits | Check all six test service variables, root directory, branch and startup logs. |
| Login succeeds, profile/habits fail | Check API/Supabase environment matching, server secret and all 17 migrations; the health endpoint alone is insufficient. |
| `Email address not authorized` | Default Supabase SMTP is restricted; use confirmed test users initially or configure custom SMTP. |
| Request timeout after inactivity | Warm the free API and retry; persistent problems need logs. An always-on paid test instance is optional. |
| Remote pushes fail | Check Android permission/channel settings, Settings registration, real Firebase client file and EAS FCM V1 credentials. |
| Local reminders delayed | Check local-reminder opt-in, exact-alarm access, battery behavior and force-stop state. |
| Wrong backend after an env change | Rebuild/reinstall the APK; `EXPO_PUBLIC_` values are compiled into it. |

For another tested code revision, pull the release branch, apply any new test
migrations before manually deploying that same revision to the test API, then
build/install another internal APK. Keep the signing key and package unchanged;
the profile increments versionCode. Record which API/mobile revisions were used.
The phones reach Supabase/Render/Expo over the Internet; your computer need not
remain running after the standalone APK is installed.
