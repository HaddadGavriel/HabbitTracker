# Habit Tracker — profiles, friendships, and habit tracking

This repository contains authenticated profiles, exact username lookup, friendships, private habit tracking, selective habit sharing, occurrence excuses with friend decisions, owner occurrence history, current streaks, and friend-triggered push reminders. It also retains the Android infrastructure proof. Backend contracts and PowerShell walkthroughs are in [`docs/friendships.md`](docs/friendships.md), [`docs/habits.md`](docs/habits.md), [`docs/occurrences.md`](docs/occurrences.md), [`docs/sharing.md`](docs/sharing.md), [`docs/excuses.md`](docs/excuses.md), [`docs/history.md`](docs/history.md), and [`docs/reminders.md`](docs/reminders.md).

## Architecture

```text
Expo/React Native Android app
  ├─ Supabase Auth (email/password session)
  └─ Bearer access token → FastAPI on Render
       ├─ validates token with Supabase Auth /user
       ├─ secret-key REST calls → Supabase PostgreSQL
       └─ Expo Push API → FCM → same Android device
```

The secret key exists only on the backend. PostgreSQL tables have RLS enabled and intentionally grant no direct client access. The app receives only publishable values: Supabase URL/publishable key, API URL, and EAS project ID.

## Repository structure

* `mobile/` — Expo SDK 57 / Expo Router React Native TypeScript app.
* `backend/` — structured FastAPI service, external-service adapters, and tests.
* `supabase/migrations/` — source-controlled PostgreSQL schema.
* `docs/android-push-setup.md` — Firebase, FCM, EAS build, installation, and verification walkthrough.
* `render.yaml` — Render Blueprint.

## Required tools and accounts

Install Git, Python 3.12, Node.js 22.13 or newer, npm, [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), and EAS CLI (`npm install --global eas-cli`). You need free/paid accounts as applicable for Supabase, Render, Expo, and Firebase, plus a physical Android phone. Expo Go is not the artifact used for this proof; build an APK with EAS.

## Environment variables

### Mobile/public (`mobile/.env`)

Copy `mobile/.env.example`. These are compiled into the app and **must not be secrets**:

| Variable | Value |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase **Project Settings → API → Project URL** |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Modern `sb_publishable_...` key from Supabase **Settings → API Keys** |
| `EXPO_PUBLIC_API_URL` | Deployed HTTPS Render URL, e.g. `https://...onrender.com` |
| `EXPO_PUBLIC_EAS_PROJECT_ID` | UUID printed by `eas init` |

For local Expo commands these values can live in the gitignored `mobile/.env`. EAS cloud builds do **not** depend on that local file: the same values must be configured in the EAS `preview` environment as described below.

### Backend/private (`backend/.env` locally; Render environment in production)

Copy `backend/.env.example`:

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Same Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Modern `sb_publishable_...` key, sent as `apikey` when validating the user's JWT |
| `SUPABASE_SECRET_KEY` | Modern `sb_secret_...` key used as the database REST `apikey`; never put it in mobile code or an `Authorization` header |
| `EXPO_PUSH_URL` | Keep default `https://exp.host/--/api/v2/push/send` |
| `CORS_ORIGINS` | JSON list. `['*']` is acceptable for native-only proof; use JSON double quotes, e.g. `["https://admin.example.com"]` |

No database password or Firebase private credential belongs in the mobile `.env`.

## Supabase setup

