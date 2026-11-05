# Local reminder audit and repair

Audited base: `7769a75d62a02be617599fd4377039c603443d78`,
`codex/release-hardening-and-evidence`. The fixes are consolidated into that
release branch through [PR #36](https://github.com/HaddadGavriel/HabbitTracker/pull/36).
These results supersede the earlier audit
against `915333f`; they apply to the installed-build source revision identified
by the user. The phone's installed APK has not been independently inspected.

## Findings and changes

| Reproduced failure | Repair |
| --- | --- |
| A native, permission or schedule read can leave Settings busy indefinitely. | Bounded waits identify the failing stage, clear busy and restore retry. Late results cannot publish success or install an obsolete plan. Timed-out writes retain serialization until they settle. |
| Repeated routine refreshes invalidate a useful in-flight response. | Routine requests coalesce; confirmed mutations and account changes still invalidate older reads. |
| Authoritative resync consumes a due alarm before Android delivers it. | Retain previously scheduled, still-authorized work for one hour, bounded by the occurrence deadline. New past times never create retroactive work. |
| Unchanged resync removes an unread notification. | Persist latest batch membership; preserve unchanged notifications, silently update surviving members, and clear only removed batches. |
| Later reminders look like continuations of earlier ones. | Each batch displays its own count and original scheduled date/time/timezone in the existing single notification slot. |
| A known failed notification post loses its counted batch. | Persist retryable membership and re-arm a one-minute retry. A durable attempt marker distinguishes known failure from an ambiguous process crash. A newer due batch supersedes an older retry without two immediate alerts. |
| An expired earlier batch can hide a later eligible batch. | Exclude expired snapshots and past civil-date projections before selecting the next due batch. |

The corrected base already preserves same-owner opt-in during transient profile
failures and due alarms during routine maintenance. Those protections remain
covered by regression tests. The existing app-level desugaring change is retained.

No backend, migration, EAS identity, signing-key, or dependency changes are needed.
Journal version 3 reads version 2 data; the legacy summary with unknown membership
is cleared once without replaying consumed times. The foundation `replace` API
retains its compatibility behavior; application code uses `reconcile`.

## Validation

- `cd mobile && npm test`: **751 passed**, no failures or skips.
- `cd mobile && npm run typecheck`: **passed**.
- `bash mobile/scripts/test-local-reminders.sh`: **passed**, including DST,
  replacement, durable outbox, bounded recovery and injected faults.
- `mobile/scripts/verify-reminder-android.sh` adapter project:
  `testDebugUnitTest assembleDebug` **passed**; **51 Android adapter tests**,
  no failures or skips. Includes resync/delivery races, batch membership,
  rejected posts, persistence faults, retry deadlines, permission restoration,
  legacy journal upgrade and expired-earlier-batch selection.
- Expo Android prebuild: **passed** with temporary nonproduction Firebase
  configuration. The generated app retains core-library desugaring.
- Generated Expo project `:local-reminders:testDebugUnitTest
  :local-reminders:assembleDebug`: **blocked by dependency download**. Maven's
  React Native `0.86.3` debug AAR redirects to `repo.reactnative.dev`, which
  returns HTTP 403 in this environment. No full Expo bridge build success is
  claimed; the existing dependency versions were not changed to bypass it.
- `git diff --check`: **passed**.

The isolated adapter build uses the production planner, journal and Android
adapter. It does not by itself compile the Expo bridge. Automated native tests
use Robolectric and injected clocks/faults; they do not establish physical-device
delivery. No signed APK or EAS build has been produced in this environment.

## Installed-phone acceptance

Build a fresh EAS APK from `codex/release-hardening-and-evidence` using the existing profile/environment
and signing key, then install over the existing app. A JavaScript reload or OTA
update cannot install these native changes. Follow the
[phone regression checklist](../local-reminders-phone-test.md), record the source
commit and EAS build ID, and verify foreground, unchanged resync, locked-screen
delivery, completion, offline recovery and disable/sign-out.

Android exact-alarm access, idle quotas and OEM restrictions can still delay
delivery. Work is intentionally dropped after its grace/deadline or when revoked.
A crash at the OS notification boundary can still lose an ambiguous notification;
this change does not promise exactly-once delivery. A permanently stalled native
write requires restarting the app process; the timeout reports failure rather
than claiming cancellation or schedule installation succeeded.
