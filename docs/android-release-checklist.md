# Android MVP requirements → implementation

Baseline: PR #33 (`1853140e9a04db22ee164a21246d9b5428c2f567`) plus the
[2026-10-26 follow-up fixes and validation](release-evidence/2026-10-26-followup.md).
This is not a released build.
**Implemented/tested** refers to the isolated automation named below, not live
production or physical-device verification. All device acceptance gates remain in
the [runbook](android-release-runbook.md). Exact results: [validation](android-release-validation.md).

| Requirement | Implementation and evidence | Status |
|---|---|---|
| Authentication, confirmation, recovery | Auth form/email requests, strict callback parser, isolated recovery session, session guards; session/settings-recovery and Auth transport tests. Real email/cold links need staging devices. | Implemented/manual-verification-pending |
| Profile/timezone settings | Shared 484-identifier Python/native/Postgres contract with reviewed equivalent device-timezone suggestions; partial Settings edits preserve unchanged legacy zones, snapshots stay immutable, native unsupported plans pause safely; cross-runtime and recovery tests. | Implemented/tested |
| Binary and target habits | Create/edit, immutable type, complete/undo/absolute progress; forms/store/API/SQL regressions. | Implemented/tested |
| Daily/selected schedules, multiple reminders | Wrapping schedule controls, reminders input, versioned snapshots and native plan; field/input/plan/SQL tests. Actual alarm delivery pending. | Implemented/manual-verification-pending |
| Archive/restore | Confirmed archive/restore, preserved history/grants, recipient hiding and resync; screen/store/SQL tests. | Implemented/tested |
| Today and deadlines | Default route, authoritative dates/deadlines, focus refresh and mutation guards shared across separate store instances; remount/out-of-order/account-isolation regressions. | Implemented/tested |
| History/current/provisional streaks | Owner-only history and server streak calculation, recipient current/provisional summaries; history/excuse/SQL tests. | Implemented/tested |
| Friends/requests | Exact lookup, incoming/outgoing, accept/reject/confirmed remove; screen/API/SQL tests and real local HTTP journey. Foreground listener regression added. | Implemented/tested |
| Selective sharing | Explicit per-habit accepted-friend grants, revoke, archived visibility; sharing regressions and local HTTP verifies private/unauthorized access stays denied. | Implemented/tested |
| Excuses/decisions | Authorized owner display name/username in pending cards, irreversible confirmations and accessible actions; identical-habit/different-friend, revocation and decision regressions. | Implemented/tested |
| Remote friend reminders | Durable idempotency key, cooldown, generic payload and guarded navigation; reminder tests + local PostgREST dispatch with a fake push recorder. Real FCM receipt pending. | Implemented/manual-verification-pending |
| Local scheduling | Durable engine, same-owner offline opt-in, routine repair separate from missed-backlog recovery, timezone quarantine and owner fences; 39 current Android adapter tests pass. Earlier full-bridge CI evidence is historical; physical delivery remains blocked. | Implemented/manual-verification-pending |
| Notification lifecycle/navigation | Single app-level registration/token/tap listeners, account-keyed guarded routes, cold-link Today anchor, cleanup notices; lifecycle/tap/recovery regressions. Native delivery/taps pending. | Implemented/manual-verification-pending |
| Sign-out | Settings confirmation, stale-account fences, local/remote cleanup and recovery; session/notification/deletion lifecycle tests. | Implemented/tested |
| Account deletion | Password reauth, typed confirmation, durable receipt/retry, DB barriers/anonymized decisions; all deletion API/mobile/SQL suites pass. Real Auth deletion requires disposable staging acceptance. | Implemented/manual-verification-pending |
| Deletion maintenance | Bounded, idempotent CLI with durable fair claims, five-minute leases and 15-minute Render cron configuration; concurrency, restart, starvation, timeout and privilege regressions pass on PostgreSQL 16/17. Platform validation, deployment, staging sweep and failure notifications are not completed. | Prepared/activation-blocked |
| Consistent navigation and branding | Today default, Menu on guarded screens, six primary destinations, native Back/Today fallback; Habit Tracker launcher, existing package/scheme/slug/EAS project preserved. Route/config regressions pass; installed navigation acceptance pending. | Implemented/manual-verification-pending |
| Keyboard/safe areas/scroll/touch/text/accessibility | Android resize (no double keyboard avoidance), safe-area shell and standalone gates, scrollable cleanup notices, 48dp wrapping buttons/links, labeled multiline inputs, bounded wrapping choices, light native theme with explicit contrast. Shared UI regressions pass; small-display/TalkBack/font-scale device pass pending. | Implemented/manual-verification-pending |
| Loading/empty/error/retry/offline consistency | Existing uncertainty/confirmation guards retained, error vs empty decisions corrected, explicit no-offline-write message, safe Auth/API failures and screen retry boundary. API/store regressions pass. | Implemented/tested |
| Refresh/invalidation | Screen-scoped reads reload on focus; Today/sharing/recipient/decision refresh retained; Friends/My habits/history now refresh on foreground. Profile save invalidates date-dependent stores; guarded stale reads/mutations retained. | Implemented/tested |
| Security/reliability audit | No credential-pattern findings in tracked files; diagnostic server opt-in defaults off, client route opt-in and confirmation, redacted provider failure, safe Auth response/transport validation, HTTP error boundary. Cross-account, deletion, duplicate-write/listener regressions retained. | Implemented/tested |
| Dependency advisories | Python requirements audit clean; SDK 57 patches and fixed decoder backport remove moderate findings. npm still reports five high vulnerable packages from two Expo toolchain advisories. No allowlist or forced incompatible upgrade hides them. | Blocked |
| Reproducible native E2E | Maestro owner + two-user journeys, official parser verified, manual emulator CI, disposable local real API/PostgREST/SQL, fixture Auth and fake pushes; HTTP companion passes. Native UI execution unavailable (no device). | Implemented/manual-verification-pending |
| Release preparation | Migration/callback/Render/EAS/Firebase/build/update/rollback/two-device runbook; README and public/private env examples updated; actual evidence recorded. | Implemented/tested |

The dependency gate, operational maintenance activation, signed APK and physical
device acceptance remain open release blockers. Automated tests are not evidence
that physical behavior has passed. Outgoing-request cancellation has no backend contract;
full recipient history, groups/chat/feed/payments/web/iOS and advanced analytics
are outside this Android MVP scope. No feature is being reclassified as a future
fix to hide a discovered integration defect.