1. Create a project at Supabase. In **Settings → API Keys**, create/copy a modern publishable (`sb_publishable_...`) key and a modern secret (`sb_secret_...`) key. The deprecated JWT-shaped `anon` and `service_role` keys are not used.
2. In **Authentication → Providers → Email**, enable Email. For a fast test either disable **Confirm email** or keep it enabled and click the verification link before signing in.
3. During a separately authorized release, from the repository root link and apply the committed migrations:

   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```

   The CLI applies unapplied migrations in timestamp order, through `supabase/migrations/202610090001_friend_reminders.sql`. That migration follows merged PR #12's occurrence history/streak migration and must be applied before deploying the matching backend. It also makes device tokens globally unique, retaining the most recently updated registration when historical duplicates exist. If CLI access is unavailable, run each unapplied migration in filename order in **Supabase Dashboard → SQL Editor → New query → Run**; do not edit a migration that was already applied. Disposable PostgreSQL test setup is documented in [`docs/friendships.md`](docs/friendships.md). Implementation and tests do not apply shared database migrations or deploy the service.

### Profile onboarding and API

The onboarding sequence is deliberately explicit: (1) sign up or sign in with Supabase email/password, (2) send that session's access token to `POST /profiles/me`, then (3) use the authenticated read, update, and search endpoints. Existing Supabase Auth users simply receive `profile_not_found` until they perform step 2; there is no signup trigger, generated username, or email/password copy in `profiles`.

Every endpoint requires `Authorization: Bearer <SUPABASE_ACCESS_TOKEN>`:

| Endpoint | Request | Success | Expected errors |
|---|---|---|---|
| `POST /profiles/me` | `{"username":" Alice_1 ","display_name":" Alice ","timezone":"Asia/Jerusalem"}` | `201`, full profile | `409 profile_already_exists`, `409 username_taken` |
| `GET /profiles/me` | none | `200`, full profile | `404 profile_not_found` |
| `PATCH /profiles/me` | Any non-empty subset, e.g. `{"display_name":"Alice H."}` | `200`, full profile | `404 profile_not_found`, `409 username_taken`, `422` invalid/empty input |
| `GET /profiles/search?username=alice_1` | query parameter | `200` with only `user_id`, `username`, `display_name` | `404` for absent/self match or incomplete onboarding; `422` invalid username |

A full profile response has `user_id`, `username`, `display_name`, `timezone`, `created_at`, and `updated_at`. Identity and timestamps are server-managed: supplying `user_id`, `created_at`, `updated_at`, null required values, or any unknown field is rejected. PATCH is atomic and omitted fields remain unchanged.

Usernames are trimmed, lowercased, then must contain 3–30 ASCII lowercase letters, digits, or underscores. PostgreSQL also enforces canonical form and uniqueness, so concurrent claims cannot both succeed. Display names are trimmed Unicode strings of 1–80 characters. Timezones must be names accepted by Python's IANA timezone database, including `UTC` and `Asia/Jerusalem`; the backend installs `tzdata` so Render does not depend on the host's timezone package. Search uses the same username normalization and performs only an exact match. It never lists users, returns partial suggestions, or exposes email, timezone, timestamps, or Auth metadata.

### Test profiles with two existing Auth users (PowerShell)

No APK or mobile change is needed. In Supabase Dashboard, create/confirm two email/password users if needed. Sign each one in through the public Auth API, then call the deployed (or local) FastAPI service:

```powershell
$SupabaseUrl = "https://YOUR_PROJECT_REF.supabase.co"
$PublishableKey = "sb_publishable_..."
$ApiUrl = "https://YOUR_SERVICE.onrender.com" # or http://127.0.0.1:8000

function Get-AccessToken($Email, $Password) {
  $headers = @{ apikey = $PublishableKey; "Content-Type" = "application/json" }
  $body = @{ email = $Email; password = $Password } | ConvertTo-Json
  (Invoke-RestMethod -Method Post -Uri "$SupabaseUrl/auth/v1/token?grant_type=password" -Headers $headers -Body $body).access_token
}

$Token1 = Get-AccessToken "USER1_EMAIL" "USER1_PASSWORD"
$Token2 = Get-AccessToken "USER2_EMAIL" "USER2_PASSWORD"
$Headers1 = @{ Authorization = "Bearer $Token1"; "Content-Type" = "application/json" }
$Headers2 = @{ Authorization = "Bearer $Token2"; "Content-Type" = "application/json" }

