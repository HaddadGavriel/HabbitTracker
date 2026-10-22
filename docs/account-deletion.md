# Account deletion and recovery

Deletion starts in Settings → **Delete account permanently**. The user enters
`DELETE MY ACCOUNT` and their current password. The server validates the bearer
with Supabase Auth, derives both ID and email from that response, and performs a
fresh password grant with that email. The returned Auth identity must match.
Neither endpoint accepts a target user ID or email. Credentials stay server-side;
passwords, access/refresh tokens and receipts must never be logged. Account-route
validation errors omit submitted values. Do not enable HTTP body/debug logging
on these routes or on the Auth adapter.

## Policy and schema audit

This inventory was inspected before implementation on main `41e9738`. The new
migration is append-only. No shared migrations or live account deletions were run.

| Data / foreign keys | Deletion policy |
| --- | --- |
| `profiles.user_id → auth.users.id` | Keep the profile during pending Auth deletion; hard Auth deletion cascades it. The durable deletion ledger blocks use and re-onboarding even if the profile is absent. |
| `habits.owner_id → profiles`; `habit_tracking.habit_id → habits` | Delete owned habits and tracking watermarks. |
| `habit_occurrences.owner_id → profiles`, `habit_id → habits`, `(habit_id,owner_id) → habits` | Delete owned occurrences. Never update other owners' occurrences. |
| `occurrence_adjustments.occurrence_id → habit_occurrences` | Cascade owned idempotency keys and saved responses. |
| `occurrence_excuses.occurrence_id → habit_occurrences` | Cascade the owner's explanations and decisions. |
| `occurrence_excuses.decided_by → profiles` | For other owners' finalized decisions only, replace `friend` with `deleted_friend` and set `decided_by = NULL` before Auth deletion. Keep the original outcome, explanation, creation/decision timestamps, occurrence state/progress/snapshot and occurrence timestamps exactly. No synthetic profile. The deferred NO ACTION FK remains as a safety backstop. |
| `friend_relationships.requester_id/recipient_id → profiles` | Delete pending requests and accepted relationships in both directions. |
| `habit_shares.recipient_id → profiles`, `relationship_id → friend_relationships`, `(habit_id,owner_id) → habits` | Cascade both directions of sharing; no automatic restoration. |
| `device_push_tokens.user_id → auth.users` | Remove tokens, versions and registration IDs, including for accounts without profiles. |
| `device_registration_intents.user_id → auth.users` | Remove registration/cancellation tombstones; deletion ledger supersedes their fence. |
| `habit_reminders.sender_id/owner_id → profiles`, `occurrence_id → habit_occurrences`, `(habit_id,owner_id) → habits` | Delete associated reservations/outcomes, device/token snapshots, generated notification text, provider tickets/results, cooldowns and keys. |
| `infrastructure_tests.user_id → auth.users` | Delete probe timestamps, request IDs, push tickets and status. |
| Supabase Auth account and its managed identities/sessions | Hard delete through server-side Admin API, then verify missing through Admin GET and independently through `auth.users` in the completion RPC. |
| `account_deletions` (no FK) | Retain UUID, SHA-256 hash of random receipt, pending/complete state, request/completion timestamps indefinitely as a minimal recovery and anti-resurrection tombstone. No email, name, password, Auth token or raw receipt. RPC-only; no client table privileges. |

Finalized decisions are anonymized, not rewritten or attributed to another active
friend. Pending decisions on another owner's habit stay pending; another current
recipient can decide them. Deleting the last recipient does not invent an
approval or rejection. Streaks continue to derive from unchanged stored occurrence
states. User-authored text in another owner's history is retained verbatim; this
operation removes structured deciding identity, not arbitrary mentions in others'
text. Other owners' private data is never scanned or rewritten for such mentions.

Backups, provider logs and messages already delivered to another device follow
the provider/operator's retention policy; this workflow does not claim to erase
those external copies. Other devices clear app data on their next authenticated
transition; offline devices cannot be remotely wiped by this app.

## RPC and trigger review

