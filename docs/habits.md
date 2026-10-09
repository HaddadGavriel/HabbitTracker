# Private habit management

Habit configuration is now integrated with [daily occurrence tracking](occurrences.md).
That guide documents Today/completion/progress, snapshots, and when configuration,
archive/restore, or timezone edits take effect. [Selective sharing](sharing.md)
adds read-only views for explicitly chosen accepted friends. [Occurrence excuses](excuses.md)
add owner explanations and decisions by currently authorized shared friends.
[Owner occurrence history and current streaks](history.md) include archived habits;
shared friends receive streak fields but cannot read full history. Notification
delivery and mobile tracking UI remain deferred. Existing
infrastructure, profiles, and friendships remain available.

All endpoints require a valid Supabase Auth bearer access token **and an existing
profile**. Identity comes from Auth, never a request field. Habits are private by
default; friendship alone gives no access. These existing habit endpoints remain
owner-only even when a separate sharing grant exists. A foreign habit ID and a
nonexistent habit ID produce the same `404 habit_not_found`, including
archive/restore and PATCH. Recipients use `/shared-habits` routes instead.

## Endpoints

Responses are JSON habit objects (GET list returns an array), using the existing
FastAPI response and error conventions.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/habits` | Create; `201` with the server-generated habit |
| GET | `/habits?status=active` | List active habits; `active` is the default |
| GET | `/habits?status=archived` | List archived habits |
| GET | `/habits?status=all` | List all owned habits |
| GET | `/habits/{habit_id}` | Read an owned habit, including archived |
| PATCH | `/habits/{habit_id}` | Partial configuration update; `200` |
| POST | `/habits/{habit_id}/archive` | Archive; `200` |
| POST | `/habits/{habit_id}/restore` | Restore; `200` |

List ordering is **created_at ascending, then UUID id ascending**, independent of
configuration edits and archival. There is no permanent deletion endpoint.

## Configuration and response fields

| Field | Contract |
| --- | --- |
| `name` | Required on create; trimmed, 1–100 characters |
| `description` | Optional string, at most 1,000 characters; defaults to null; explicit null clears |
| `type` | Required on create: `binary` or `target`; immutable |
| `target` | Binary: null/omitted only. Target: required positive JSON integer; booleans, strings, and fractional values rejected |
| `unit` | Optional target-only unit label; trimmed, 1–30 characters when provided; null/omitted means no label |
| `schedule` | Required on create: `daily` or `selected` |
| `weekdays` | Daily: **empty array `[]`** (default on create), never a full-week array or null. Selected: 1–7 distinct ISO integers (`1` Monday … `7` Sunday), returned sorted ascending |
| `reminder_times` | Required on create: nonempty array of distinct strict `HH:MM` strings from `00:00` through `23:59`; returned sorted ascending |
| `id` | Server-generated UUID, stable across all edits, archive, and restore |
| `owner_id` | Authenticated owner's UUID, server-managed |
| `created_at`, `updated_at` | Server-managed UTC timestamps |
| `archived_at` | Server-managed UTC timestamp, or null for an active habit |

Reminder times and weekdays are **local wall-clock settings in the owner's current
profile IANA timezone**. They are not UTC timestamps and do not include offsets or
timezones of their own. Changing the profile timezone changes subsequent occurrences
according to the transition policy; existing occurrences keep their snapshots.
Occurrence deadlines account for daylight-saving transitions. Notification
execution belongs to a future delivery milestone.

Daily schedules with nonempty weekdays and selected schedules with empty weekdays
are contradictory and rejected. Duplicate weekdays/reminders are rejected rather
than silently removed. Binary habits cannot have a non-null target or unit.
Target habits always require a positive integer target.

### PATCH and lifecycle

Omitted fields remain unchanged. Explicit null is allowed only for `description`,
`unit`, and `target`; setting a target habit's target to null is still invalid.
An empty PATCH, any `type` field (even its current value), unknown fields, identity
fields, and server timestamps are rejected. Changing a selected habit to daily
requires `{ "schedule": "daily", "weekdays": [] }` in the same PATCH. Changing daily
to selected requires both the selected schedule and its weekdays.

The backend sends only supplied fields to a database RPC. The RPC locks the owned
row before merging and validating the **resulting** configuration; invalid updates
roll back completely, including `updated_at`. Concurrent PATCH requests preserve
unrelated fields and validate combinations against the latest committed state.
Concurrent writes to the same field are serialized; the later one wins.

Archived habits remain readable but require restoration before configuration
updates (`409 habit_archived`). Archive/restore accept an absent body, null, or an
empty object, and reject configuration or other fields. They are idempotent:
repeated archive preserves the original `archived_at` and `updated_at`; repeated
restore leaves `updated_at` unchanged. Restore clears `archived_at`. Neither
operation changes configuration or IDs.

Archived habits are hidden from sharing recipients, while their grants remain.
Restoring makes those grants usable again if the same friendship still exists.
Removing a friendship or explicitly revoking a grant prevents restoration from
returning access. See [sharing lifecycle rules](sharing.md#lifecycle).

### Errors

| Status | Meaning |
| --- | --- |
| 401 | Missing, invalid, or expired Supabase access token; existing Auth error detail string |
| 404 `profile_not_found` | Create a profile to complete onboarding |
| 404 `habit_not_found` | Habit does not exist or belongs to someone else |
| 409 `habit_archived` | Restore before editing configuration |
| 422 | FastAPI validation errors: invalid UUID/filter/field, unknown body fields, empty PATCH, disallowed null, or immutable type |
| 422 `invalid_habit_configuration` | Database rejects the resulting combination of existing and supplied fields |

Application errors use `{ "detail": { "code": "...", "message": "..." } }`;
request validation uses FastAPI's existing `detail` array. Infrastructure failures
are not disguised as validation or ownership errors.

## PowerShell manual examples

Use the existing Auth/onboarding flow first. Keep real access tokens out of files
and source control. These requests use an already-created profile's timezone.

```powershell
$Api = "http://localhost:8000"
$Headers = @{ Authorization = "Bearer $AccessToken" }

