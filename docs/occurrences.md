# Daily habit tracking

Backend milestone 5 adds durable scheduled occurrences, Today, binary completion,
and integer target progress. Profiles, private habit configuration, friendships,
and archive/restore remain available. Friends cannot view or modify occurrences.
Sharing, excuses, streaks, notification delivery, mobile UI, and a history endpoint
are deferred.

## HTTP contracts

All routes require a valid Supabase Auth bearer token and an existing profile.
Owner identity comes exclusively from Auth. The API accepts neither dates nor
status, owner IDs, deadlines, timezone overrides, or test clocks in mutation bodies.
Extra body fields are rejected. Database time is authoritative.

| Method | Route | Body / headers | Response |
| --- | --- | --- | --- |
| GET | `/today` | None | `200` Today object |
| PUT | `/occurrences/{id}/completion` | `{"completed":true}` or `false` | `200` occurrence; binary only |
| PUT | `/occurrences/{id}/progress` | `{"progress":12}` | `200` occurrence; target only |
| POST | `/occurrences/{id}/progress-adjustments` | `{"delta":-2}` and `Idempotency-Key` header | `200` occurrence; target only |

Today returns `local_date` (YYYY-MM-DD in the current profile timezone), `timezone`
(IANA name), `server_time` (UTC RFC 3339), and `occurrences` (array ordered by
habit UUID then occurrence UUID). It includes completed occurrences and today's
already-due occurrences from archived habits. It excludes unscheduled habits.
A retained occurrence whose deadline has passed after a timezone change can appear
as missed. An empty array is valid. There is no arbitrary date filter.

Each occurrence contains:

| Field | Meaning |
| --- | --- |
| `id` | Stable occurrence UUID |
| `habit_id`, `owner_id` | Stable habit and owning profile UUIDs |
| `local_date` | Scheduled owner-local date at generation |
| `timezone` | Timezone snapshot at generation |
| `closes_at` | Following local midnight converted to UTC, including DST |
| `snapshot` | Habit configuration object: name, description, immutable type, target, unit, schedule, ISO weekdays, reminder times |
| `progress` | Nonnegative integer; binary always zero |
| `completed` | Binary explicit flag; target derived from progress >= snapshotted target |
| `state` | `in_progress`, `completed`, or `missed` |
| `created_at`, `updated_at` | Server timestamps |

Snapshots, IDs, dates, and deadlines never change. Reminder times are stored only;
no notification is delivered. Configuration/profile edits cannot rewrite progress.
An occurrence begins in_progress, binary incomplete or target zero. At or after
closes_at, incomplete becomes missed and completed stays completed. There is no
grace period. Before closing, undo or reducing target progress below its snapshot
target reopens the occurrence. Progress may exceed the target; it is not capped.

Progress and delta accept JSON integers only, including zero. Booleans, decimal
numbers (including `1.0`), fractions, strings, null, and missing fields are rejected.
Negative absolute progress and deltas that would reduce progress below zero are
rejected without changing progress. Existing large integer targets remain supported.

Absolute PUT assignments are safe to retry: repeated assignments cannot accumulate
progress. An assignment may refresh updated_at. A retry after the deadline is
rejected, even when the assigned value matches.

