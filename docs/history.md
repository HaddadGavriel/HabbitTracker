# Occurrence history and current streaks

Owners can read paginated occurrence history and the current streak for their own
habits, including archived habits. Currently authorized shared friends receive the
same streak fields in shared-habit views. Friends cannot use either owner endpoint,
even when the habit is shared with them. This feature adds no reminders, mobile UI,
longest streak, or advanced analytics.

## HTTP contracts

Every route requires a validated Supabase bearer token and an existing profile.
The backend obtains the acting user exclusively from authentication. Database
time is authoritative; there is no client clock parameter.

| Method | Route | Success |
| --- | --- | --- |
| GET | `/habits/{habit_id}/history` | `200` history page; owner only, including archived habits |
| GET | `/habits/{habit_id}/streak` | `200` current streak; owner only, including archived habits |

History returns:

```json
{
  "habit_id": "8cab1bce-89d6-44ea-9150-e774b49bd148",
  "occurrences": [],
  "next_cursor": null
}
```

An owned habit with no matching occurrences returns that empty page, not a 404.
Each entry contains every [stored occurrence field](occurrences.md#http-contracts):
`id`, `habit_id`, `owner_id`, `local_date`, `timezone`, `closes_at`, `snapshot`,
`progress`, `completed`, `state`, `created_at`, and `updated_at`. The `snapshot`
contains the name, description, type, target, unit, schedule, weekdays, and reminder
times fixed when that occurrence was generated. Later name, target, schedule, or
timezone changes never replace historical snapshots, dates, or deadlines.

Each entry additionally has `excuse: null`, or this compact object:

```json
{
  "id": "cf9d3d83-fb3b-422f-a3a0-2dc9f0b0753c",
  "explanation": "Unable to finish today.",
  "status": "pending",
  "decision_source": null,
  "decided_by": null,
  "decided_at": null,
  "created_at": "2026-10-08T19:00:00Z"
}
```

`status` is `pending`, `approved`, or `rejected`; `decision_source` is null,
`automatic`, or `friend`. `decided_by` is the deciding friend's UUID, or null for
pending and automatic approval. `decided_at` is null while pending and records
the server time for either approval or rejection. The nested object does not
repeat the occurrence or its habit/owner IDs. These explanations and decisions
are absent from shared-habit responses; existing dedicated excuse routes retain
their own current-access rules.

The streak endpoint returns:

```json
{
  "habit_id": "8cab1bce-89d6-44ea-9150-e774b49bd148",
  "current_streak": 2,
  "provisional": true,
  "calculated_at": "2026-10-08T19:15:00Z"
}
```

`calculated_at` is the authoritative database instant used for reconciliation and
calculation. `current_streak` is a nonnegative integer. The streak covers the
habit's entire tracked occurrence sequence; it has no date-range or pagination
parameters and is not limited by any history page.

### History pagination and filters

| Query parameter | Contract |
| --- | --- |
| `limit` | Integer from 1 to 100; default 30 |
| `from_date` | Optional inclusive lower bound, strictly `YYYY-MM-DD` |
| `to_date` | Optional inclusive upper bound, strictly `YYYY-MM-DD` |
| `cursor` | Optional opaque continuation token from `next_cursor` |

Dates filter each occurrence's stored `local_date`. They are never reinterpreted
in the owner's current timezone. Either bound may be omitted. Invalid calendar
dates, alternate date formats, timestamps, reversed ranges, invalid limits, and
malformed cursors return 422.

Rows are ordered newest first by `local_date DESC, id DESC`. Pagination uses this
pair as a keyset boundary, not an offset. `next_cursor` is null when no further
matching row exists. A cursor encodes its habit, date bounds, and last returned
ordering key as opaque base64url data. Clients must return it unchanged and use
the same habit and date filters, including which filters were omitted. Reusing a
cursor for another habit or filter range is rejected with 422; the page size may
change. A cursor never establishes ownership or grants permission.

Each page reconciles and reads in one transaction. Pages are not a frozen
multi-request snapshot: later progress changes or excuse decisions can affect
subsequent reads, and newly generated dates ahead of the cursor appear when
starting again from the first page. The immutable ordering keys make continuation
deterministic without moving existing entries between pages.

### Errors and access

| HTTP | Meaning |
| --- | --- |
| 401 | Existing missing, expired, or invalid bearer-token errors |
| 404 `profile_not_found` | Acting user has not completed onboarding |
| 404 `habit_not_found` | Habit is missing or belongs to another user |
| 422 | Malformed UUID, invalid query value/range, or invalid or incorrectly scoped cursor |

Both owner endpoints return the identical response for missing and foreign habits:
`{"detail":{"code":"habit_not_found","message":"Habit not found"}}`.
An accepted friendship or sharing grant cannot bypass this rule. Ownership is
checked before reconciliation, so an unauthorized read cannot reconcile another
user's occurrences. Archived habits remain available to their owners.

## Exact streak semantics

Order actual scheduled occurrences by stored `local_date`. The **current streak**
is the number of `completed` or `excused` occurrences after the latest `missed`
occurrence. If there is no missed occurrence, consider all tracked occurrences.
Within this segment, ignore `justification_pending` and still-open `in_progress`
occurrences when counting. `provisional` is true exactly when the segment contains
at least one unresolved `justification_pending` occurrence. Pending occurrences
before the latest missed boundary do not make the current streak provisional.

| State | Contribution |
| --- | --- |
| `completed` | Adds one |
| `excused` | Adds one, even though `completed` remains false |
| `missed` | Starts a new segment after itself |
| `justification_pending` | Adds zero; does not break; makes its segment provisional |
| Open `in_progress` | Adds zero; does not break or make the streak provisional |

Zero qualifying occurrences means `current_streak: 0`. A segment containing only
pending occurrences is therefore zero and provisional; a habit with no
occurrences is zero and not provisional. Pending before, between, or after
successful occurrences has the same provisional effect within the segment.

Examples below run from oldest to newest:

| Occurrences | Current streak | Provisional |
| --- | --- | --- |
| completed, pending, completed | 2 | true |
| completed, excused, completed (pending approved) | 3 | false |
| completed, missed, completed (pending rejected) | 1 | false |
| pending, missed, completed | 1 | false |
| completed, pending, pending | 1 | true |
| completed, pending, missed | 0 | false |
| completed, open in_progress Today | 1 | false |
| completed, missed Today after its deadline | 0 | false |

Reconciliation happens before counting. Once an incomplete occurrence reaches
its original `closes_at`, it becomes missed even if no client has visited Today.
An open incomplete Today preserves yesterday's streak. If it closes as missed,
the streak is zero unless later qualifying occurrences exist. Pending excuses
survive midnight and await a decision. A later approval adds its excused occurrence
if it lies in the current segment; a rejection creates a missed boundary and
recomputes from the remaining later occurrences. With multiple pending excuses,
each decision is evaluated against the resulting sequence, not a saved counter.

Before closing, undoing binary completion or reducing target progress below that
occurrence's snapshotted threshold reopens it. It stops contributing one but does
not break earlier successes until it closes as missed. Editing a habit's current
configured target does not change old thresholds or outcomes.

Only actual scheduled occurrences count. Unscheduled weekdays, archived gaps,
and dates skipped by the existing [timezone-transition policy](occurrences.md#timezone-transition-policy)
do not create missed boundaries. Archiving preserves already-created obligations;
those still close normally. Tracking begins at the existing cutover, never at a
habit's earlier creation date, and this feature invents no pre-cutover occurrences.

## Shared views and compatibility

`GET /shared-habits` entries and `GET /shared-habits/{habit_id}` add
`current_streak`, `provisional`, and `calculated_at` at the top level, with the same
semantics as the owner endpoint. Their existing `id` identifies the habit; all
existing fields remain. The streak is available even when no occurrence is due
today. A friend must still have a current sharing grant tied to an accepted
friendship, and the habit must be active. Revocation, friendship removal, and
archival remove subsequent access to the shared streak along with the shared view.
Sharing never exposes full history or excuse explanations in these responses.

Today and existing owner habit, progress, and excuse response contracts are
unchanged. The shared fields are additive; owner clients request the new streak
endpoint explicitly.

## Persistence and concurrency

Streaks are derived from indexed occurrence rows on each read. There is no
increment-only counter, cache, background worker, or stored longest streak.
History uses an index supporting descending habit/date/UUID pagination. The
migration adds these read paths without rewriting applied migrations or snapshots.

Owner reads acquire the existing owner-profile lock, establish ownership, then
reconcile and build the response in the same database transaction. Shared reads
preserve sorted UUID ordering for all participating profile locks, recheck current
access, and reconcile authorized owners before constructing their views. These
locks coordinate with progress changes, excuse decisions, configuration edits,
archival, and sharing/friendship changes. A read serialized before a concurrent
change may return the earlier coherent view; one serialized after it sees the new
state. Already returned responses cannot be retracted after revocation.

RLS and explicit table privilege revocations remain in force for `PUBLIC`, `anon`,
`authenticated`, and `service_role`. Only the intended backend RPC entry points
grant `service_role` execution; internal helpers remain private. SECURITY DEFINER
functions have a fixed empty `search_path` and qualified object references. Clients
cannot query history tables or invoke the backend RPCs directly.

## Migrations and tests

For a separately authorized release, apply all unapplied migrations in filename
order, ending with `supabase/migrations/202610080002_occurrence_history_streaks.sql`.
It follows merged PR #11's `202610080001_occurrence_excuses.sql`. New databases
need the entire sequence; existing databases apply only unapplied files. Do not
edit or reapply recorded migrations. Deploy compatible backend code after the
migration. This implementation does not merge, deploy, or apply migrations to a
shared database.

Use the [disposable PostgreSQL setup](friendships.md#migration-and-tests), which
applies the scaffold and every migration in order. From `backend`, with
`TEST_DATABASE_URL` pointing only to that disposable database:

```powershell
python -m pytest -q
python -m pytest -q tests/test_friendships_postgres.py tests/test_habits_postgres.py tests/test_occurrences_postgres.py tests/test_sharing_postgres.py tests/test_excuses_postgres.py tests/test_history_postgres.py
```

CI's PostgreSQL integration job includes the history/streak service-role suite.
The API and mocked-HTTP adapter suites check request validation and the RPC/response
contract. PostgreSQL tests exercise reconciliation, snapshots, permissions,
provisional decisions, pagination, lifecycle/timezone boundaries, concurrency,
and direct client access restrictions. Without `TEST_DATABASE_URL`, PostgreSQL
tests skip, which is not integration verification. The scaffold exercises real
PostgreSQL but does not emulate live Supabase Auth, PostgREST, or deployment.
Actual run counts and CI status belong in the PR validation report; the following
walkthrough requires a compatible running backend and real authenticated users.

## PowerShell walkthrough

Use the [README onboarding flow](../README.md#test-profiles-with-two-existing-auth-users-powershell)
to obtain `$Token1` and `$Token2`. Set `$HabitId` to a habit owned by User 1.
Do not commit tokens or credentials.

```powershell
$ApiUrl = "http://127.0.0.1:8000"
$Headers1 = @{ Authorization = "Bearer $Token1" }
$Headers2 = @{ Authorization = "Bearer $Token2" }
$HabitId = "YOUR_HABIT_UUID"

# Owner streak, including while archived.
Invoke-RestMethod -Uri "$ApiUrl/habits/$HabitId/streak" -Headers $Headers1

# Newest first. Use exactly the same filters when following next_cursor.
$HistoryUri = "$ApiUrl/habits/$HabitId/history?limit=30&from_date=2026-10-01&to_date=2026-10-31"
$Page = Invoke-RestMethod -Uri $HistoryUri -Headers $Headers1
$Page.occurrences | ConvertTo-Json -Depth 8
while ($null -ne $Page.next_cursor) {
    $Cursor = [uri]::EscapeDataString($Page.next_cursor)
    $Page = Invoke-RestMethod -Uri "$HistoryUri&cursor=$Cursor" -Headers $Headers1
    $Page.occurrences | ConvertTo-Json -Depth 8
}

# Shared permission is required and the habit must be active.
# Returns current_streak/provisional/calculated_at, without history/explanations.
Invoke-RestMethod -Uri "$ApiUrl/shared-habits/$HabitId" -Headers $Headers2

# User 2's history and owner-streak calls return identical habit_not_found 404s,
# even while the habit is shared with them.
Invoke-RestMethod -Uri "$ApiUrl/habits/$HabitId/history" -Headers $Headers2
Invoke-RestMethod -Uri "$ApiUrl/habits/$HabitId/streak" -Headers $Headers2

# Each example below returns 422.
Invoke-RestMethod -Uri "$ApiUrl/habits/$HabitId/history?limit=101" -Headers $Headers1
Invoke-RestMethod -Uri "$ApiUrl/habits/$HabitId/history?from_date=2026-02-30" -Headers $Headers1
Invoke-RestMethod -Uri "$ApiUrl/habits/$HabitId/history?from_date=2026-10-31&to_date=2026-10-01" -Headers $Headers1
Invoke-RestMethod -Uri "$ApiUrl/habits/$HabitId/history?cursor=not-a-cursor" -Headers $Headers1
```

For late-decision verification, use the [excuse walkthrough](excuses.md#powershell-two-user-walkthrough),
retain a pending excuse, and query the owner's streak before and after an
authorized friend decision. Approval changes that occurrence to excused; rejection
changes it to missed. Earlier pending decisions do not affect a segment after a
later missed boundary. For midnight verification, retain an open occurrence and
read after its actual `closes_at`; the production API has no clock override.
