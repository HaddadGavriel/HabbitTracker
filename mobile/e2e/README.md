# Android smoke automation

Maestro 2.0.10 drives the **real native APK**. `owner.yaml` covers signup with
fixture Auth, onboarding, daily binary completion/undo, selected-weekday target
progress, multiple reminder fields, history/back, archive/restore, settings and
signed-out link guards. `social.yaml` alternates Alice/Bob through request/accept,
selective sharing, a recorded reminder, owner excuse, friend approval and revocation.
Run these in order, without parallel shards. They require a fresh stack each time.

This is native UI automation with **fixture Auth and a fake push provider**, plus
the real FastAPI, PostgREST 12.2.12 and PostgreSQL 16 with all migrations. It is not
live Supabase Auth, email confirmation/recovery, Expo/FCM delivery, or two physical
devices. Existing mocked Node screen/store regressions remain separate and intact.
The release runbook covers those live acceptance gates.

Only these fixture accounts exist (no real email):

| Account | Username after onboarding | Password |
|---|---|---|
| `alice@habittracker.test` | `smoke_alice` | `Smoke-only-123!` |
| `bob@habittracker.test` | `smoke_bob` | `Smoke-only-123!` |

`stack.py` creates uniquely named local containers, applies the checked-in
scaffold/migrations and seeds only Auth IDs and one fake Alice push registration.
Profiles, habits and relationships are created through the app. The fake
registration deliberately survives UI sign-out to exercise reminder dispatch
without FCM registration. The provider records submissions; it has no delivery
code. Mobile direct PostgREST access is denied. No shared database URL or real
credential is accepted. The fixture entry point is outside the deployed `app`
package and refuses non-loopback settings. Ports are bound only to localhost.

## Run

Prerequisites: Docker local socket, Python 3.12 with `backend/requirements-dev.txt`,
Node 22.13+, `npm ci` in mobile, JDK 17/21 as required by Expo/RN, Android SDK,
a dedicated emulator, and Maestro 2.0.10 on PATH. No Supabase/Render/EAS/Firebase
credentials are needed. No test service is publicly deployed.

```bash
# Terminal 1, repository root; Ctrl-C removes the containers and network.
backend/.venv/bin/python mobile/e2e/stack.py

# Terminal 2, repository root; builds a debug-signed release APK with loopback URLs.
bash mobile/e2e/build.sh
bash mobile/e2e/run.sh
```

The runner refuses physical devices before clearing app data. The build script
ignores local `.env`, writes a Firebase placeholder and restricts cleartext traffic
to `127.0.0.1` in the **generated** native project. `adb reverse` connects emulator
loopback to port 18000. Do not distribute this APK or use it for real accounts.
After smoke work, regenerate the native project cleanly with the release variables
before a real build; smoke XML must not enter a release artifact.

`Android native smoke (isolated services)` is a manual GitHub Actions workflow with
no secrets and uploaded JUnit/screenshots. It is manual because emulator builds
are expensive; ordinary PR checks still run mobile, API, all PostgreSQL migrations
and native reminder regressions. Neither path sends real pushes.

For machines without Android, independently check the real HTTP/PostgREST path:

```bash
# A separate fresh stack; this creates its own journey data.
backend/.venv/bin/python mobile/e2e/verify-api.py
# Stop/restart stack before running Maestro.
```

A successful HTTP check is not a successful native UI run. Attach actual Maestro
reports and device/build IDs to release evidence; see `docs/android-release-runbook.md`.

The checked-in flow syntax can also be verified with the official pinned parser
without a device (JDK required; adjust the CLI installation path):

```bash
java -cp "$HOME/.maestro/lib/*" mobile/e2e/MaestroSyntax.java mobile/e2e/flows/owner.yaml mobile/e2e/flows/social.yaml
```
