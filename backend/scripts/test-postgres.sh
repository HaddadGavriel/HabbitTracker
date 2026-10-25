#!/usr/bin/env bash
# Always creates its own local container; accepts no database URL or project ref.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
container="habittracker-tests-$$"
docker --host=unix:///var/run/docker.sock run -d --name "$container" -e POSTGRES_PASSWORD=disposable-only -p 127.0.0.1::5432 postgres:16 >/dev/null
trap 'docker --host=unix:///var/run/docker.sock rm -f "$container" >/dev/null' EXIT
for attempt in {1..30}; do
  # Ignore the socket-only initialization server that PostgreSQL restarts.
  if docker --host=unix:///var/run/docker.sock exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null; then break; fi
  sleep 1
done
docker --host=unix:///var/run/docker.sock exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null
port=$(docker --host=unix:///var/run/docker.sock port "$container" 5432/tcp | cut -d: -f2)
docker --host=unix:///var/run/docker.sock exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 < backend/tests/postgres_scaffold.sql
for migration in supabase/migrations/*.sql; do
  echo "Applying $migration"
  docker --host=unix:///var/run/docker.sock exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 < "$migration"
done
cd backend
TEST_DATABASE_URL="postgresql://postgres:disposable-only@127.0.0.1:$port/postgres" "${PYTHON:-$root/backend/.venv/bin/python}" -m pytest -q
