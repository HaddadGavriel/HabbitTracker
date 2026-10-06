# Friend requests and friendships

All routes require a validated Supabase bearer token **and** an existing profile. FastAPI derives the actor from that token; bodies cannot supply one. Relationship rows use profile UUIDs, so renames are safe, while responses resolve current names. Email, timezone, Auth data, and full profile timestamps are never returned.

## API contract

| Route | Success | Notes and application errors |
|---|---|---|
| `POST /friend-requests` | `201` pending relationship | Body is exactly `{"recipient_user_id":"UUID"}`. `404 recipient_not_found`; `409 outgoing_request_exists`, `incoming_request_exists`, or `friendship_exists`; `422 self_request` or schema errors. |
| `GET /friend-requests` | `200 {"incoming":[],"outgoing":[]}` | Pending only, ordered oldest first then by relationship ID. |
| `POST /friend-requests/{id}/accept` | `200` accepted relationship | Recipient only. |
| `POST /friend-requests/{id}/reject` | `204` | Recipient only; deletes the row. |
| `GET /friends` | `200 []` | Accepted only, ordered by current username then relationship ID. |
| `DELETE /friends/{friend_user_id}` | `204` | Either friend may delete an accepted relationship. |

Mutation paths return `404 friend_request_not_found` or `404 friendship_not_found` both when absent and when unauthorized, preventing inspection. Stale/already-decided requests use the same response. Malformed UUIDs and unexpected fields return `422`. Missing onboarding returns `404 profile_not_found`; absent/invalid authentication returns `401`.

```json
{
  "id": "relationship UUID", "direction": "incoming", "state": "pending",
  "profile": {"user_id": "other UUID", "username": "alice", "display_name": "Alice"},
  "created_at": "2026-10-05T12:00:00Z", "updated_at": "2026-10-05T12:00:00Z", "accepted_at": null
}
```

Transitions are `absent → pending → accepted → absent`, or `absent → pending → absent` on rejection. Absence permits a new request. An unordered-pair unique index prevents duplicate/reverse rows. Backend-role-only functions classify send conflicts and perform conditional accept/reject/remove writes atomically. RLS has no client policies, and client roles lack table/function privileges.

## Migration and tests

Apply committed migrations in order with `supabase db push`; never edit an applied migration or use shared infrastructure for tests. `cd backend; pytest` runs API and mocked-transport adapter tests. PostgreSQL tests require a **disposable empty database** initialized like CI, then `TEST_DATABASE_URL=postgresql://... pytest tests/test_friendships_postgres.py`. The CI scaffold contains only `auth.users` and the `anon`, `authenticated`, and `service_role` roles; it verifies PostgreSQL, not Supabase Auth/PostgREST.

## PowerShell two-user flow

Obtain `$Token1`/`$Token2` and create profiles using the README walkthrough, then:

```powershell
$ApiUrl = "http://127.0.0.1:8000"
$Headers1 = @{ Authorization = "Bearer $Token1"; "Content-Type" = "application/json" }
$Headers2 = @{ Authorization = "Bearer $Token2"; "Content-Type" = "application/json" }
$User2 = Invoke-RestMethod -Method Get -Uri "$ApiUrl/profiles/search?username=bob_2" -Headers $Headers1
$Pending = Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests" -Headers $Headers1 -Body (@{ recipient_user_id = $User2.user_id } | ConvertTo-Json)
Invoke-RestMethod -Method Get -Uri "$ApiUrl/friend-requests" -Headers $Headers2
Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests/$($Pending.id)/accept" -Headers $Headers2
Invoke-RestMethod -Method Get -Uri "$ApiUrl/friends" -Headers $Headers1
Invoke-RestMethod -Method Get -Uri "$ApiUrl/friends" -Headers $Headers2
Invoke-RestMethod -Method Delete -Uri "$ApiUrl/friends/$($User2.user_id)" -Headers $Headers1
$Again = Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests" -Headers $Headers1 -Body (@{ recipient_user_id = $User2.user_id } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "$ApiUrl/friend-requests/$($Again.id)/reject" -Headers $Headers2
```

Repeat send in the same direction for `outgoing_request_exists`, reverse it while pending for `incoming_request_exists`, and send after acceptance for `friendship_exists`.
