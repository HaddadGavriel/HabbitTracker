# Occurrence excuses and friend decisions

An owner may explain an incomplete occurrence before its snapshotted deadline.
If the habit has no valid sharing recipients, the submission automatically
approves. Otherwise it waits for any currently authorized shared friend to
approve or reject. Submission permanently locks normal completion/progress for
that occurrence. This backend milestone adds no streak calculation, general
history endpoint, notifications, or mobile UI.

## HTTP contracts

Every route requires a validated Supabase bearer token and an existing profile.
The acting user comes only from authentication. UUID paths identify resources,
never the acting user. Unknown body fields are rejected.

| Method | Route | Body | Success |
| --- | --- | --- | --- |
| POST | `/occurrences/{occurrence_id}/excuse` | `{"explanation":"I am recovering from an injury."}` | `201` excuse; owner only |
| GET | `/occurrences/{occurrence_id}/excuse` | None | `200` excuse; owner or currently authorized shared friend |
| GET | `/excuses/pending` | None | `200` array of currently actionable friend decisions |
| POST | `/excuses/{excuse_id}/decision` | `{"decision":"approve"}` or `{"decision":"reject"}` | `200` final excuse; currently authorized shared friend only |

The pending list includes older occurrence dates and orders globally by excuse
`created_at` ascending, then excuse UUID ascending. It excludes the caller's own
submissions, decided excuses, archived habits, and inaccessible habits. An empty
array is valid. Owners inspect individual submissions using the occurrence UUID;
there is no general history/list endpoint for owner submissions.

Explanation must be a JSON string. Leading and trailing Unicode whitespace is
removed using Python `str.strip()` semantics; the stored result must have 1–1,000
Unicode code points. Blank strings, numbers, booleans, null, missing explanation,
NUL characters, and unpaired Unicode surrogates are rejected. NUL and unpaired
surrogates cannot be stored as PostgreSQL text. Submission accepts no owner,
friend, decision, status, timestamp, clock, or other extra field. Decision accepts
only the exact lower-case value `approve` or `reject` and no extra fields.

