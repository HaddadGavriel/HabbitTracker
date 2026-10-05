# Habit Tracker — end-to-end infrastructure proof

This repository deliberately contains **no habit-tracking features**. It is one narrow vertical slice proving that an authenticated physical Android device can call FastAPI, persist and re-read data in Supabase PostgreSQL, and receive a real remote notification sent by FastAPI through Expo Push Service and FCM.

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
3. From the repository root link and apply the committed migration:

   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```

   The exact SQL is `supabase/migrations/202610050001_infrastructure_proof.sql`. If CLI access is unavailable, copy that entire file into **Supabase Dashboard → SQL Editor → New query → Run**; no hand-authored GUI tables are required.

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

This proof stores Expo ticket IDs but does not poll Expo receipts or implement scheduled token cleanup. Expo ticket acceptance and actual Android display are distinct; the real-phone procedure is the delivery test. There are no habits, streaks, profiles, social features, or polished production UX.