The migration wraps all 31 reviewed application service-role RPCs with a shared transaction
barrier, retains its name/signature/defaults, and removes all API-role permissions
from the renamed implementation. The wrappers also reject deleted/pending UUID
arguments representing people. Client roles retain no direct deletion/RPC access.
The reviewed service RPCs are:

- Devices: `register_device`, `register_device_intent`, `unregister_device`.
- Friendships: `send_friend_request`, `accept_friend_request`,
  `reject_friend_request`, `remove_friend`, `list_friend_requests`, `list_friends`.
- Habits: `create_habit`, `update_habit`, `archive_habit`, `restore_habit`,
  `get_habit`, `list_habits`.
- Sharing: `grant_habit_share`, `revoke_habit_share`, `list_habit_shares`,
  `get_shared_habit`, `list_shared_habits`.
- Occurrences/excuses: `get_today`, `mutate_occurrence`,
  `submit_occurrence_excuse`, `decide_occurrence_excuse`,
  `get_occurrence_excuse`, `list_pending_excuses`.
- History/reminders: `get_habit_history`, `get_habit_streak`,
  `get_local_reminder_plan`, `reserve_habit_reminder`, `finish_habit_reminder`.

Reviewed internal projections/reconciliation helpers include
`relationship_view`, `habit_view`, `shared_habit_view`, `excuse_view`,
`habit_streak_summary`, `habit_reminder_summary`, `is_current_habit_recipient`,
`require_habit_profile`, `lock_share_profiles`, `reconcile_occurrences`,
`materialize_occurrence`, configuration/explanation normalization and
`occurrence_now`. They remain internal. All triggers remain enabled:
`profiles_set_updated_at`, `profiles_reconcile_timezone`,
`profiles_track_timezone`, `habits_guard_update`, `habits_track_insert`,
`habits_reconcile_edit`, `habits_track_restore`, `occurrences_guard_update`,
`excuses_guard_update`, plus FK actions. Profile/probe direct writes gain statement
barriers and row guards so they cannot race or resurrect a deletion.

`guard_excuse_update` gains one exact exception: a durable pending deletion for
the old deciding identity permits changing **only** the source and deciding ID.
Every other field must compare equal. There is no session-setting bypass, general
finalized-edit privilege, trigger disabling, or occurrence guard exception.

The transaction lock order is deletion barrier → existing sorted profile locks →
domain rows → device rows (registration still uses its existing intent advisory
lock inside the barrier). Normal RPCs take a shared barrier, so they retain normal
concurrency. Cleanup takes the exclusive barrier before discovering/cleaning data;
it drains old RPC transactions and prevents new candidate discovery from racing
cleanup. This intentionally pauses unrelated app transactions during the short
cleanup transaction. No locks span Auth or Expo HTTP. Large accounts may therefore
need database timeout/capacity tuning; failures before commit are safe to retry.
Future service RPCs/direct write paths **must** join this barrier before taking
row locks and must check deletion state. Future migrations replacing an existing
wrapper must preserve that contract.

A reminder reservation committed before cleanup remains authorization for one
external Expo dispatch, consistent with existing revocation/account-switch
semantics. It cannot be recalled by deleting its row. An in-flight completion may
find its reservation removed; it must not recreate it or send again. New
reservations/registrations cannot commit for pending accounts. The same applies
to an already committed infrastructure push snapshot.

## Durable workflow and result recovery

1. Before sending a deletion request, mobile persists a cryptographically random
   32-byte receipt and the local expected account identity. Storage failure sends
   nothing. Confirmation and password are not persisted.
2. `POST /account/deletion` freshly reauthenticates, then calls the service-only
   `begin_account_deletion(validated_user, SHA256(receipt))`. One transaction
   inserts `pending`, anonymizes deciding identities, removes private application
   data, and retains the pending profile. A retry with the same receipt is a no-op;
   another receipt cannot replace the original capability.
3. After commit, the server asks the Auth Admin API to hard-delete the account and
   verifies a structured `user_not_found` result. A generic proxy 404 is not proof.
   `complete_account_deletion` also requires the Auth DB row to be absent before
   recording `complete`. Auth failure, lost HTTP responses or DB disagreement
   leave the durable request pending; no rollback of completed HTTP is assumed.