Each success returns this shape; the nested occurrence uses the full
[occurrence response schema](occurrences.md#http-contracts):

| Field | Meaning |
| --- | --- |
| `id` | Stable excuse UUID; use this for decisions |
| `occurrence_id`, `habit_id`, `owner_id` | Associated occurrence, habit, and owning profile UUIDs |
| `explanation` | Trimmed explanation, preserved after any decision |
| `status` | `pending`, `approved`, or `rejected` |
| `decision_source` | null while pending; `automatic` for an unshared approval; `friend` for a friend decision |
| `decided_by` | Deciding friend's user UUID, or null for pending and automatic approval |
| `decided_at` | Server decision timestamp, or null while pending |
| `created_at` | Server submission timestamp |
| `occurrence` | Current occurrence, including preserved progress/snapshots and its current state |

An automatic approval records a real server decision timestamp and never invents
a deciding friend. Explanations and decision metadata appear only in these
dedicated excuse responses, not unrelated profile, habit, Today, or shared lists.

## Errors

Domain errors use `{"detail":{"code":"...","message":"..."}}`.
Request validation uses FastAPI's usual `422 detail` array.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | Existing authentication errors | Missing, expired, or invalid bearer token |
| 404 | `profile_not_found` | Acting user has not completed onboarding or their profile was deleted |
| 404 | `occurrence_not_found` | Submission occurrence is absent or is not owned by the caller |
| 404 | `excuse_not_found` | Excuse read/decision is missing or inaccessible, including an owner's attempt to decide |
| 409 | `occurrence_closed` | Submission is at or after the original `closes_at` |
| 409 | `occurrence_not_in_progress` | Submission occurrence is already completed, missed, pending, or excused |
| 409 | `excuse_exists` | An excuse already exists for this occurrence; retry does not create another |
| 409 | `excuse_already_decided` | A currently authorized friend attempted a second decision |
| 409 | `occurrence_locked` | Normal completion/progress is locked by an excuse |
| 422 | Request validation | Malformed UUID, invalid explanation/decision, or unexpected fields |
| 422 | `invalid_excuse_explanation` / `invalid_excuse_decision` | Database value validation; HTTP validation normally catches these first |

Missing and inaccessible submission resources both return
`{"detail":{"code":"occurrence_not_found","message":"Occurrence not found"}}`.
Missing and inaccessible reads/decisions both return
`{"detail":{"code":"excuse_not_found","message":"Excuse not found"}}`.
After revocation, a previously authorized friend receives the same 404 even if
the excuse has since been decided; decision conflicts do not bypass current access
checks. If several conflict conditions apply, clients should handle any applicable
409 without assuming the occurrence can be edited or resubmitted.

## Transitions and deadlines

| Trigger | Occurrence before | Occurrence after | Excuse result |
| --- | --- | --- | --- |
| Owner submits before `closes_at`; no valid recipients | `in_progress` | `excused` | `approved`, `automatic`, no deciding user |
| Owner submits before `closes_at`; at least one valid recipient | `in_progress` | `justification_pending` | `pending`, no decision metadata |
| Authorized friend approves | `justification_pending` | `excused` | `approved`, `friend`, deciding user and server time |
| Authorized friend rejects | `justification_pending` | `missed` | `rejected`, `friend`, deciding user and server time |
| Midnight reconciliation | `justification_pending` / `excused` | Unchanged | Unchanged |

Submission requires authenticated ownership, a profile, state `in_progress`, and
database time strictly before the occurrence's original snapshotted `closes_at`.
There is at most one excuse per occurrence. Completed, missed, excused, and
already-pending occurrences cannot accept a new submission. There are no
withdrawal, explanation editing, or resubmission endpoints.

Decisions have no midnight deadline. A friend can decide an older pending excuse
after midnight, and both approval and rejection are final when made before
midnight too. First valid decision wins: concurrent approve/reject requests from
eligible friends produce exactly one successful transition; the later currently
authorized request returns `409 excuse_already_decided`. A decision cannot be
changed by another friend or by the owner.

Submitting and deciding preserve the occurrence's progress, `completed` value,
dates, timezone, deadline, and all configuration snapshots. Excused is a separate
state, never a fabricated completion: `completed` remains false and partial
progress remains visible. Future streak logic will count both completed and
excused, but this milestone does not calculate streaks.

Normal completion, undo, absolute progress, and new delta adjustments cannot
alter pending, excused, or rejected occurrences. This includes same-value writes
and rejection before midnight. Ordinary deadline checks still apply at the exact
closing instant, including the unchanged-value regression fixed in PR #9.
The dedicated authorized decision RPC is the only path for late pending →
excused/missed transitions.

A previously successful delta request remains replayable with its original key
and delta, even after submission, a decision, or midnight. Replay returns the
saved historical response without mutating the occurrence. That response may
show an older state/progress than a current read. A new key is a new mutation and
is blocked; reusing a successful key with a different delta retains the existing
`409 idempotency_conflict` behavior.

## Permissions and lifecycle

Sharing is evaluated atomically during submission from valid grants attached to
current accepted friendship rows. Friendship alone, a pending request, or a
removed friendship is insufficient. This chooses automatic approval versus
pending at submission; it does not freeze a recipient roster.

Reads and decisions check current friendship, current sharing permission, and
archive state on every request. Owners can read their own submissions, including
while archived, but cannot approve or reject them. Any currently authorized
shared friend can read relevant pending or decided excuses; only pending excuses
can be decided. Unrelated users and friends without a valid grant have no access.

| Lifecycle change | Effect on an existing pending excuse |
| --- | --- |
| Revoke a recipient's share | Immediately removes subsequent read/decision access and pending-list membership for that recipient |
| Remove friendship | Deletes grants in both directions and removes subsequent access; the excuse survives |
| Re-friend | Does not restore old grants; the owner must explicitly share again |
| Grant a newly accepted friend access | The newly authorized friend may read and decide the existing pending excuse |
| Lose every eligible friend | Remains pending indefinitely; no automatic approval, rejection, or deletion. Owner may restore valid sharing |
| Archive habit | Pending survives. Recipients cannot read, list, or decide; owner can inspect it |
| Restore habit | Retained valid sharing permits decisions again, including after the original deadline |

An owner can still submit for an archived habit's retained occurrence if it is
in_progress and before its deadline, consistent with existing owner progress
policy. Valid grants still count for that submission's shared/unshared decision
while archived. A shared submission therefore remains pending until restoration
and an authorized decision; archival cannot force automatic approval. Friendship
removal during archival still deletes grants, so restoration alone may not restore
recipient access.

A request serialized before revocation, friendship removal, or archival may
finish with the access valid in its transaction. A request serialized after the
change observes the new permissions. Already returned responses cannot be
retracted. A finalized excuse never changes merely because sharing changes.

## Persistence and concurrency

`202610080001_occurrence_excuses.sql` adds durable excuse storage and expands
occurrence states/guards without rewriting applied migrations. Constraints and
foreign keys enforce one excuse per occurrence, valid explanation/decision data,
and consistent actor/decision metadata. Excuses are not deleted by friendship or
share removal. Decision data remains durable after those permission changes.
The deciding-user foreign key also prevents deleting that profile while another
owner's retained excuse still references it. Deleting an occurrence cascades its
excuse. There is no profile/account deletion endpoint in this milestone; a future
deletion feature must explicitly handle this audit-retention policy.

Submission, current-permission checks, and occurrence transitions execute in one
database transaction through backend-only Supabase RPCs. Operations acquire the
participating profiles in sorted UUID order before dependent row locks, matching
sharing, friendship removal, reconciliation, and archive/configuration operations.
Decision and permission changes therefore serialize without reversing the profile
lock order. Pending lists discover their accessible owners and recheck access
under the same sorted locking discipline before returning entries.

RLS is enabled without client policies, table privileges are explicitly revoked
from `PUBLIC`, `anon`, `authenticated`, and `service_role`, and only intended RPC
entry points grant `service_role` execution. Internal helpers remain private.
SECURITY DEFINER functions use a fixed empty `search_path` and qualified objects.
FastAPI passes the authenticated actor to the RPC; client roles cannot directly
read explanations, mutate decisions, or invoke the backend RPCs.

## Migrations and testing

Apply all unapplied migrations in filename order, ending with
`202610080001_occurrence_excuses.sql`, after merged PR #10's
`202610070004_selective_habit_sharing.sql`. Preserve previously applied files.
Shared infrastructure migration/deployment requires a separate release; this
implementation does not merge, deploy, or apply migrations to a shared project.

Use the [disposable PostgreSQL setup](friendships.md#migration-and-tests), apply
the scaffold and all migrations, then run from `backend`:

```powershell
# TEST_DATABASE_URL must refer only to the disposable local PostgreSQL database.
python -m pytest -q
python -m pytest -q tests/test_friendships_postgres.py tests/test_habits_postgres.py tests/test_occurrences_postgres.py tests/test_sharing_postgres.py tests/test_excuses_postgres.py
```

CI runs the new service-role PostgreSQL suite alongside every existing integration
suite. API dependency tests and real-adapter/mocked-HTTP tests cover request and
response contracts, including Today/shared acceptance of the new states. Database
tests exercise deadlines, midnight persistence, finality, current permissions,
archive/restore, direct-access restrictions, concurrency, and saved delta replays.
Only private disposable-database clock instrumentation is used; production routes
and RPCs accept no client clock override.

Without `TEST_DATABASE_URL`, PostgreSQL tests skip and do not verify integration.
The scaffold tests actual PostgreSQL transactions and privileges but does not
emulate live Supabase Auth, PostgREST, or deployment configuration. The walkthrough
requires manual verification against a compatible backend. Actual suite/CI results
and any unverified live integration limits belong in the PR validation report.

## PowerShell two-user walkthrough

Use the [README sign-in/onboarding flow](../README.md#test-profiles-with-two-existing-auth-users-powershell)
to obtain `$Token1` and `$Token2` for two distinct profiles. Run against a local
backend or already-upgraded test environment. Tokens and passwords stay out of
source control. This example assumes the users are not already friends; run all
submissions before their returned `closes_at`.

```powershell
$ApiUrl = "http://127.0.0.1:8000"
$Headers1 = @{ Authorization = "Bearer $Token1"; "Content-Type" = "application/json; charset=utf-8" }
$Headers2 = @{ Authorization = "Bearer $Token2"; "Content-Type" = "application/json; charset=utf-8" }
$User2 = Invoke-RestMethod -Uri "$ApiUrl/profiles/me" -Headers $Headers2

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

function New-DailyTarget($Name) {
    $Body = @{ name = $Name; type = "target"; target = 10; unit = "pages";
        schedule = "daily"; reminder_times = @("21:00") } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$ApiUrl/habits" -Headers $Headers1 -Body $Body
}

# Unshared: auto-approve, with no deciding friend and preserved partial progress.
$Private = New-DailyTarget "Private reading"
$Today = Invoke-RestMethod -Uri "$ApiUrl/today" -Headers $Headers1
$PrivateOccurrence = $Today.occurrences | Where-Object habit_id -EQ $Private.id
Invoke-RestMethod -Method Put -Uri "$ApiUrl/occurrences/$($PrivateOccurrence.id)/progress" `
    -Headers $Headers1 -Body '{"progress":3}' | Out-Null
$Automatic = Invoke-RestMethod -Method Post -Uri "$ApiUrl/occurrences/$($PrivateOccurrence.id)/excuse" `
    -Headers $Headers1 -Body '{"explanation":"  Recovering from an injury.  "}'
# approved / automatic / decided_by null; occurrence excused / progress 3 / completed false.
$Automatic | ConvertTo-Json -Depth 8
Assert-ApiError Get "$ApiUrl/occurrences/$($PrivateOccurrence.id)/excuse" $Headers2 404 "excuse_not_found"

# Establish friendship, then explicitly share a different habit.
$Request = Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests" -Headers $Headers1 `
    -Body (@{ recipient_user_id = $User2.user_id } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests/$($Request.id)/accept" -Headers $Headers2 | Out-Null
$Shared = New-DailyTarget "Shared reading"
$ShareUri = "$ApiUrl/habits/$($Shared.id)/shares/$($User2.user_id)"
Invoke-RestMethod -Method Put -Uri $ShareUri -Headers $Headers1 | Out-Null
$Today = Invoke-RestMethod -Uri "$ApiUrl/today" -Headers $Headers1
$Occurrence = $Today.occurrences | Where-Object habit_id -EQ $Shared.id
$ExcuseUri = "$ApiUrl/occurrences/$($Occurrence.id)/excuse"

# Save a successful delta response before submission.
$DeltaHeaders = $Headers1.Clone()
$DeltaHeaders["Idempotency-Key"] = [guid]::NewGuid().ToString()
$DeltaUri = "$ApiUrl/occurrences/$($Occurrence.id)/progress-adjustments"
Invoke-RestMethod -Method Post -Uri $DeltaUri -Headers $DeltaHeaders -Body '{"delta":2}' | Out-Null
$Pending = Invoke-RestMethod -Method Post -Uri $ExcuseUri -Headers $Headers1 `
    -Body '{"explanation":"Unable to finish today."}'
$DecisionUri = "$ApiUrl/excuses/$($Pending.id)/decision"
# pending / decision_source null; occurrence justification_pending / progress 2.
Invoke-RestMethod -Uri $ExcuseUri -Headers $Headers1 | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri "$ApiUrl/excuses/pending" -Headers $Headers2
Assert-ApiError Post $DecisionUri $Headers1 404 "excuse_not_found" '{"decision":"approve"}'
Assert-ApiError Post $ExcuseUri $Headers1 409 "excuse_exists" '{"explanation":"Replacement"}'
Assert-ApiError Put "$ApiUrl/occurrences/$($Occurrence.id)/progress" $Headers1 409 "occurrence_locked" '{"progress":2}'

# Same key + delta returns the OLD response, without changing the pending occurrence.
Invoke-RestMethod -Method Post -Uri $DeltaUri -Headers $DeltaHeaders -Body '{"delta":2}'
Invoke-RestMethod -Uri $ExcuseUri -Headers $Headers1 | ConvertTo-Json -Depth 8

# Revocation leaves it pending and removes the friend's access.
Invoke-RestMethod -Method Delete -Uri $ShareUri -Headers $Headers1
Assert-ApiError Get $ExcuseUri $Headers2 404 "excuse_not_found"
Assert-ApiError Post $DecisionUri $Headers2 404 "excuse_not_found" '{"decision":"approve"}'
Invoke-RestMethod -Uri $ExcuseUri -Headers $Headers1
Invoke-RestMethod -Method Put -Uri $ShareUri -Headers $Headers1 | Out-Null

# Archive also preserves pending; only the owner can inspect until restoration.
Invoke-RestMethod -Method Post -Uri "$ApiUrl/habits/$($Shared.id)/archive" -Headers $Headers1 | Out-Null
Assert-ApiError Get $ExcuseUri $Headers2 404 "excuse_not_found"
Invoke-RestMethod -Uri $ExcuseUri -Headers $Headers1
Invoke-RestMethod -Method Post -Uri "$ApiUrl/habits/$($Shared.id)/restore" -Headers $Headers1 | Out-Null

# Approve now, or keep this pending until after closes_at to verify a late decision.
Invoke-RestMethod -Method Post -Uri $DecisionUri -Headers $Headers2 -Body '{"decision":"approve"}'
Assert-ApiError Post $DecisionUri $Headers2 409 "excuse_already_decided" '{"decision":"reject"}'
Invoke-RestMethod -Uri $ExcuseUri -Headers $Headers1 | ConvertTo-Json -Depth 8

# Rejection is final too, including before midnight.
$RejectedHabit = New-DailyTarget "Another shared reading"
Invoke-RestMethod -Method Put -Uri "$ApiUrl/habits/$($RejectedHabit.id)/shares/$($User2.user_id)" `
    -Headers $Headers1 | Out-Null
$Today = Invoke-RestMethod -Uri "$ApiUrl/today" -Headers $Headers1
$RejectedOccurrence = $Today.occurrences | Where-Object habit_id -EQ $RejectedHabit.id
$RejectedExcuse = Invoke-RestMethod -Method Post -Uri "$ApiUrl/occurrences/$($RejectedOccurrence.id)/excuse" `
    -Headers $Headers1 -Body '{"explanation":"Unable to finish this either."}'
Invoke-RestMethod -Method Post -Uri "$ApiUrl/excuses/$($RejectedExcuse.id)/decision" `
    -Headers $Headers2 -Body '{"decision":"reject"}'
# occurrence missed, completed false; this same-value write is still blocked.
Assert-ApiError Put "$ApiUrl/occurrences/$($RejectedOccurrence.id)/progress" $Headers1 409 "occurrence_locked" '{"progress":0}'
```

For the optional late-decision check, retain the occurrence/excuse UUIDs and wait
until the returned `closes_at` has actually passed. Sign in again if the tokens
expire. `/excuses/pending` still includes the older pending excuse, and approve or
reject still works with current valid sharing. Today continues to show only its
current local date. Tests use a private clock to cover both late outcomes without
waiting; the public API has no time override.