Delta keys must contain 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`.
Keys are scoped to one occurrence. Use a new key for each intended adjustment.
The first successful adjustment and its response are stored atomically. Repeating
the same key and delta returns the original response, even if later mutations or
closure have changed the occurrence; it performs no new edit. A different delta
with that key returns `409 idempotency_conflict`. Rejected adjustments do not
consume a key. The replay response can therefore be older than Today.

## Errors

Domain errors follow existing `{"detail":{"code":"...","message":"..."}}`
format. FastAPI request validation uses its usual `422 detail` array.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | Existing authentication errors | Missing/expired/invalid token |
| 404 | `profile_not_found` | Create a profile first |
| 404 | `occurrence_not_found` | Missing occurrence or occurrence owned by anyone else; identical response |
| 409 | `wrong_occurrence_type` | Binary operation on target or progress operation on binary |
| 409 | `occurrence_closed` | Deadline reached; no owner edits |
| 409 | `idempotency_conflict` | Key already succeeded with another delta |
| 422 | `negative_progress` | Adjustment would reduce progress below zero |
| 422 | `invalid_occurrence_value` | Invalid database operation/value (HTTP validation normally catches this) |
| 422 | `invalid_idempotency_key` | Invalid key (HTTP validation normally catches this) |

## Durable reconciliation and lifecycle

PostgreSQL enforces one occurrence per habit/local date. Daily habits schedule every
date; selected habits use ISO weekdays (Monday 1 through Sunday 7). A newly created
habit immediately materializes today if scheduled. Nothing is generated before
tracking begins or for archived dates.

Each habit has a private persisted cursor: next unprocessed date, timezone, and
eligibility floor. Reconciliation generates all due scheduled dates through today,
advances the cursor even over unscheduled/archived days, and closes expired
incomplete occurrences. Inserts are idempotent and uniqueness is enforced by the
database. Multi-day inactivity generates missed days on the next relevant call.
No in-process timer is needed. Physical closure is lazy; the closing instant makes
edits illegal immediately, even before a later read persists missed state.

Today, occurrence mutations, and all habit reads/mutations reconcile first. Every
habit configuration/lifecycle change reconciles under the old values within its
own transaction, before the new values are stored. Today’s schedule decision and
applicable snapshot are therefore fixed before an edit, even without a previous
Today request. Changes apply from the next unprocessed date. Turning an unscheduled
today into a scheduled day does not create a new obligation today.

The cursor is a durable checkpoint, not an unrecorded scheduling assumption:
configuration cannot change while any elapsed unprocessed dates still depend on
it. This is why this implementation does not need a separate revision log. Past
due dates have snapshots; skipped dates are durably consumed. Configuration,
archive/restore, cursor updates, and generation all commit or roll back together.

Archiving reconciles first, keeps today's due occurrence/deadline/progress, and
stops subsequent occurrences. Restoring reconciles the archived interval without
generating it, then may materialize scheduled today if absent and above the
eligibility floor. Same-day archive/restore does not duplicate or reset progress.

### Timezone transition policy

A profile timezone change takes the same owner lock and reconciles elapsed days
and today in the old timezone first. Existing occurrence dates/deadlines remain
unchanged. For every habit, the new cursor and eligibility floor become
`max(old next unprocessed date, current date in new timezone)`. Reconciliation
then uses the new timezone.

If the new zone has advanced to tomorrow, that date can be generated immediately;
dates jumped over are never invented as retroactive missed days. If the new zone
is on the same date or an earlier date, tracking waits until the cursor date is
reached. Restore honors that floor too. Repeated timezone changes advance the
watermark, never rewind it. The unique habit/date key still prevents duplicates.
Today uses the current profile date, so it can temporarily be empty while an
already-created occurrence for a different local date remains editable by UUID
until its original deadline. This deliberately favors stable obligations over
reinterpreting travel as missed days.

### Atomicity and access

Backend RPCs lock the owning profile first and hold that lock through commit,
before any habit or occurrence row locks. Profile PATCH already locks that same
row; timezone triggers reconcile within it. This serializes reconciliation,
configuration/lifecycle edits, and progress mutations for one owner consistently,
avoiding lost increments and duplicate concurrent generation. Different owners
can proceed independently. No habit configuration/lifecycle writes are allowed
directly to client or service-role table access; use the existing RPCs.

All new tables have RLS with no client policies and explicit privilege revocations
for PUBLIC, anon, authenticated, and service_role, including default Supabase
grants. Only get_today and mutate_occurrence entry points grant service_role
EXECUTE; helpers are private. SECURITY DEFINER entry points and timezone triggers
fix search_path to empty and qualify objects. Ownership is checked in PostgreSQL
as well as supplied only from authenticated backend identity. Constraints and
triggers enforce ownership, uniqueness, snapshots, progress, and legal closure.
The backend secret key stays in the apikey header, never in client code.

Production occurrence_now wraps database clock_timestamp. There is no test-clock
parameter or session-setting override. Disposable tests replace this function as
the database administrator and read a private test schema; client and service_role
roles cannot call/replace the clock or access that schema.

## Migrations and testing

Apply the new ordered migration `202610070002_daily_occurrences.sql` after merged
PR #8's private habits migration, through a separately authorized deployment
workflow. Previously applied migrations are unchanged. Deploy compatible backend
code after the new migration; legacy habit/profile routes also use its triggers.
No shared database migration, deployment, or merge is part of this PR.

Existing habits begin tracking at their owner-local date when the migration runs,
not at their earlier created_at. Active habits can acquire that cutover day's
occurrence on first reconciliation; archived habits start without an obligation
until restored. Migration statement time fixes the boundary for all existing rows.
Do not seed earlier occurrences. Test fresh migration and existing-habit cutover
before applying to a shared instance.

Use the disposable PostgreSQL setup in [habits.md](habits.md), apply all migrations
in order, and run `python -m pytest -q` from backend with TEST_DATABASE_URL set.
CI's postgres-integration job explicitly runs test_occurrences_postgres.py along
with the existing friendships/habits integration suites, so these tests are not
merely skipped in the unit job. Tests cover local/UTC dates, both DST day lengths,
exact deadlines, inactivity, snapshots, archive gaps, timezone transitions,
concurrent generation/increments/retries/edits, migration cutover, and privileges.
Live Supabase Auth/PostgREST and PowerShell examples require manual verification.

## PowerShell walkthrough

Use existing onboarding and habit endpoints. `$base` is the backend URL and
`$accessToken` is a valid owner's Supabase access token. Example creation bodies
include the required reminder settings; no reminders are delivered.

```powershell
$headers = @{ Authorization = "Bearer $accessToken" }
$binaryBody = @{
  name = "Stretch"; type = "binary"; schedule = "daily"
  reminder_times = @("08:00")
} | ConvertTo-Json
$binary = Invoke-RestMethod -Method Post -Uri "$base/habits" `
  -Headers $headers -ContentType "application/json" -Body $binaryBody
$today = Invoke-RestMethod -Uri "$base/today" -Headers $headers
$binaryOccurrence = $today.occurrences | Where-Object habit_id -EQ $binary.id
Invoke-RestMethod -Method Put `
  -Uri "$base/occurrences/$($binaryOccurrence.id)/completion" `
  -Headers $headers -ContentType "application/json" -Body '{"completed":true}'
# Undo before the original closing instant:
Invoke-RestMethod -Method Put `
  -Uri "$base/occurrences/$($binaryOccurrence.id)/completion" `
  -Headers $headers -ContentType "application/json" -Body '{"completed":false}'

$targetBody = @{
  name = "Read"; type = "target"; target = 10; unit = "pages"
  schedule = "daily"; reminder_times = @("21:00")
} | ConvertTo-Json
$target = Invoke-RestMethod -Method Post -Uri "$base/habits" `
  -Headers $headers -ContentType "application/json" -Body $targetBody
$today = Invoke-RestMethod -Uri "$base/today" -Headers $headers
$targetOccurrence = $today.occurrences | Where-Object habit_id -EQ $target.id
Invoke-RestMethod -Method Put -Uri "$base/occurrences/$($targetOccurrence.id)/progress" `
  -Headers $headers -ContentType "application/json" -Body '{"progress":8}'
$adjustHeaders = @{ Authorization = "Bearer $accessToken"; "Idempotency-Key" = [guid]::NewGuid().ToString() }
$adjustUri = "$base/occurrences/$($targetOccurrence.id)/progress-adjustments"
# Reuse these exact headers and body for a network retry:
Invoke-RestMethod -Method Post -Uri $adjustUri -Headers $adjustHeaders `
  -ContentType "application/json" -Body '{"delta":2}'
# A distinct intended decrement needs a new key:
$adjustHeaders["Idempotency-Key"] = [guid]::NewGuid().ToString()
Invoke-RestMethod -Method Post -Uri $adjustUri -Headers $adjustHeaders `
  -ContentType "application/json" -Body '{"delta":-1}'
```