4. `POST /account/deletion/recover` accepts only the receipt, without an Auth
   session. It hashes the receipt, looks up that request and resumes the workflow.
   It returns only `pending`, `complete`, or `not_found`, never a target identity.
   A timeout/error is unconfirmed. Retrying `complete` has no external side effect.
   Protect receipts like narrowly scoped credentials: TLS, no URL/query parameters,
   body logs or analytics; retain normal edge abuse controls.
5. A confirmed `pending` or `complete` response clears local app/session data and
   cancels native/scheduled/presented notifications. Pending is displayed as pending,
   not deleted. An ambiguous start/recovery response keeps the gate and receipt.
   A `not_found` response permits returning to Settings with the same receipt;
   it does not clear it, because a delayed original request might still commit.
   An interrupted client loads the receipt at startup before rendering account
   routes and retries recovery. It never needs the password again for recovery.
6. Mobile removes its receipt only after `complete` **and** successful local
   cleanup. Failed local cleanup retains the receipt for retry. Only then does
   it display **Account deleted**. Local cleanup fences late operation responses,
   clears in-memory/durable reminder requests and registration journals, disables
   the native recurrence engine, clears notification taps/badges, and uses local
   Supabase sign-out to erase session tokens. Account switches are checked before
   dispatch and cleanup; an unexpected account cannot be silently deleted or
   signed out by this workflow.

The normal auth dependency returns `409 account_deletion_pending` for the ledger
identity, including completed tombstones. Ordinary reads/mutations cannot treat
an absent profile as fresh onboarding. Database guards independently fence races
after authentication. The receipt is an unguessable limited recovery capability,
not an admin credential; a caller cannot select another deletion identity.

## Maintenance operations

Run the following **only in an authorized server environment** with the normal
server Supabase URL and secret configured, after separately approving rollout:

```sh
cd backend
python -m app.deletion_maintenance
```

This enumerates only durable pending requests through a service-only RPC, retries
Auth delete/verification and completion, and prints aggregate counts. It cannot
start deletion for arbitrary accounts. It is idempotent and may be scheduled by
operators. Do not reset pending rows, remove tombstones, restore profiles, or
re-enable a pending account to work around an outage. Correct configuration/Auth
availability and rerun maintenance. If a client loses its receipt or uninstalls,
maintenance still finishes deletion; support should use authenticated operational
access rather than disclosing or regenerating receipt credentials.

A failure before `begin` commits leaves no request; retry with the same persisted
receipt and password. A failure after `begin` commits requires no new password and
is recoverable by receipt or maintenance. An Auth deletion that succeeds before a
completion failure is detected as missing on retry; the pending profile's cascade
has already removed it, and the tombstone prevents re-onboarding in the gap.

## Validation

Apply the entire migration chain only to an empty disposable PostgreSQL database
using `backend/tests/postgres_scaffold.sql`, then run:

```sh
TEST_DATABASE_URL=postgresql://... python -m pytest -q backend/tests
cd mobile
npm test
npm run typecheck
```

Do not run two PostgreSQL test processes against the same disposable database:
the existing test-clock fixtures deliberately own a shared test-only schema.
Deletion tests exercise actual SQL/roles/FKs/trigger guards, exact preserved
history/streaks, pending fences and both transaction orders for decisions, sharing,
registration and reservations. Auth tests use mocked HTTP/adapter failures; mobile
tests execute confirmation controls, lost-response recovery, cleanup failures and
notification/session cleanup with native dependencies mocked. No live Auth
accounts, shared databases or device notification services are used by these tests.

Verified locally for this change (2026-10-22): **1,697 backend tests passed**
against disposable PostgreSQL 16; **681 mobile tests passed**; TypeScript
`tsc --noEmit` passed. The final migration inventory was also applied from an
empty second disposable database and all **30 focused deletion tests passed**.
The backend emits an existing Starlette/AnyIO deprecation warning. Auth HTTP and
native/mobile dependencies were mocked; no live Auth or physical-device deletion
was tested. No shared migrations, deployment, merge, or live-user deletions ran.
