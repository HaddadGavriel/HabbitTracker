# Selective habit sharing

Owners can share individual habits with selected accepted friends. Habits are
private by default: an accepted friendship alone gives no access. All sharing
routes require a Supabase bearer token validated by FastAPI and an existing
profile. The backend derives the acting user from Auth; clients cannot choose it.

Recipients have read access through `/shared-habits`. Existing `/habits`,
`/today`, and normal completion/progress endpoints retain their owner-only behavior.
A grant does not allow a recipient to edit, archive, restore, complete, undo, or
change progress. A currently authorized friend can also read and decide an
[occurrence excuse](excuses.md) through its dedicated endpoints. Streak fields,
general history endpoints, notifications, and mobile changes remain deferred.

## Endpoints and errors

| Method | Route | Success |
| --- | --- | --- |
| PUT | `/habits/{habit_id}/shares/{friend_user_id}` | `200` recipient public identity; owner only, requires an accepted friendship |
| DELETE | `/habits/{habit_id}/shares/{friend_user_id}` | `204`; owner only, including when no grant exists |
| GET | `/habits/{habit_id}/shares` | `200` array of granted recipients' public identities; owner only |
| GET | `/shared-habits` | `200` array of currently accessible active habits for the authenticated recipient |
| GET | `/shared-habits/{habit_id}` | `200` one currently accessible active habit |

Owner grant lists are ordered by current recipient username, then user UUID.
Shared habit lists are ordered by owner UUID, then habit creation time and UUID.
Empty lists are valid.

PUT and DELETE take no body; JSON null or an empty object is also accepted.
Unknown body fields, including `user_id`, `owner_id`, and `recipient_id`, are
rejected. The path's `friend_user_id` identifies the intended recipient, never
the acting user. Repeating a successful grant returns the same recipient without
duplicating the grant. Repeating a revoke succeeds even if the relationship or
grant has since disappeared. Both operations check habit ownership on every call.
Granting to oneself is rejected. Owners may manage grants while a habit is archived.

Public identity objects contain exactly `user_id`, `username`, and `display_name`,
resolved from the current profile. Sharing responses never expose email, Auth
metadata, profile timestamps, or other unrelated profile data.

Application errors use `{"detail":{"code":"...","message":"..."}}`.
Request validation uses FastAPI's usual `422 detail` array.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | Existing authentication errors | Missing, expired, or invalid bearer token |
| 404 | `profile_not_found` | Acting user has not completed onboarding or their profile was deleted |
| 404 | `habit_not_found` | Habit is absent or inaccessible to this caller |
| 409 | `friendship_required` | Grant recipient is not a currently accepted friend; pending requests do not qualify |
| 422 | `self_share` | Owner attempted to share with themselves |
| 422 | Request validation | Malformed UUID, nonempty mutation body, or other invalid input |

Every absent or inaccessible habit uses the identical response
`{"detail":{"code":"habit_not_found","message":"Habit not found"}}`.
On owner routes, another person's habit is inaccessible even if shared with the
caller. On shared-detail routes, private, revoked, unshared, and archived habits
are inaccessible. Owners use their existing habit endpoints to read their own
habits; self-sharing is not an alternative access path.

## Shared response fields

List entries and detail responses have the same shape:

| Field | Meaning |
| --- | --- |
| `id` | Stable habit UUID |
| `owner` | Public identity: `user_id`, `username`, `display_name` |
| `configuration` | Current habit configuration: `name`, `description`, `type`, `target`, `unit`, `schedule`, `weekdays`, `reminder_times` |
| `local_date` | Today's date (`YYYY-MM-DD`) in the owner's current profile timezone |
| `timezone` | Owner's current IANA timezone; the recipient's timezone is irrelevant |
| `server_time` | Authoritative server instant used for this view |
| `due_today` | Whether an occurrence exists for this owner-local date under the occurrence reconciliation policy |
| `occurrence` | Today's occurrence below, or null when `due_today` is false |

An occurrence contains exactly:

| Field | Meaning |
| --- | --- |
| `id` | Stable occurrence UUID |
| `local_date` | Scheduled owner-local date at generation |
| `timezone` | Timezone snapshot at generation |
| `closes_at` | Original deadline: following local midnight converted to UTC, accounting for DST |
| `snapshot` | Configuration at generation, with the same fields as `configuration` |
| `progress` | Nonnegative integer; binary occurrences always use zero |
| `completed` | Binary explicit completion, or target progress at least the snapshotted target |
| `state` | `in_progress`, `completed`, `missed`, `justification_pending`, or `excused` |

