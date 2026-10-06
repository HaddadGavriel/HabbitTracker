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

Mutation paths return `404 friend_request_not_found` or `404 friendship_not_found` both when absent and when unauthorized, preventing inspection. Stale/already-decided requests use the same response. Malformed UUIDs and unexpected fields return `422`. Accept, reject, and remove take no body (an empty object or JSON null is also accepted); any body fields, including acting-user IDs, are rejected before a write. Missing onboarding returns `404 profile_not_found`; absent/invalid authentication returns `401`.

```json
{
  "id": "relationship UUID", "direction": "incoming", "state": "pending",
  "profile": {"user_id": "other UUID", "username": "alice", "display_name": "Alice"},
  "created_at": "2026-10-05T12:00:00Z", "updated_at": "2026-10-05T12:00:00Z", "accepted_at": null
}
```

Transitions are `absent → pending → accepted → absent`, or `absent → pending → absent` on rejection. Absence permits a new request. An unordered-pair unique index prevents duplicate/reverse rows. Backend-role-only functions classify send conflicts and perform conditional accept/reject/remove writes atomically. RLS has no client policies, and client roles lack table/function privileges.

Sending uses PostgreSQL's default READ COMMITTED isolation. If a conflicting row is removed before it can be inspected, sending retries insertion rather than reporting a nonexistent incoming request. An existing row is locked while its conflict is classified. Profile key-share locks keep both participants present during sending; if the caller's profile disappears before this operation, the error remains `404 profile_not_found`. Concurrent accept/reject or repeated decisions have exactly one successful transition. Concurrent removal has one success and one `404`; removal deletes the current accepted pair and allows a fresh request.

## Migration and tests

Apply committed migrations in filename order. New installations need all migrations; installations that already applied `202610050003_friendships.sql` need only `202610060001_friend_request_races.sql`. The new migration replaces only the send RPC and explicitly retains backend-only execution; it does not change existing rows or rewrite earlier migrations. For an approved infrastructure release, use `supabase db push` (or run each unapplied SQL file in order in the dashboard). Implementation and tests do not apply migrations to shared infrastructure.

`cd backend; python -m pytest -q` runs the API and mocked HTTP transport suite; PostgreSQL checks skip when `TEST_DATABASE_URL` is unset. CI creates PostgreSQL 16, applies `backend/tests/postgres_scaffold.sql`, applies every migration, and runs the integration suite. The scaffold deliberately grants API roles default table/function privileges so tests prove explicit revocations survive Supabase-like defaults. It contains only `auth.users(id)` and API roles. It verifies PostgreSQL constraints, RLS configuration, privileges, cascades, ordering, and actual concurrent transactions; it does not emulate Supabase Auth, the gateway, or PostgREST. A test-only trigger/advisory lock forces the send/delete race window and is removed after that test.

To reproduce integration checks locally in PowerShell, from the repository root with Docker running and backend development dependencies installed:

```powershell
docker run --rm --detach --name habbit-postgres-test -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:16
# Wait until this reports "accepting connections" before continuing.
docker exec habbit-postgres-test pg_isready -U postgres
try {
    Get-Content -Raw backend/tests/postgres_scaffold.sql | docker exec -i habbit-postgres-test psql -U postgres -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw "Scaffold failed" }
    Get-ChildItem supabase/migrations/*.sql | Sort-Object Name | ForEach-Object {
        Get-Content -Raw $_.FullName | docker exec -i habbit-postgres-test psql -U postgres -v ON_ERROR_STOP=1
        if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($_.Name)" }
    }
    $env:TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:55432/postgres"
    Push-Location backend
    try { ./.venv/Scripts/python.exe -m pytest -q } finally { Pop-Location }
} finally {
    Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
    docker stop habbit-postgres-test
}
```

Use only this disposable local database; no Supabase credentials are needed. Unix shells can pipe the same scaffold/migration files to `docker exec -i ... psql`, set the same test URL, and use `.venv/bin/python`. The ordinary suite retains the existing test Auth/key placeholders.

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
