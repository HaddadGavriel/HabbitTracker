# Friend-triggered push reminders

A currently authorized friend can ask the backend to send a short Expo push
notification to the owner of a shared habit. This is an explicit request, not a
scheduler: `reminder_times` configuration does not send notifications. There are
no mobile screens, local scheduling, background retries, or receipt polling in
this milestone.

## HTTP contract

```http
POST /shared-habits/{habit_id}/reminders
Authorization: Bearer <SUPABASE_ACCESS_TOKEN>
Idempotency-Key: <unique-key-for-this-logical-request>
Content-Type: application/json

{}
```

The body may be omitted, JSON null, or an empty object. The key is required, is 1–128 ASCII
characters, and must match `^[A-Za-z0-9._:-]{1,128}$`. Generate it once and retain it
for retries. The authenticated user is the sender; the habit's owner is the
recipient. The API accepts no recipient ID, device token, notification text,
occurrence ID, or client time. Unknown body fields are rejected.

A new reminder requires all of the following at the reservation transaction:

- The sender has an existing profile and is a currently accepted friend of the owner.
- An active sharing grant authorizes this sender for an active, unarchived habit.
- Reconciliation finds an occurrence for Today in the owner's current timezone.
- That occurrence is `in_progress`, `completed: false`, and still before its stored `closes_at`.
- This sender has not reserved a reminder for this habit within the preceding 60 minutes.

Owners cannot remind themselves through this endpoint. Missing, private, revoked,
unshared, archived, and otherwise inaccessible habits return the same 404. A
pending friendship is insufficient. Completed, excused, justification-pending,
missed, expired, and unscheduled occurrences are ineligible. Binary undo or target
progress below the occurrence's snapshotted threshold can make an open occurrence
eligible again, subject to the cooldown.

The database establishes authoritative time **after acquiring the existing sorted
profile locks**, then applies the [occurrence reconciliation and timezone
rules](occurrences.md). It never uses the caller's date or clock, invents
pre-cutover occurrences, fills archived gaps, or reinterprets a stored deadline
in a new timezone. A timezone transition can leave no occurrence for the current
owner-local date; that day is ineligible. Unauthorized requests do not reconcile
another user's data.

A completed dispatch returns `200` with a safe summary:

```json
{
  "id": "8999444f-cdea-4377-8235-e12e08aebdb6",
  "habit_id": "8cab1bce-89d6-44ea-9150-e774b49bd148",
  "occurrence_id": "e235e79a-18d2-4d91-9391-bec860d662d9",
  "status": "provider_accepted",
  "reserved_at": "2026-10-09T09:00:00Z",
  "finished_at": "2026-10-09T09:00:01Z",
  "retry_at": "2026-10-09T10:00:00Z",
  "device_count": 1,
  "accepted_count": 1,
  "failed_count": 0,
  "unknown_count": 0
}
```

`id` identifies the durable reminder reservation. `retry_at` is exactly 60 minutes
after `reserved_at`; it is the earliest time for a **new** logical request for
this sender/habit, not an instruction to retry dispatch. All timestamps come
from the database. The result never returns device tokens, credentials, raw
provider errors, or excuse explanations.

| Status | Meaning |
| --- | --- |
| `provider_accepted` | Expo returned acceptance tickets for every selected device |
| `partially_accepted` | Expo accepted at least one device, and at least one other device failed or has an unknown outcome |
| `failed` | Every selected device failed token validation or was definitively rejected; none was accepted or unknown |
| `unknown` | No device has confirmed acceptance, and at least one dispatch outcome is ambiguous |
| `no_devices` | The owner had no registered devices when the reservation was made; no provider call occurred |
| `reserved` | A reservation exists but has no persisted final result; the request can still be in flight or its worker may have stopped |

A `reserved` result returns `202`, with `finished_at: null`; it is not a promise
of background processing. Its accepted, failed, and unknown counts are zero until finalization and do not
describe a completed provider outcome. All finalized statuses, including `failed`, `unknown`, and `no_devices`,
return `200`: the request has a stored result, not necessarily an accepted push.
**Provider acceptance is not confirmation that the phone received or displayed a
notification.** Android permissions, FCM configuration, network conditions, and
device state remain relevant. Expo receipts and delivery tracking are deferred.

### Errors