$BinaryBody = @{
  name = "Read before bed"
  type = "binary"
  schedule = "daily"
  weekdays = @()
  reminder_times = @("21:30", "08:00")
} | ConvertTo-Json -Depth 5
$Binary = Invoke-RestMethod -Method Post -Uri "$Api/habits" `
  -Headers $Headers -ContentType "application/json" -Body $BinaryBody

$TargetBody = @{
  name = "Walk"
  description = "Take a walk outdoors"
  type = "target"
  target = 5000
  unit = "steps"
  schedule = "selected"
  weekdays = @(7, 1, 3)
  reminder_times = @("18:00")
} | ConvertTo-Json -Depth 5
$Target = Invoke-RestMethod -Method Post -Uri "$Api/habits" `
  -Headers $Headers -ContentType "application/json" -Body $TargetBody

Invoke-RestMethod -Uri "$Api/habits" -Headers $Headers
Invoke-RestMethod -Uri "$Api/habits/$($Target.id)" -Headers $Headers

$Patch = @{ description = $null; unit = $null; target = 6000 } | ConvertTo-Json
Invoke-RestMethod -Method Patch -Uri "$Api/habits/$($Target.id)" `
  -Headers $Headers -ContentType "application/json" -Body $Patch

Invoke-RestMethod -Method Post -Uri "$Api/habits/$($Binary.id)/archive" -Headers $Headers
Invoke-RestMethod -Uri "$Api/habits?status=archived" -Headers $Headers
Invoke-RestMethod -Method Post -Uri "$Api/habits/$($Binary.id)/restore" -Headers $Headers
```

## Persistence, security, and migration steps

New migration: `supabase/migrations/202610070001_private_habits.sql`, ordered after
`202610060001_friend_request_races.sql` from merged PR #7. Existing migrations are
unchanged. In the normal separately authorized migration workflow, apply all
outstanding migrations in filename order, then run the backend version containing
the habit router. For an existing database with the previous migrations recorded,
apply only the new migration through that workflow; do not reapply old migrations.
No shared database migration or deployment is performed by this implementation.

The `habits` table has UUID identity, an owner FK to `profiles(user_id)` with delete
cascade, canonical JSONB configuration, and server-managed lifecycle columns.
Indexes support owner/list ordering and owner/archive filtering. A check constraint
validates the full configuration and canonical ordering; a trigger preserves ID,
owner, creation time, and type, blocks archived configuration edits, and manages
update timestamps. Account/profile deletion retains the existing FK cascade model;
there is no habit-deletion API.

RLS is enabled without client policies. Explicit table privilege revocation covers
PUBLIC, anon, authenticated, and service_role even under Supabase default grants.
Only six habit RPC entry points grant EXECUTE to service_role. Each SECURITY DEFINER
entry point fixes `search_path = ''`, checks the profile, scopes rows by owner and
habit ID, and fully qualifies database objects. Helpers and entry points explicitly
revoke EXECUTE from PUBLIC, anon, and authenticated; helpers additionally revoke it
from service_role. The backend determines the owner from validated Supabase Auth;
never expose service-role credentials to clients. Modern `sb_secret_` keys remain
in the `apikey` header and are never used as Bearer JWTs.

Occurrences snapshot relevant configuration (including name/type/target/unit,
schedule/reminder settings, and timezone). Configuration and timezone edits
reconcile elapsed dates and materialize today's applicable occurrence first.
Later edits never rewrite existing snapshots, deadlines, or historical progress.
Habit IDs remain stable references. See the occurrence guide for the durable
checkpoint and deterministic timezone transition policy.

## Tests

API and mocked-HTTP adapter tests use dummy Supabase URLs/keys and never access a
shared database. PostgreSQL tests use a disposable PostgreSQL 16 instance and the
existing `backend/tests/postgres_scaffold.sql`, deliberately granting Supabase-style
default table/function privileges so migration revocations are tested. Habit RPCs
are exercised as `service_role`, with direct client table/function access denied.
CI explicitly runs the friendships, habits, occurrences, and sharing PostgreSQL files.

To run locally in PowerShell with Docker and psql installed (local PostgreSQL 16
only; use a fresh container, never a shared database):

```powershell
docker run --name habits-test-pg -e POSTGRES_PASSWORD=postgres `
  -p 127.0.0.1:55432:5432 -d postgres:16
# Wait for this to report accepting connections before continuing:
docker exec habits-test-pg pg_isready -U postgres
$env:PGPASSWORD = "postgres"
psql -h localhost -p 55432 -U postgres -v ON_ERROR_STOP=1 `
  -f backend/tests/postgres_scaffold.sql
Get-ChildItem supabase/migrations/*.sql | Sort-Object Name | ForEach-Object {
  psql -h localhost -p 55432 -U postgres -v ON_ERROR_STOP=1 -f $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "Migration failed" }
}
$env:TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:55432/postgres"
Set-Location backend
python -m pip install -r requirements-dev.txt
python -m pytest -q
python -m pytest -q tests/test_friendships_postgres.py tests/test_habits_postgres.py tests/test_occurrences_postgres.py tests/test_sharing_postgres.py
Set-Location ..
Remove-Item Env:TEST_DATABASE_URL
Remove-Item Env:PGPASSWORD
docker rm -f habits-test-pg
```

The scaffold covers PostgreSQL constraints, privileges, and concurrency; it does not
emulate live Supabase Auth or PostgREST. PowerShell examples are manual walkthroughs.