Invoke-RestMethod -Method Post -Uri "$ApiUrl/profiles/me" -Headers $Headers1 -Body (@{ username="Alice_1"; display_name="Alice"; timezone="Asia/Jerusalem" } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "$ApiUrl/profiles/me" -Headers $Headers2 -Body (@{ username="Bob_2"; display_name="Bob"; timezone="UTC" } | ConvertTo-Json)
Invoke-RestMethod -Method Get -Uri "$ApiUrl/profiles/me" -Headers $Headers1
Invoke-RestMethod -Method Patch -Uri "$ApiUrl/profiles/me" -Headers $Headers1 -Body (@{ display_name="Alice H." } | ConvertTo-Json)
Invoke-RestMethod -Method Get -Uri "$ApiUrl/profiles/search?username=BOB_2" -Headers $Headers1
```

To verify enforcement after applying the migration, confirm that the first search returns only three fields; PATCH User 2's username to `ALICE_1` and expect `409 username_taken`; search for `bob` and for User 1's own `alice_1` and expect 404. In the SQL editor, test client access inside a transaction with `set local role authenticated; select * from public.profiles;` and expect permission denied, then `rollback`. The ordinary API suite uses isolated dependency replacements and mocked HTTP transport and never touches Supabase. CI also creates disposable PostgreSQL, applies the migrations to a minimal Supabase-role scaffold, and verifies constraints, RLS, cascades, stale transitions, and concurrency. The scaffold does not emulate Supabase Auth or PostgREST and must never point at a shared project.

## Backend local development and tests

**PowerShell:**

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
Copy-Item .env.example .env
# fill private values in .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**bash/zsh:**

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
# fill private values in .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Open `http://127.0.0.1:8000/health` for `{"status":"healthy"}` and `/docs` for Swagger. Run tests with `pytest`. A phone cannot use the computer's `localhost`; for local phone testing use the computer's reachable LAN IP in `EXPO_PUBLIC_API_URL`, but deployed Render HTTPS is recommended.

## Render deployment

Either create a **Blueprint** from `render.yaml`, or create a Render **Web Service** connected to this repository with:

* Root directory: `backend`
* Runtime: Python
* Build command: `pip install -r requirements.txt`
* Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
* Health check: `/health`

Set all backend/private variables above in **Render → Service → Environment**. Never paste Firebase service credentials into Render; Expo/EAS owns that connection. Deploy, then check `https://YOUR_SERVICE.onrender.com/health`. Put this HTTPS origin in `mobile/.env` and rebuild the APK.

## Mobile local development

**PowerShell:**

```powershell
cd mobile
Copy-Item .env.example .env
# edit .env and place the local-only google-services.json
npm install
npx expo install --fix
npx expo-doctor
npx expo start --dev-client
```

**bash/zsh:**

```bash
cd mobile
cp .env.example .env
# edit .env and place the local-only google-services.json
npm install
npx expo install --fix
npx expo-doctor
npx expo start --dev-client
```

Full Firebase and EAS account setup is necessarily external and is documented step-by-step in [`docs/android-push-setup.md`](docs/android-push-setup.md). The configured Android application identifier is `com.haddadgavriel.habittracker`.

## EAS APK and real-device installation

After completing the linked guide, the four public build values and `google-services.json` are stored in EAS's **preview** environment. `eas.json` explicitly selects that environment, while `app.config.ts` reads the EAS file variable path for Firebase. A gitignored local `.env` is not assumed to exist on the remote builder.

Build with:

```bash
cd mobile
eas login
eas init
eas build --platform android --profile preview
```

Open EAS's build link on the phone, download/install the APK, and approve Android's “install unknown apps” prompt. This is internal distribution, not Google Play publication.

## Exact end-to-end test procedure

1. Apply the Supabase migration and enable email authentication.
2. Deploy Render, verify `/health`, store its HTTPS URL in the EAS `preview` environment, and make the EAS preview APK.
3. Install and launch the APK on a physical Android device with internet access.
4. Enter an email/password and tap **Sign up**. Confirm email if the Supabase setting requires it, then **Sign in**.
5. Tap **Register notifications** and choose **Allow**. The app obtains an Expo token and sends it with the Supabase access token to `POST /devices/register`; confirm the green/check diagnostic text and the database row.
6. Tap **Run Infrastructure Test**. The client generates the ID and timestamp. FastAPI authenticates the caller, inserts and reads back the row, updates verification state, reads that user's latest token, calls Expo, saves the ticket, and responds with timings.
7. Compare the on-screen request ID to the notification body. The API, database, and push-request stages plus client/server timings appear on screen. Foreground receipt is also shown when observable.
8. Background or force-close the app, reopen it if needed to register/authenticate, then start another test and immediately background it. The OS notification must still arrive with that run's ID; no local-notification API is called anywhere.

## Troubleshooting

* **401**: sign in again; the Supabase access token is missing/expired, or backend Supabase URL/publishable key points at another project.
* **409 “No push token”**: tap Register notifications while authenticated and inspect `device_push_tokens`.
* **Permission denied**: Android Settings → Apps → Infrastructure Test → Notifications → Allow, then register again.
* **`DeviceNotRegistered` or push rejected**: reinstall the newest EAS build, verify EAS's FCM V1 key belongs to the same Firebase project as `google-services.json`, then re-register.
* **Ticket accepted but no visible notification**: an acceptance ticket is not delivery proof. Check Android notification permission/channel, connectivity, battery restrictions, and FCM V1 credentials. Ticket IDs are stored for manual Expo receipt diagnosis.
* **Network error**: ensure `EXPO_PUBLIC_API_URL` is deployed HTTPS, not phone-local `localhost`; visit `/health` from the phone browser.
* **Duplicate request ID**: retry from the button, which generates a new timestamp/random ID. Database uniqueness intentionally prevents ambiguous proofs.

## Deliberate limitations

This proof stores Expo ticket IDs but does not poll Expo receipts or implement scheduled token cleanup. Expo ticket acceptance and actual Android display are distinct; the real-phone procedure is the delivery test. Profiles, exact username search, backend friendships, private habit tracking, selective sharing, occurrence excuses with friend approval/rejection, owner history, current streaks, and friend-triggered reminders are implemented. Scheduled reminders, longest streaks, advanced analytics, other social notifications, and mobile tracking UI remain deferred. Friend-triggered reminders reserve a database-enforced 60-minute cooldown per sender/habit, use idempotency keys, and report Expo acceptance separately from actual phone delivery; see [the reminder API and two-user walkthrough](docs/reminders.md). Shared friends receive current streaks but cannot access full occurrence history.

## Private habit management

The backend supports private habit configuration, schedules, reminder settings, and archive/restore. See [the habit API guide](docs/habits.md) for configuration contracts, and [daily occurrence tracking](docs/occurrences.md) for Today, complete/undo, target progress, reconciliation, lifecycle/timezone policies, migration steps, and PowerShell examples. Owners can [share individual habits with accepted friends](docs/sharing.md); recipients see the owner's Today and current streak. Owners may [submit occurrence excuses](docs/excuses.md): unshared submissions automatically approve, while currently authorized friends decide shared submissions. [Occurrence history and current streaks](docs/history.md) documents owner-only paginated history, preserved snapshots, and provisional streaks that account for late excuse decisions. Recipients cannot edit habit configuration or normal completion/progress. Authorized recipients can [send a push reminder](docs/reminders.md) for an open incomplete occurrence due Today. Scheduled delivery and mobile tracking UI remain deferred.