Application errors use the existing `detail` object. Malformed inputs use the
usual FastAPI 422 validation response.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | Existing authentication errors | Missing, expired, or invalid bearer token |
| 404 | `profile_not_found` | Acting user has not completed onboarding |
| 404 | `habit_not_found` | Habit missing or inaccessible; identical response for either case |
| 409 | `reminder_not_eligible` | There is no eligible open, incomplete occurrence due Today |
| 422 | Request validation / `invalid_idempotency_key` | Missing/malformed key, malformed habit UUID, or unsupported body fields |
| 429 | `reminder_cooldown` | Sender/habit cooldown is active; `detail.retry_at` contains the database deadline |
| 503 | `reminder_unavailable` | Reservation response was unavailable; retry only with the original key |
| 503 | `reminder_outcome_unavailable` | Outcome could not be confirmed after dispatch; includes `detail.reminder_id`; retry only with the original key |

A rejected validation, permission, eligibility, or cooldown check does not create
a reservation or extend the cooldown. Provider failures are represented in the
stored result, not returned as raw provider exceptions.

## Idempotency, cooldown, and retries

The database persists the unique `(sender, habit, idempotency key)` reservation
and enforces a 60-minute cooldown per `(sender, habit)`. Profile locking and the
durable constraints coordinate concurrent requests and multiple backend workers.
Two different keys cannot reserve within the cooldown; simultaneous calls with
the same key share one reservation and at most one dispatch attempt.

Every new reservation consumes the cooldown, including `no_devices`, invalid
registered tokens, provider failures, and ambiguous outcomes. Registering a device
or changing completion afterward does not refund the reservation. Another sender
has their own cooldown for that habit; the same sender has separate cooldowns for
other habits. There is no additional owner-wide rate limit in this MVP.

Reusing a key returns the same reservation's latest persisted summary and never
sends again, even after 60 minutes. The key remains associated with the original
occurrence. Replays still require a current accepted friendship, sharing grant,
and active habit; revocation or archival therefore blocks replay access. Once
access is verified, a replay bypasses new-request eligibility and cooldown
checks: completing today's occurrence or moving into tomorrow does not change
what that old key means. The result may advance from `reserved` to a finalized
status while the original request finishes; it never becomes a new dispatch.

The transaction reserves and snapshots the recipient's device registrations and
server-generated notification first. Only after that transaction commits does
FastAPI call Expo, **outside database locks**, then persist per-device outcomes
and a compact summary. The notification title is `Habit reminder`; its short body combines the sender's
current display name and the occurrence's snapshotted habit name, with control
characters removed and lengths bounded. Clients cannot supply that content.
Structured data supports future mobile navigation:

```json
{
  "type": "habit_reminder",
  "reminder_id": "8999444f-cdea-4377-8235-e12e08aebdb6",
  "habit_id": "8cab1bce-89d6-44ea-9150-e774b49bd148",
  "occurrence_id": "e235e79a-18d2-4d91-9391-bec860d662d9"
}
```

The backend makes no automatic resend after a timeout, transport interruption,
5xx response, malformed provider response, or another ambiguous result. Some or
all of that request may already have reached Expo. Such results remain `unknown`
(or `partially_accepted` when other devices were accepted). A worker crash or a
lost reservation response can leave `reserved` indefinitely; a retry never takes
over that reservation. A failed outcome-write may also leave `reserved` even
though Expo accepted the request.

Use these retry rules:

1. If the HTTP response is lost, returns 503, or returns `reserved`, repeat with
   the **same key** to inspect the stored result. Do not create a replacement key
   merely because the request timed out.
2. A final `failed` or `no_devices` result also remains final for that key. Correct
   the device/provider issue before considering a new reminder.
3. A new explicit user request may use a new key after `retry_at`, if the occurrence
   is still eligible. For `unknown` or abandoned `reserved`, explain that this
   could duplicate a notification already accepted by Expo; it must be an explicit
   decision, never an automatic retry policy.

## Devices, security, and concurrency

A push token is globally unique across device registrations. During migration,
any historical duplicate is reduced deterministically to the most recently
updated registration, breaking ties by `created_at DESC, id DESC`. Authenticated registration atomically assigns the token
to the current account, including an account switch. Registration retains its
existing contract and works before profile onboarding. The old account cannot
retain another row for that same token. Registration accepts `ExpoPushToken[...]`
or `ExponentPushToken[...]` with an ASCII letter/digit/underscore/hyphen payload
and a maximum total length of 256 characters; malformed tokens return 422.

Expo `DeviceNotRegistered` responses invalidate only the exact registration
snapshot used by this dispatch. Cleanup checks registration ID, owner, token,
and `updated_at`; it cannot delete a token that was transferred or re-registered
while the external request was running. Ordinary provider errors do not expose
or delete unrelated tokens. One owner's multiple registrations are processed
individually, so mixed provider results produce partial success rather than a
false all-or-nothing claim.

