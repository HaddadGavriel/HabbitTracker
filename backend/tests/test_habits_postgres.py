"""Disposable PostgreSQL only; entry points are exercised as service_role."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import monotonic, sleep
from uuid import uuid4

import pytest

from test_friendships_postgres import URL, execute, execute_as, psycopg, service, users
from psycopg.types.json import Jsonb

pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not configured")
CONFIG = {"name": "Read", "description": None, "type": "binary", "target": None, "unit": None,
          "schedule": "daily", "weekdays": [], "reminder_times": ["08:00", "21:00"]}
TARGET = CONFIG | {"type": "target", "target": 10, "unit": "pages", "schedule": "selected", "weekdays": [1, 3, 7]}


def create(actor, config=None):
    return service("select * from public.create_habit(%s,%s)", (actor, Jsonb(config or CONFIG)), True)[0][0]


def read(actor, habit):
    rows = service("select * from public.get_habit(%s,%s)", (actor, habit), True)
    return rows[0][0] if rows else None


def patch(actor, habit, changes):
    return service("select * from public.update_habit(%s,%s,%s)", (actor, habit, Jsonb(changes)), True)


def lifecycle(function, actor, habit):
    return service(f"select * from public.{function}_habit(%s,%s)", (actor, habit), True)


ENTRY_POINTS = [
    ("create_habit", "uuid,jsonb", "null::uuid,null::jsonb"),
    ("list_habits", "uuid,text", "null::uuid,'all'::text"),
    ("get_habit", "uuid,uuid", "null::uuid,null::uuid"),
    ("update_habit", "uuid,uuid,jsonb", "null::uuid,null::uuid,null::jsonb"),
    ("archive_habit", "uuid,uuid", "null::uuid,null::uuid"),
    ("restore_habit", "uuid,uuid", "null::uuid,null::uuid"),
]
HELPERS = [
    ("normalize_habit_configuration", "jsonb", "null::jsonb"),
    ("guard_habit_update", "", ""),
    ("habit_view", "public.habits", "null::public.habits"),
    ("require_habit_profile", "uuid", "null::uuid"),
]


@pytest.mark.parametrize("role", ["anon", "authenticated"])
@pytest.mark.parametrize("name,signature,args", ENTRY_POINTS + HELPERS)
def test_clients_cannot_execute_functions(role, name, signature, args):
    # Use catalog for trigger helper, which cannot be invoked via SELECT anyway.
    assert execute("select has_function_privilege(%s,%s,'EXECUTE')", (role, f"public.{name}({signature})"), True) == [(False,)]
    if name != "guard_habit_update":
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            execute_as(role, f"select public.{name}({args})", fetch=True)


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("operation", ["select", "insert", "update", "delete"])
def test_direct_table_access_denied(role, operation):
    sql = {"select": "select * from public.habits", "insert": "insert into public.habits(owner_id,configuration) values (null,'{}')",
           "update": "update public.habits set configuration='{}'", "delete": "delete from public.habits"}[operation]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, sql, fetch=operation == "select")


def test_function_security_and_rls():
    assert execute("select relrowsecurity from pg_class where oid='public.habits'::regclass", fetch=True) == [(True,)]
    for name, signature, _ in ENTRY_POINTS:
        assert execute("select prosecdef,proconfig from pg_proc where oid=%s::regprocedure", (f"public.{name}({signature})",), True) == [(True, ['search_path=""'])]
        assert execute("select has_function_privilege('service_role',%s,'EXECUTE')", (f"public.{name}({signature})",), True) == [(True,)]
    # PUBLIC has no EXECUTE ACL, regardless of explicit role revocation.
    for name, signature, _ in ENTRY_POINTS + HELPERS:
        assert execute("select count(*) from pg_proc p, lateral aclexplode(p.proacl) a where p.oid=%s::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'", (f"public.{name}({signature})",), True) == [(0,)]
    for name, signature, _ in HELPERS:
        assert execute("select has_function_privilege('service_role',%s,'EXECUTE')", (f"public.{name}({signature})",), True) == [(False,)]


@pytest.mark.parametrize("name,signature,args", ENTRY_POINTS)
def test_every_rpc_requires_profile(name, signature, args):
    # Null owner is also an absent profile; no private data is available.
    with pytest.raises(psycopg.errors.RaiseException, match="profile_not_found"):
        service(f"select public.{name}({args})", fetch=True)


@pytest.mark.parametrize("config", [CONFIG, TARGET])
def test_creation_and_normalization(users, config):
    a, *_ = users
    supplied = config | {"name": " Read ", "reminder_times": ["21:00", "08:00"]}
    if config["type"] == "target": supplied.update(unit=" pages ", weekdays=[7, 1, 3])
    row = create(a, supplied)
    assert {key: row[key] for key in CONFIG} == config
    assert row["owner_id"] == str(a) and row["archived_at"] is None
    assert read(a, row["id"]) == row


INVALID = [
    {"name": None}, {"name": ""}, {"name": " "}, {"name": "x" * 101}, {"description": "x" * 1001}, {"description": 1},
    {"type": None}, {"type": "bad"}, {"type": "target"}, {"target": 1}, {"unit": "pages"},
    {"type": "target", "target": True}, {"type": "target", "target": "2"}, {"type": "target", "target": 0},
    {"type": "target", "target": -1}, {"type": "target", "target": 1.2}, {"type": "target", "target": 1, "unit": " "},
    {"type": "target", "target": 1, "unit": "x" * 31}, {"unit": False},
    {"schedule": None}, {"schedule": "bad"}, {"weekdays": [1]}, {"schedule": "selected"},
    {"schedule": "selected", "weekdays": [1, 1]}, {"schedule": "selected", "weekdays": [0]},
    {"schedule": "selected", "weekdays": [8]}, {"schedule": "selected", "weekdays": [True]},
    {"schedule": "selected", "weekdays": [1.5]}, {"schedule": "selected", "weekdays": ["1"]},
    {"weekdays": None}, {"weekdays": {}}, {"reminder_times": None}, {"reminder_times": []},
    {"reminder_times": ["08:00", "08:00"]}, {"reminder_times": ["8:00"]}, {"reminder_times": ["24:00"]},
    {"reminder_times": ["12:60"]}, {"reminder_times": ["08:00:00"]}, {"reminder_times": ["08:00\n"]},
    {"reminder_times": [800]}, {"owner_id": "bad"}, {"created_at": None},
]


@pytest.mark.parametrize("changes", INVALID)
def test_invalid_creation_and_database_constraint(users, changes):
    a, *_ = users
    invalid = CONFIG | changes
    with pytest.raises(psycopg.errors.RaiseException, match="invalid_habit_configuration"):
        create(a, invalid)
    # Check constraints enforce the same combinations even outside an entry point.
    with pytest.raises(psycopg.errors.RaiseException, match="invalid_habit_configuration"):
        execute("insert into public.habits(owner_id,configuration) values(%s,%s)", (a, Jsonb(invalid)))
    assert service("select * from public.list_habits(%s,'all')", (a,), True) == []


def test_constraints_canonical_fk_and_immutable_columns(users):
    a, *_ = users
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        execute("insert into public.habits(owner_id,configuration) values(%s,%s)", (uuid4(), Jsonb(CONFIG)))
    with pytest.raises(psycopg.errors.NotNullViolation):
        execute("insert into public.habits(owner_id,configuration) values(%s,null)", (a,))
    with pytest.raises(psycopg.errors.CheckViolation):
        execute("insert into public.habits(owner_id,configuration) values(%s,%s)", (a, Jsonb(CONFIG | {"name": " Read "})))
    row = create(a)
    for sql, value in [("id=%s", uuid4()), ("owner_id=%s", users[1]), ("created_at=%s", "2000-01-01"),
                       ("configuration=%s", Jsonb(TARGET))]:
        with pytest.raises(psycopg.errors.RaiseException, match="invalid_habit_configuration"):
            execute(f"update public.habits set {sql} where id=%s", (value, row["id"]))
    execute("delete from public.profiles where user_id=%s", (a,))
    assert execute("select count(*) from public.habits where id=%s", (row["id"],), True) == [(0,)]


def test_patch_omission_null_and_atomic_invalid_merge(users):
    a, *_ = users
    original = create(a, TARGET | {"description": "Original"})
    habit = original["id"]
    updated = patch(a, habit, {"name": "Changed", "description": None, "unit": None})[0][0]
    assert updated["description"] is None and updated["unit"] is None
    for key in ("id", "owner_id", "created_at", "type", "target", "schedule", "weekdays", "reminder_times"):
        assert updated[key] == original[key]
    for changes in [{}, {"type": "target"}, {"target": None}, {"schedule": "daily"}, {"weekdays": []},
                    {"name": None}, {"name": "Lost", "target": 0}, {"owner_id": str(a)}, {"archived_at": None}]:
        before = read(a, habit)
        with pytest.raises(psycopg.errors.RaiseException, match="invalid_habit_configuration"):
            patch(a, habit, changes)
        assert read(a, habit) == before
    changed = patch(a, habit, {"schedule": "daily", "weekdays": [], "target": 20})[0][0]
    assert changed["schedule"] == "daily" and changed["weekdays"] == [] and changed["target"] == 20
    binary = create(a)
    assert patch(a, binary["id"], {"target": None, "unit": None})[0][0]["target"] is None
    with pytest.raises(psycopg.errors.RaiseException, match="invalid_habit_configuration"):
        patch(a, binary["id"], {"unit": "pages"})


def test_privacy_including_accepted_friends(users):
    a, b, outsider, _ = users
    habit = create(a)["id"]
    request = service("select id from public.send_friend_request(%s,%s)", (a, b), True)[0][0]
    service("select id from public.accept_friend_request(%s,%s)", (request, b), True)
    for actor in [b, outsider]:
        assert service("select * from public.list_habits(%s,'all')", (actor,), True) == []
        for identifier in [habit, uuid4()]:
            assert read(actor, identifier) is None
            assert patch(actor, identifier, {"name": "Bad"}) == []
            assert lifecycle("archive", actor, identifier) == []
            assert lifecycle("restore", actor, identifier) == []
    assert read(a, habit)["name"] == "Read"
    archived = lifecycle("archive", a, habit)[0][0]
    assert read(b, habit) is None
    assert read(a, habit) == archived


def test_archive_restore_filters_order_and_preservation(users):
    a, *_ = users
    first, second = create(a, TARGET), create(a)
    habit = first["id"]
    archived = lifecycle("archive", a, habit)[0][0]
    assert archived["archived_at"] is not None
    assert lifecycle("archive", a, habit)[0][0] == archived
    assert read(a, habit) == archived
    for status, expected in [("active", [second]), ("archived", [archived]), ("all", [archived, second])]:
        assert [r[0] for r in service("select * from public.list_habits(%s,%s)", (a, status), True)] == expected
    # Deterministic UUID tie-breaker when creation timestamps match.
    execute("alter table public.habits disable trigger habits_guard_update")
    try:
        execute("update public.habits set created_at='2026-01-01' where owner_id=%s", (a,))
    finally:
        execute("alter table public.habits enable trigger habits_guard_update")
    listed = service("select * from public.list_habits(%s,'all')", (a,), True)
    assert [r[0]["id"] for r in listed] == sorted([habit, second["id"]])
    with pytest.raises(psycopg.errors.RaiseException, match="habit_archived"):
        patch(a, habit, {"name": "Bad"})
    with pytest.raises(psycopg.errors.RaiseException, match="habit_archived"):
        execute("update public.habits set configuration=%s where id=%s", (Jsonb(TARGET | {"name": "Bad"}), habit))
    restored = lifecycle("restore", a, habit)[0][0]
    assert restored["archived_at"] is None
    assert lifecycle("restore", a, habit)[0][0] == restored
    for key in CONFIG:
        assert restored[key] == archived[key] == first[key]
    assert patch(a, habit, {"name": "Changed"})[0][0]["name"] == "Changed"


def test_schedule_boundaries_and_large_target(users):
    a, *_ = users
    row = create(a, TARGET | {"target": 10**30, "weekdays": [7, 6, 5, 4, 3, 2, 1], "reminder_times": ["23:59", "00:00"]})
    assert row["target"] == 10**30 and row["weekdays"] == list(range(1, 8))
    assert row["reminder_times"] == ["00:00", "23:59"]
    for status in [None, "invalid"]:
        with pytest.raises(psycopg.errors.RaiseException):
            service("select * from public.list_habits(%s,%s)", (a, status), True)


def test_concurrent_updates_preserve_unrelated_changes(users):
    a, *_ = users
    habit = create(a, TARGET)["id"]
    # Hold first RPC transaction open so second must wait for its row lock.
    started = Event()
    pid = []
    def second():
        with psycopg.connect(URL) as conn, conn.cursor() as cursor:
            cursor.execute("set role service_role")
            cursor.execute("select pg_backend_pid()")
            pid.append(cursor.fetchone()[0])
            started.set()
            cursor.execute("select * from public.update_habit(%s,%s,%s)", (a, habit, Jsonb({"description": "Second update"})))
            return cursor.fetchone()[0]
    with psycopg.connect(URL) as conn, conn.cursor() as cursor, ThreadPoolExecutor(1) as pool:
        cursor.execute("set role service_role")
        cursor.execute("select * from public.update_habit(%s,%s,%s)", (a, habit, Jsonb({"name": "First update"})))
        future = pool.submit(second)
        try:
            assert started.wait(5)
            deadline = monotonic() + 5
            while monotonic() < deadline:
                waiting = execute("select wait_event_type from pg_stat_activity where pid=%s", (pid[0],), True)
                if waiting == [("Lock",)]:
                    break
                sleep(0.01)
            else:
                pytest.fail("Second RPC never waited on the first transaction's row lock")
        finally:
            # Release even when the assertion fails; otherwise pool shutdown waits.
            conn.commit()
        result = future.result(timeout=10)
    assert result["name"] == "First update" and result["description"] == "Second update"
    assert read(a, habit) == result


def test_concurrent_merge_validates_latest_configuration(users):
    a, *_ = users
    habit = create(a, TARGET)["id"]
    def update(changes):
        try: return patch(a, habit, changes)
        except psycopg.errors.RaiseException as exc: return exc.diag.message_primary
    # Both are valid initially. If daily commits first, weekday-only must be
    # rejected against the latest configuration rather than overwrite it.
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(update, [{"schedule": "daily", "weekdays": []}, {"weekdays": [2]}]))
    row = read(a, habit)
    assert (row["schedule"], row["weekdays"]) in [("daily", []), ("selected", [2])]
    assert any(isinstance(r, list) for r in results)
    # If weekday-only wins first, daily/[] remains valid and also succeeds.
    assert all(isinstance(r, list) or r == "invalid_habit_configuration" for r in results)


def test_concurrent_archives_preserve_first_timestamp(users):
    a, *_ = users
    habit = create(a)["id"]
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda _: lifecycle("archive", a, habit)[0][0], range(4)))
    assert all(r == results[0] for r in results)
    with ThreadPoolExecutor(4) as pool:
        restored = list(pool.map(lambda _: lifecycle("restore", a, habit)[0][0], range(4)))
    assert all(r == restored[0] for r in restored)
