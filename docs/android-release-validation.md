# Release-candidate validation evidence

Executed 2026-10-23 in the managed Linux workspace, based on merged `main`
`3a41b35`. No deployment, shared migration, live-service setting change, production
mutation or real push occurred. This is **not production/device verification**.

| Check | Actual result |
|---|---|
| Lockfile installation (`npm ci`, then locked `expo-system-ui` install) | Pass. The workspace initially lacked `expo-crypto`; reinstalling the existing lockfile resolved it. Added only `expo-system-ui` 57.0.4 for native theme configuration. |
| `npm --prefix mobile test` | **698 passed, 0 failed, 0 skipped**. Existing behavioral regression assertions retained; shared control/native-context mocks adapted. Added foreground listener and real shared-control tests. |
| `npm --prefix mobile run typecheck` | Pass, `tsc --noEmit`. |
| Backend isolated API suite (`cd backend && .venv/bin/python -m pytest -q`) | **963 passed, 744 skipped**; skips are PostgreSQL tests intentionally requiring the disposable DB. No live Auth/Expo transport. |
| `bash backend/scripts/test-postgres.sh` | **1,707 passed**, no skipped tests, with PostgreSQL 16 and **all 15 migrations**. Tests include RLS/grants, owner/recipient authorization, concurrency, deadlines/DST, deletion fences/anonymization and reminder idempotency. |
| `backend/.venv/bin/python mobile/e2e/verify-api.py` on a fresh `stack.py` | Pass. Real HTTP FastAPI → PostgREST 12.2.12 → migrated PostgreSQL; two fixture users, friendship/sharing, completion/undo, reminder replay (one recorded dispatch), excuse approval, revocation, unauthorized owner and direct-client access denial. |
| `bash mobile/scripts/test-local-reminders.sh` with local Temurin JDK 21 | Pass: “Planner and journal tests passed (DST, replacement, bounded backlog, durable outbox and faults)”. This is JVM engine verification, not Android delivery. |
| `npx expo prebuild --platform android --no-install` | Pass with the installed locked dependencies and a **fake Firebase client file**. Generated native files are ignored/uncommitted. |
| `npx expo config --type public --json` + generated manifest/resources assertions | Pass: Habit Tracker name; unchanged `com.haddadgavriel.habittracker`, `habittrackerinfra`, slug and EAS UUID; `allowBackup=false`. |
| `npx expo export --platform android` | Pass, Android Hermes bundle ~3.9 MB. Uses loopback fixture URLs/public key; not a release APK. |
| Pinned Maestro 2.0.10 official `YamlCommandReader` | Owner and social flows parse, including referenced subflows. Command documented in `mobile/e2e/README.md`. |
| `maestro test …` | **Not executed on device**: CLI reports “Not enough devices connected (0)”. Native UI journeys remain manual-verification-pending, not passed. |
| `./gradlew :app:assembleRelease --no-daemon --max-workers=2` locally | **Blocked**. Gradle 9.3.1 starts with JDK 21 and configured proxy/CA, then cannot resolve the required JDK 17 toolchain (resolver HTTP 403). This workspace also has no Android SDK/emulator. No full application APK is claimed. Native module CI evidence is recorded below; the manual emulator workflow remains unexecuted. |
| Source/security/config review | No private credential-pattern findings in tracked source; no credentials or tokens added to logs. Diagnostics now default off server/client, confirm before sending, and redact provider failures. Safe Auth/upstream errors, guarded routes, session-bound listeners and cancellation regressions reviewed. `git diff --check` passes. |

The first PostgreSQL attempt used an **external workspace helper** with stale role
scaffolding and failed 37 permission checks. The committed runner uses the actual
repository scaffold in a new container and passes all checks. No migration or
regression assertion was weakened to mask those failures.

GitHub Actions also passed on implementation commit
`9d36cf2bbfc1ed3f0ef901f312f55b1f33c074d0`:

- [Mobile tests and typecheck](https://github.com/HaddadGavriel/HabbitTracker/actions/runs/39935781877).
- [Backend API and disposable PostgreSQL tests](https://github.com/HaddadGavriel/HabbitTracker/actions/runs/39935781888).
- [Local reminder native verification](https://github.com/HaddadGavriel/HabbitTracker/actions/runs/39935781943): both Android builds succeeded; the full module AAR contains the Expo bridge, and **29 Android adapter tests passed, 0 failed/errors/skipped**. This verifies native module compilation and JVM/Robolectric adapters, not a full application APK or device delivery. The run retains test reports and the AAR as artifacts.

Native automation is reproducible through `mobile/e2e/README.md` and the manual
`Android native smoke (isolated services)` workflow. Ordinary PR CI continues to
run mobile, API, full PostgreSQL migrations and native reminder checks without real
pushes. Native fixture authentication is not live Supabase Auth; the local
PostgREST check is not evidence that a hosted project has been configured correctly.

Before release, attach an actual signed APK build and Maestro JUnit/screenshots,
then complete the runbook's two-device acceptance: real confirmation/recovery,
FCM receipt/taps, local alarms/reboot/permissions, small-screen keyboard/TalkBack/
font scale, upgrade with existing signing, sign-out cleanup and disposable live
Auth deletion. Configure staging callback/EAS/Render/Firebase settings only during
a separately authorized release. These external tasks remain open.