Reservation uses the existing profile locks in sorted UUID order and rechecks
friendship, sharing, habit activity, and occurrence state under those locks.
It serializes with progress changes, excuse decisions, archival, and revocation.
Selected device rows are locked in ID order until the reservation commits, so
account transfers of those registrations cannot race past the captured snapshot.
Devices newly registered after snapshot collection are picked up by a later new
request. All profile and device locks are released before contacting Expo.
The reservation's **commit is the authorization boundary**: if revocation,
completion, archival, or an account switch happens afterward, it cannot retract
an external request already authorized with the captured device snapshot. A
change serialized before reservation is honored; a later new request rechecks
current state. An already authorized reminder may therefore arrive after a
subsequent revocation or completion. Holding locks during the network request
would not make delivery revocable and would block normal application changes.

The new tables use RLS with explicit client-role privilege revocations.
Backend-only RPCs retain service-role execution grants, fixed `search_path`,
and qualified object references; internal helpers are not client-accessible.
Clients cannot directly reserve/finalize reminders, bypass cooldowns, read push
tokens, or execute the registration RPC. Notification and device snapshots are
private backend data, not fields in shared-habit views. Existing Today, sharing,
occurrence, excuse, and streak responses remain compatible.

## Migration, deployment, and tests

For a separately authorized release, apply all unapplied migrations in filename
order, through `supabase/migrations/202610090001_friend_reminders.sql`, **before**
deploying this backend version. This follows PR #12's
`202610080002_occurrence_history_streaks.sql`. Do not rewrite or reapply recorded
migrations. The migration adds persistent reminder reservations/results, their
constraints and indexes, restricted RPCs, and globally unique token registration.
The token deduplication keeps one registration for each token; review that behavior
before release if the shared database contains historical duplicate registrations.
No shared database migration or deployment is part of implementation verification.
Coordinate the rollout with a brief maintenance window for device registration:
the migration revokes direct device-table writes, so the previous backend's
registration adapter stops working until this RPC-based version is deployed.
Rolling back to the old direct-write adapter requires a separate compatibility
plan; do not relax client privileges to work around it.
No new environment variable is required; the backend retains the configured
`EXPO_PUSH_URL` and Supabase secret-key adapter.