`configuration` and `occurrence.snapshot` are intentionally distinct. For example,
after the owner changes a target from 10 pages to 20, today's occurrence can still
have `snapshot.target: 10`, `progress: 10`, and `completed: true`, while
`configuration.target` is 20. A reader must evaluate today's progress against the
snapshot, never the current target. Name, schedule, unit, and reminder settings
can similarly differ after edits. Reminder settings do not trigger delivery.
Pending and excused occurrences retain their original progress and
`completed: false`; excuses never count as ordinary completion in this response.
Shared lists and Today do not include explanations or decision metadata. Read
those through the dedicated excuse endpoint when currently authorized.

Shared views follow the existing [owner-timezone and reconciliation policies](occurrences.md).
An authorized read reconciles stale occurrences before returning status, including
closing overdue in_progress occurrences and generating due dates after inactivity.
Pending and excused occurrences survive midnight unchanged. A rejection produces
final missed state, including when the friend decides before midnight.
Unauthorized reads do not reconcile another owner's data. Each shared list item
uses its own owner's Today; the list can contain different local dates/timezones.

An unscheduled day returns the active shared habit with `due_today: false` and
`occurrence: null`. Schedule edits cannot create a new obligation for an already
processed unscheduled today. Timezone transitions can also temporarily leave no
occurrence for the owner's current local date. Existing occurrence dates,
timezones, deadlines, snapshots, and progress remain unchanged by travel or edits.

## Lifecycle

Explicit revocation removes access for subsequent requests. A request that
serialized before revocation can finish with the previously authorized view;
revocation does not retract an already returned response.
It also removes excuse read/decision access and pending-list membership on
subsequent requests. Newly granted accepted friends may decide an existing pending
excuse; recipients are checked at request time, not frozen when it was submitted.

Removing a friendship atomically deletes every grant tied to that relationship
in both directions. Re-establishing friendship creates a new relationship and
does not restore old grants. Owners must explicitly share again.
Excuses are retained. Losing every eligible friend does not approve, reject, or
erase a pending excuse; it remains pending until the owner restores valid sharing
and an authorized friend decides.

Archived habits disappear from recipient lists and return `404 habit_not_found`
through shared detail. Existing grants remain while archived, and owners can
still list, grant, or revoke them. Restoration makes retained grants usable again
only if the original friendship still exists. Removing friendship while archived
permanently deletes those grants too. The owner's Today may still retain an
already-due occurrence from an archived habit; recipients cannot view it through
the archived habit's shared view.
Pending excuses likewise survive archival, but recipients cannot read or decide
them while the habit is archived. Owners may inspect them. After restoration,
currently valid recipients can decide even if the occurrence's deadline passed.

