# Timezone identifier contract

Profile creation and timezone edits accept only exact, case-sensitive identifiers
in [`timezones-v1.txt`](../backend/app/data/timezones-v1.txt). The 484 identifiers
are available in the pinned Python `tzdata==2025.2` package, Java 17, and PostgreSQL
16 without optional legacy timezone packages. Examples include `UTC`,
`Asia/Jerusalem`, `America/New_York`, and `Etc/GMT+5` (IANA's reversed offset sign).
Offsets such as `+05:00`, short IDs such as `EST`, OS-local names such as
`localtime`, `posix/` and `right/` trees, and unsupported legacy aliases such as
`US/Eastern` are rejected with HTTP 422. IDs are never trimmed or silently mapped.

The backend reads this catalog directly. Android packages the **same file** as a
Java resource, and `TimezonePolicy` resolves it for every planner rule, including
saved journal rules. Build from the repository checkout so the shared backend
resource is available. CI verifies that the full native module AAR contains the
same bytes. Changes to the catalog require the cross-runtime checks and a rebuilt
native app; it is not regenerated from the deployment machine's timezone list.

## Existing data and recovery

Profile responses do not apply the stricter write validator. A legacy timezone
stays visible when loading the account or editing another profile field, so its
owner can open Settings and select a supported value. Changing the profile does
not rewrite stored occurrence timezone, date, deadline or reminder snapshots.
Reminder-plan responses preserve those original values too.

If a plan or persisted journal contains an unsupported timezone, Android pauses
all local reminders for that installation and reports `unsupported_timezone`.
This also covers a catalog identifier unavailable in an older device's timezone
database. The engine durably records the pause, cancels its alarm and visible
notification, and retains the raw plan and journal. Status checks, workers,
receivers and restarts cannot revive the old schedule. It never falls back to UTC
or the phone's timezone. Account ownership and the saved opt-in remain intact.

Settings explains how to correct the profile and retry/resync, or update Android.
An unsupported occurrence snapshot continues to pause reminders while it remains
eligible; a profile edit alone cannot reinterpret it. Once a fresh supported plan
arrives (including after that occurrence expires), scheduling resumes from the
server time. Paused work is not replayed. Receipt counters survive recovery, and
normal bounded delivery and deduplication continue. Logout, deletion and account
switching still cancel the old owner's schedule.

## Automated checks

- With JDK 17 on `PATH`, run `backend/.venv/bin/python -m pytest -q
  backend/tests/test_timezone_contract.py`. This compiles the production Java
  planner and compares all catalog identifiers plus rejected edge cases against
  both Python profile-write models. Backend CI installs the JDK for this check.
- `bash backend/scripts/test-postgres.sh` checks catalog availability and legacy
  profile repair with immutable occurrence snapshots in a disposable database.
- `bash mobile/scripts/verify-reminder-android.sh` tests the packaged catalog,
  unsupported empty/mixed plans, cached snapshots/backlog, durable pauses,
  recovery, receipt counts and owner isolation through the production adapter.
- `cd mobile && npm test && npm run typecheck` checks the actionable status,
  retained opt-in and recovery through the application service.