Use the [disposable PostgreSQL setup](friendships.md#migration-and-tests), with
`TEST_DATABASE_URL` pointing only to the disposable database. From `backend`:

```powershell
python -m pytest -q
$PostgresTests = Get-ChildItem tests/test_*_postgres.py | ForEach-Object { $_.FullName }
python -m pytest -q $PostgresTests
```

CI applies every migration to PostgreSQL 16 and discovers every
`test_*_postgres.py` suite, including reminders. API and mocked-HTTP tests cover
validation, response contracts, safe notification construction, provider errors,
partial success, and no automatic resend. Real PostgreSQL tests exercise current
permissions, reconciliation/timezone eligibility, database-time cooldowns,
idempotency, concurrent reservation/decisions/reads, account switching, and direct
client privilege restrictions. Automated tests mock Expo and send **no real push
notifications**. A run without `TEST_DATABASE_URL` skips PostgreSQL integration
and does not verify those guarantees. Actual test counts and CI results are
reported in the PR rather than inferred here.

The disposable scaffold does not emulate live Supabase Auth/PostgREST, hosted
permissions, or Expo/FCM delivery. The following walkthrough is a remaining manual
integration check after an explicitly authorized migration/deployment.

## PowerShell two-user manual verification

Use a real device only when intentionally performing this manual check: its first
successful request sends an actual push. Obtain `$Token1` (owner) and `$Token2`
(friend) using the [README sign-in flow](../README.md#test-profiles-with-two-existing-auth-users-powershell).
Both users need profiles. Use dedicated test users/habits and never commit tokens,
passwords, or Expo device tokens. Register notifications on User 1's signed-in
Android device using the existing infrastructure app, or register its actual
Expo token explicitly:

```powershell
$ApiUrl = "http://127.0.0.1:8000" # Or the authorized deployed backend.
$Headers1 = @{ Authorization = "Bearer $Token1"; "Content-Type" = "application/json" }
$Headers2 = @{ Authorization = "Bearer $Token2"; "Content-Type" = "application/json" }
$User1 = Invoke-RestMethod -Uri "$ApiUrl/profiles/me" -Headers $Headers1
$User2 = Invoke-RestMethod -Uri "$ApiUrl/profiles/me" -Headers $Headers2

# Skip when already registered by the owner's app.
$OwnerExpoToken = "ExponentPushToken[YOUR_REAL_DEVICE_TOKEN]"
Invoke-RestMethod -Method Post -Uri "$ApiUrl/devices/register" -Headers $Headers1 `
  -Body (@{ expo_push_token = $OwnerExpoToken; platform = "android" } | ConvertTo-Json)

# Skip these two calls if the users are already accepted friends.
$Request = Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests" -Headers $Headers1 `
  -Body (@{ recipient_user_id = $User2.user_id } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests/$($Request.id)/accept" -Headers $Headers2

$Habit = Invoke-RestMethod -Method Post -Uri "$ApiUrl/habits" -Headers $Headers1 `
  -Body '{"name":"Read a page","type":"binary","schedule":"daily","reminder_times":["21:00"]}'
$ShareUri = "$ApiUrl/habits/$($Habit.id)/shares/$($User2.user_id)"
$ReminderUri = "$ApiUrl/shared-habits/$($Habit.id)/reminders"
Invoke-RestMethod -Method Put -Uri $ShareUri -Headers $Headers1
$View = Invoke-RestMethod -Uri "$ApiUrl/shared-habits/$($Habit.id)" -Headers $Headers2
$View | ConvertTo-Json -Depth 8
# Check due_today, occurrence.state = in_progress, completed = false, closes_at.
# If timezone-transition policy makes due_today false, wait for a genuinely due day.

$ReminderKey = [guid]::NewGuid().ToString()
$ReminderHeaders = $Headers2.Clone()
$ReminderHeaders["Idempotency-Key"] = $ReminderKey
$Result = Invoke-RestMethod -Method Post -Uri $ReminderUri -Headers $ReminderHeaders -Body '{}'
$Result | ConvertTo-Json
# provider_accepted means accepted by Expo, not received by the phone.
# Inspect the owner's phone separately, foreground and background as appropriate.

# Same ID/result; no second dispatch. Reserved may advance to a final status.
$Replay = Invoke-RestMethod -Method Post -Uri $ReminderUri -Headers $ReminderHeaders -Body '{}'
if ($Replay.id -ne $Result.id) { throw "Idempotency reservation changed" }

# New key inside 60 minutes: expected 429 with retry_at. This command throws.
$NewHeaders = $Headers2.Clone()
$NewHeaders["Idempotency-Key"] = [guid]::NewGuid().ToString()
Invoke-RestMethod -Method Post -Uri $ReminderUri -Headers $NewHeaders -Body '{}'
```

Run expected-error commands individually; PowerShell displays their HTTP error
responses. Continue with the same variables to check access and eligibility:

```powershell
# Revocation blocks even a same-key replay: expected 404, no dispatch.
Invoke-RestMethod -Method Delete -Uri $ShareUri -Headers $Headers1
Invoke-RestMethod -Method Post -Uri $ReminderUri -Headers $ReminderHeaders -Body '{}'
Invoke-RestMethod -Method Put -Uri $ShareUri -Headers $Headers1

# Complete today's occurrence while still open.
Invoke-RestMethod -Method Put -Uri "$ApiUrl/occurrences/$($View.occurrence.id)/completion" `
  -Headers $Headers1 -Body '{"completed":true}'
# Old key still returns its original authorized reservation after sharing restored.
Invoke-RestMethod -Method Post -Uri $ReminderUri -Headers $ReminderHeaders -Body '{}'
# A new reminder cannot target a completed occurrence (expected 409).
Invoke-RestMethod -Method Post -Uri $ReminderUri -Headers $NewHeaders -Body '{}'

# Self-reminders remain inaccessible: expected 404.
$OwnerReminderHeaders = $Headers1.Clone()
$OwnerReminderHeaders["Idempotency-Key"] = [guid]::NewGuid().ToString()
Invoke-RestMethod -Method Post -Uri $ReminderUri -Headers $OwnerReminderHeaders -Body '{}'
```

Also check an unshared habit and an archived shared habit (404), a pending
friendship (404), a selected-weekday habit excluding the owner's actual Today
(409), and pending/excused/expired occurrences (409). Use the owner's shared view
and stored deadline to choose these cases; the production API exposes no clock
override. For expiry, wait until the actual deadline. To verify `no_devices`, use
a dedicated owner account that has never registered a device; it consumes that
sender/habit's cooldown without contacting Expo.

For account switching, sign the same device into User 2 and register notifications
again with the **same token**, then inspect via a privileged SQL console that
`device_push_tokens` has exactly one row for that token and its owner is User 2.
Alternatively repeat `POST /devices/register` with `$Headers2` and the same token.
Do not print or commit the token. Switch back and register as User 1 to restore the
manual setup. Direct `anon`/`authenticated` table and reminder-RPC access must be
denied. Do not run arbitrary provider-failure experiments against a real token;
timeouts, invalid tickets, malformed replies, and partial success are exercised
with mocked HTTP in automated tests.