When a profile or Auth account deletion can commit, related grants are removed
through foreign-key cascades, whether the deleted user owned or received the
share. Retained excuse decisions can [restrict deciding-profile deletion](excuses.md#persistence-and-concurrency).
This milestone does not add profile, account, or permanent habit deletion endpoints.

## Database and concurrency

`habit_shares` enforces one grant per habit/recipient and relates each grant to the
habit owner, recipient profile, and specific friendship relationship row. Indexed
foreign keys support recipient lookup and lifecycle cleanup. Friendship deletion
cascades grants within the same transaction; a replacement relationship cannot
resurrect them.

Sharing and friendship removal acquire participating profile locks in UUID order
before row locks, coordinating with the existing owner-profile reconciliation,
configuration, archive, timezone, progress, and excuse-decision locks. Multi-owner shared lists
acquire their candidate profile locks in the same order. Access is rechecked
under these locks before reconciliation and response construction. Granting
checks habit ownership and accepted friendship atomically. Grant/removal,
revoke/read, and archive/read races therefore follow transaction ordering rather
than relying on an earlier HTTP authorization check.

A list discovers candidate owners before taking those locks, then rechecks the
complete accessible owner set. If a new owner became accessible during that gap,
it releases the attempt's locks and retries discovery and sorted locking before
any reconciliation. It never acquires another owner lock out of order while
building its response. Friend request sending also takes its existing profile
key-share locks in UUID order.

The table has RLS enabled without client policies and explicit privilege
revocations for `PUBLIC`, `anon`, `authenticated`, and `service_role`. Only the
intended sharing RPC entry points are executable by `service_role`; helpers are
private. SECURITY DEFINER functions use a fixed empty `search_path` and qualified
objects. Client roles cannot access grants or invoke backend RPCs directly.
Service credentials stay on the backend, and FastAPI supplies the validated actor
to each RPC. No client-supplied acting-user ID is trusted.

## Migration and tests

Apply `supabase/migrations/202610070004_selective_habit_sharing.sql` after the
occurrence and deadline migrations from merged PR #9. Preserve all existing
migration files and apply every unapplied
file in filename order only through a separately authorized infrastructure release.
The later [excuse migration](excuses.md#migrations-and-testing) extends these
permissions with dedicated friend decisions.
This implementation does not merge, deploy, or apply migrations to a shared database.

The suite includes API dependency tests, mocked HTTP adapter tests, and disposable
PostgreSQL tests invoking real RPCs as `service_role`. Tests cover selective access,
identity filtering, lifecycle cleanup, owner-local Today and snapshots, stale
reconciliation, privilege denial, and concurrent permission changes. CI's
`postgres-integration` job explicitly includes `tests/test_sharing_postgres.py`
alongside the existing integration files.

Use the [disposable PostgreSQL setup](friendships.md#migration-and-tests), apply
the scaffold and all migrations, then run from `backend`:

```powershell
# With TEST_DATABASE_URL pointing only to the disposable local database:
python -m pytest -q
python -m pytest -q tests/test_friendships_postgres.py tests/test_habits_postgres.py tests/test_occurrences_postgres.py tests/test_sharing_postgres.py tests/test_excuses_postgres.py
```

Without `TEST_DATABASE_URL`, PostgreSQL tests skip; this is not database
verification. The scaffold checks PostgreSQL behavior and privileges but does not
emulate live Supabase Auth, PostgREST, or deployment configuration. The walkthrough
below requires manual verification against a compatible backend and is not proof
that a live environment has been upgraded. Actual run results and remaining
verification limits belong in the PR validation report.

## PowerShell two-user walkthrough

Use the [README sign-in and onboarding flow](../README.md#test-profiles-with-two-existing-auth-users-powershell)
to obtain `$Token1` and `$Token2` and create two distinct profiles. Run against
your local backend or an already-upgraded test environment; do not put tokens in
source control. This example assumes the two users are not already friends.

```powershell
$ApiUrl = "http://127.0.0.1:8000"
$Headers1 = @{ Authorization = "Bearer $Token1"; "Content-Type" = "application/json" }
$Headers2 = @{ Authorization = "Bearer $Token2"; "Content-Type" = "application/json" }
$User1 = Invoke-RestMethod -Uri "$ApiUrl/profiles/me" -Headers $Headers1
$User2 = Invoke-RestMethod -Uri "$ApiUrl/profiles/me" -Headers $Headers2
Invoke-RestMethod -Method Patch -Uri "$ApiUrl/profiles/me" -Headers $Headers1 `
  -Body '{"timezone":"Asia/Jerusalem"}'
Invoke-RestMethod -Method Patch -Uri "$ApiUrl/profiles/me" -Headers $Headers2 `
  -Body '{"timezone":"Pacific/Honolulu"}'

function Assert-ApiError($Method, $Uri, $Headers, $Status, $Code, $Body = $null) {
  try {
    $Arguments = @{ Method = $Method; Uri = $Uri; Headers = $Headers; ErrorAction = "Stop" }
    if ($null -ne $Body) { $Arguments.Body = $Body }
    Invoke-RestMethod @Arguments | Out-Null
    throw "Expected HTTP $Status with $Code"
  } catch {
    if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne $Status) { throw }
    $Payload = $_.ErrorDetails.Message | ConvertFrom-Json
    if ($Payload.detail.code -ne $Code) { throw }
  }
}

$Habit = Invoke-RestMethod -Method Post -Uri "$ApiUrl/habits" -Headers $Headers1 `
  -Body '{"name":"Read","type":"target","target":10,"unit":"pages","schedule":"daily","reminder_times":["21:00"]}'
$ShareUri = "$ApiUrl/habits/$($Habit.id)/shares/$($User2.user_id)"
$SharedUri = "$ApiUrl/shared-habits/$($Habit.id)"
# Private by default, including while a friendship request is pending.
Assert-ApiError Get $SharedUri $Headers2 404 "habit_not_found"
$Pending = Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests" -Headers $Headers1 `
  -Body (@{ recipient_user_id = $User2.user_id } | ConvertTo-Json)
Assert-ApiError Put $ShareUri $Headers1 409 "friendship_required"
Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests/$($Pending.id)/accept" -Headers $Headers2
Assert-ApiError Get $SharedUri $Headers2 404 "habit_not_found"

# Both grants return only user_id, username, display_name; there is one grant.
Invoke-RestMethod -Method Put -Uri $ShareUri -Headers $Headers1
Invoke-RestMethod -Method Put -Uri $ShareUri -Headers $Headers1
Invoke-RestMethod -Uri "$ApiUrl/habits/$($Habit.id)/shares" -Headers $Headers1
Invoke-RestMethod -Uri "$ApiUrl/shared-habits" -Headers $Headers2
$View = Invoke-RestMethod -Uri $SharedUri -Headers $Headers2
$View | ConvertTo-Json -Depth 8
# timezone/local_date use Asia/Jerusalem, regardless of User 2's timezone.

# Only the owner changes progress. Run before the occurrence's closes_at.
Invoke-RestMethod -Method Put -Uri "$ApiUrl/occurrences/$($View.occurrence.id)/progress" `
  -Headers $Headers1 -Body '{"progress":10}'
Invoke-RestMethod -Method Patch -Uri "$ApiUrl/habits/$($Habit.id)" `
  -Headers $Headers1 -Body '{"target":20}'
$Edited = Invoke-RestMethod -Uri $SharedUri -Headers $Headers2
# configuration.target = 20; occurrence.snapshot.target = 10; completed = true.
$Edited | ConvertTo-Json -Depth 8
Assert-ApiError Patch "$ApiUrl/habits/$($Habit.id)" $Headers2 404 "habit_not_found" '{"target":30}'
Assert-ApiError Put "$ApiUrl/occurrences/$($View.occurrence.id)/progress" $Headers2 404 "occurrence_not_found" '{"progress":11}'
Assert-ApiError Put "$ApiUrl/habits/$($Habit.id)/shares/$($User1.user_id)" $Headers1 422 "self_share"

# Archive hides the shared view; restore retains access and today's snapshot.
Invoke-RestMethod -Method Post -Uri "$ApiUrl/habits/$($Habit.id)/archive" -Headers $Headers1
Assert-ApiError Get $SharedUri $Headers2 404 "habit_not_found"
Invoke-RestMethod -Method Post -Uri "$ApiUrl/habits/$($Habit.id)/restore" -Headers $Headers1
Invoke-RestMethod -Uri $SharedUri -Headers $Headers2

# Revoke is idempotent, and subsequent reads are denied. Explicitly share again.
Invoke-RestMethod -Method Delete -Uri $ShareUri -Headers $Headers1
Invoke-RestMethod -Method Delete -Uri $ShareUri -Headers $Headers1
Assert-ApiError Get $SharedUri $Headers2 404 "habit_not_found"
Invoke-RestMethod -Method Put -Uri $ShareUri -Headers $Headers1

# Create a grant in the reverse direction too.
$OtherHabit = Invoke-RestMethod -Method Post -Uri "$ApiUrl/habits" -Headers $Headers2 `
  -Body '{"name":"Stretch","type":"binary","schedule":"daily","reminder_times":["08:00"]}'
Invoke-RestMethod -Method Put -Uri "$ApiUrl/habits/$($OtherHabit.id)/shares/$($User1.user_id)" -Headers $Headers2
Invoke-RestMethod -Method Delete -Uri "$ApiUrl/friends/$($User2.user_id)" -Headers $Headers1
Assert-ApiError Get $SharedUri $Headers2 404 "habit_not_found"
Assert-ApiError Get "$ApiUrl/shared-habits/$($OtherHabit.id)" $Headers1 404 "habit_not_found"

# Re-friending restores neither grant. Owners must explicitly grant again.
$Again = Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests" -Headers $Headers1 `
  -Body (@{ recipient_user_id = $User2.user_id } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests/$($Again.id)/accept" -Headers $Headers2
Assert-ApiError Get $SharedUri $Headers2 404 "habit_not_found"
Assert-ApiError Get "$ApiUrl/shared-habits/$($OtherHabit.id)" $Headers1 404 "habit_not_found"
```

For an unscheduled-day check, create a selected-weekday habit that excludes the
owner's current weekday, grant it, then confirm it remains in `/shared-habits`
with `due_today: false` and `occurrence: null`. Do not derive the weekday from the
recipient's computer clock. Backend tests use a private disposable-database clock
to exercise inactivity and date boundaries; the production API has no clock override.
