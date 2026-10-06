"""Disposable-PostgreSQL checks. Set TEST_DATABASE_URL; never use a shared database."""
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from time import monotonic, sleep
from uuid import uuid4

import pytest

psycopg = pytest.importorskip("psycopg", reason="PostgreSQL integration dependencies are not installed")

URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not configured")


def execute(sql, params=(), fetch=False):
    with psycopg.connect(URL) as connection, connection.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchall() if fetch else None


def execute_as(role, sql, params=(), fetch=False):
    """Run one operation as an API role while connection setup stays administrative."""
    with psycopg.connect(URL) as connection, connection.cursor() as cursor:
        cursor.execute(f"set role {role}")
        cursor.execute(sql, params)
        return cursor.fetchall() if fetch else None


def service(sql, params=(), fetch=False):
    return execute_as("service_role", sql, params, fetch)


@pytest.fixture
def users():
    ids = [uuid4() for _ in range(4)]
    with psycopg.connect(URL) as connection, connection.cursor() as cursor:
        for number, user_id in enumerate(ids):
            cursor.execute("insert into auth.users(id) values (%s)", (user_id,))
            cursor.execute("insert into public.profiles(user_id,username,display_name,timezone) values (%s,%s,%s,'UTC')", (user_id, f"user_{user_id.hex[:8]}", f"User {number}"))
    yield ids
    execute("delete from auth.users where id = any(%s)", (ids,))


def test_constraints_rls_current_names_and_cascade(users):
    a, b, *_ = users
    request = service("select id from public.send_friend_request(%s,%s)", (a, b), True)[0][0]
    execute("update public.profiles set username='renamed_user' where user_id=%s", (b,))
    assert service("select profile->>'username' from public.list_friend_requests(%s)", (a,), True) == [("renamed_user",)]
    with pytest.raises(psycopg.errors.CheckViolation):
        execute("insert into public.friend_relationships(requester_id,recipient_id) values (%s,%s)", (a, a))
    for role in ("anon", "authenticated"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            execute_as(role, "select * from public.friend_relationships", fetch=True)
    execute("delete from public.profiles where user_id=%s", (a,))
    assert execute("select count(*) from public.friend_relationships where id=%s", (request,), True)[0][0] == 0


@pytest.mark.parametrize("role", ["anon", "authenticated"])
@pytest.mark.parametrize("call", [
    "select * from public.relationship_view(null::public.friend_relationships, null::uuid)",
    "select * from public.send_friend_request(null::uuid, null::uuid)",
    "select * from public.list_friend_requests(null::uuid)",
    "select * from public.accept_friend_request(null::uuid, null::uuid)",
    "select public.reject_friend_request(null::uuid, null::uuid)",
    "select * from public.list_friends(null::uuid)",
    "select public.remove_friend(null::uuid, null::uuid)",
])
def test_client_roles_cannot_execute_relationship_functions(role, call):
    # The CI scaffold deliberately grants these roles default function EXECUTE.
    # This fails against the original migration that revoked only from PUBLIC.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, call, fetch=True)


def test_backend_role_cannot_execute_internal_helper():
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        service("select * from public.relationship_view(null::public.friend_relationships, null::uuid)", fetch=True)


def test_concurrent_opposite_send_and_stale_decisions(users):
    a, b, *_ = users
    barrier = Barrier(2)
    def send(pair):
        barrier.wait(timeout=5)
        try:
            return service("select id from public.send_friend_request(%s,%s)", pair, True)[0][0]
        except psycopg.errors.RaiseException as exc:
            return exc.diag.message_primary
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(send, [(a, b), (b, a)]))
    assert sum(not isinstance(value, str) for value in results) == 1
    assert any(value in ("incoming_request_exists", "outgoing_request_exists") for value in results if isinstance(value, str))
    assert execute("select count(*) from public.friend_relationships where least(requester_id,recipient_id)=least(%s,%s)", (a, b), True)[0][0] == 1
    request = next(value for value in results if not isinstance(value, str))
    recipient = execute("select recipient_id from public.friend_relationships where id=%s", (request,), True)[0][0]
    def decide(sql):
        barrier.wait(timeout=5)
        return service(sql, (request, recipient), True)
    with ThreadPoolExecutor(2) as pool:
        accepted, rejected = pool.map(decide, ["select id from public.accept_friend_request(%s,%s)", "select public.reject_friend_request(%s,%s)"])
    accept_succeeded = bool(accepted)
    reject_succeeded = rejected[0][0]
    assert accept_succeeded != reject_succeeded
    final = execute("select state from public.friend_relationships where id=%s", (request,), True)
    assert final == ([("accepted",)] if accept_succeeded else [])
    assert service("select id from public.accept_friend_request(%s,%s)", (request, recipient), True) == []


def test_concurrent_duplicate_send_and_recipient_only_transition(users):
    a, b, outsider, _ = users
    barrier = Barrier(2)
    def send():
        barrier.wait(timeout=5)
        try: return service("select id from public.send_friend_request(%s,%s)", (a, b), True)
        except psycopg.errors.RaiseException as exc: return exc.diag.message_primary
    with ThreadPoolExecutor(2) as pool: results = list(pool.map(lambda _: send(), range(2)))
    assert sum(isinstance(value, list) for value in results) == 1
    request = next(value[0][0] for value in results if isinstance(value, list))
    assert service("select id from public.accept_friend_request(%s,%s)", (request, outsider), True) == []
    assert service("select id from public.accept_friend_request(%s,%s)", (request, a), True) == []
    assert len(service("select id from public.accept_friend_request(%s,%s)", (request, b), True)) == 1


@pytest.mark.parametrize("role", ["anon", "authenticated"])
@pytest.mark.parametrize("sql", [
    "select * from public.friend_relationships",
    "insert into public.friend_relationships(requester_id,recipient_id) values (null,null)",
    "update public.friend_relationships set state='accepted' where false",
    "delete from public.friend_relationships where false",
])
def test_direct_client_table_access_is_denied(role, sql):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, sql)
    assert execute("select relrowsecurity from pg_class where oid='public.friend_relationships'::regclass", fetch=True) == [(True,)]
    assert execute("select count(*) from pg_policies where schemaname='public' and tablename='friend_relationships'", fetch=True) == [(0,)]


def test_database_validation_and_unordered_uniqueness(users):
    a, b, *_ = users
    missing = uuid4()
    for pair, error in [((a, a), "self_request"), ((a, missing), "recipient_not_found"), ((missing, b), "profile_not_found")]:
        with pytest.raises(psycopg.errors.RaiseException) as raised:
            service("select * from public.send_friend_request(%s,%s)", pair, True)
        assert raised.value.diag.message_primary == error
    service("select * from public.send_friend_request(%s,%s)", (a, b), True)
    # Prove the index independently of application conflict checks.
    with pytest.raises(psycopg.errors.UniqueViolation):
        execute("insert into public.friend_relationships(requester_id,recipient_id) values (%s,%s)", (b, a))
    for state, accepted_at in [("unknown", None), ("accepted", None), ("pending", "2026-01-01T00:00:00Z")]:
        with pytest.raises(psycopg.errors.CheckViolation):
            execute("update public.friend_relationships set state=%s,accepted_at=%s where requester_id=%s", (state, accepted_at, a))


def test_database_lifecycle_permissions_visibility_and_names(users):
    a, b, outsider, _ = users
    pending = service("select * from public.send_friend_request(%s,%s)", (a, b), True)[0]
    request, _, _, profile, created_at, updated_at, accepted_at = pending
    assert pending[1:3] == ("outgoing", "pending")
    assert set(profile) == {"user_id", "username", "display_name"}
    assert created_at == updated_at and accepted_at is None
    assert service("select * from public.list_friends(%s)", (a,), True) == []
    assert service("select * from public.list_friends(%s)", (b,), True) == []
    assert service("select direction from public.list_friend_requests(%s)", (b,), True) == [("incoming",)]
    assert service("select * from public.list_friend_requests(%s)", (outsider,), True) == []
    for actor in (a, outsider):
        assert service("select * from public.accept_friend_request(%s,%s)", (request, actor), True) == []
        assert service("select public.reject_friend_request(%s,%s)", (request, actor), True) == [(False,)]
    assert service("select public.remove_friend(%s,%s)", (a, b), True) == [(False,)]
    accepted = service("select * from public.accept_friend_request(%s,%s)", (request, b), True)[0]
    assert accepted[1:3] == ("incoming", "accepted")
    assert accepted[4] == created_at and accepted[5] == accepted[6] and accepted[6] >= created_at
    for actor in (a, b):
        assert service("select id from public.list_friends(%s)", (actor,), True) == [(request,)]
        assert service("select * from public.list_friend_requests(%s)", (actor,), True) == []
        with pytest.raises(psycopg.errors.RaiseException) as raised:
            service("select * from public.send_friend_request(%s,%s)", (actor, b if actor == a else a), True)
        assert raised.value.diag.message_primary == "friendship_exists"
    assert service("select * from public.list_friends(%s)", (outsider,), True) == []
    assert service("select public.remove_friend(%s,%s)", (outsider, b), True) == [(False,)]
    execute("update public.profiles set username='bob_renamed',display_name='Bob Renamed' where user_id=%s", (b,))
    assert service("select profile from public.list_friends(%s)", (a,), True) == [({"user_id": str(b), "username": "bob_renamed", "display_name": "Bob Renamed"},)]
    assert service("select * from public.accept_friend_request(%s,%s)", (request, b), True) == []
    assert service("select public.reject_friend_request(%s,%s)", (request, b), True) == [(False,)]
    assert service("select public.remove_friend(%s,%s)", (b, a), True) == [(True,)]
    assert service("select public.remove_friend(%s,%s)", (a, b), True) == [(False,)]
    again = service("select id from public.send_friend_request(%s,%s)", (b, a), True)[0][0]
    assert again != request
    assert service("select public.reject_friend_request(%s,%s)", (again, a), True) == [(True,)]
    assert service("select public.reject_friend_request(%s,%s)", (again, a), True) == [(False,)]
    assert service("select * from public.accept_friend_request(%s,%s)", (again, a), True) == []
    assert len(service("select * from public.send_friend_request(%s,%s)", (a, b), True)) == 1


def test_lists_have_deterministic_order_and_live_names(users):
    actor, *others = users
    requests = [service("select id from public.send_friend_request(%s,%s)", (actor, other), True)[0][0] for other in others]
    # Tie the timestamps to exercise the secondary ordering explicitly.
    execute("update public.friend_relationships set created_at='2026-01-01T00:00:00Z' where requester_id=%s", (actor,))
    assert service("select id from public.list_friend_requests(%s)", (actor,), True) == [(r,) for r in sorted(requests)]
    for request, other in zip(requests, others):
        service("select * from public.accept_friend_request(%s,%s)", (request, other), True)
    for other, name in zip(others, ("zzz_friend", "aaa_friend", "mmm_friend")):
        execute("update public.profiles set username=%s where user_id=%s", (name, other))
    assert service("select profile->>'username' from public.list_friends(%s)", (actor,), True) == [("aaa_friend",), ("mmm_friend",), ("zzz_friend",)]


@pytest.mark.parametrize("participant", [0, 1])
@pytest.mark.parametrize("accepted", [False, True])
def test_deleting_either_profile_cascades_pending_and_accepted(users, participant, accepted):
    a, b, *_ = users
    request = service("select id from public.send_friend_request(%s,%s)", (a, b), True)[0][0]
    if accepted:
        service("select * from public.accept_friend_request(%s,%s)", (request, b), True)
    execute("delete from public.profiles where user_id=%s", ((a, b)[participant],))
    assert execute("select count(*) from public.friend_relationships where id=%s", (request,), True) == [(0,)]


@pytest.mark.parametrize("operation", ["accept", "reject", "remove"])
def test_concurrent_identical_mutations_have_one_winner(users, operation):
    a, b, *_ = users
    request = service("select id from public.send_friend_request(%s,%s)", (a, b), True)[0][0]
    if operation == "remove":
        service("select * from public.accept_friend_request(%s,%s)", (request, b), True)
        calls = [("select public.remove_friend(%s,%s)", (a, b)), ("select public.remove_friend(%s,%s)", (b, a))]
    else:
        sql = "select id from public.accept_friend_request(%s,%s)" if operation == "accept" else "select public.reject_friend_request(%s,%s)"
        calls = [(sql, (request, b))] * 2
    barrier = Barrier(2)

    def mutate(call):
        barrier.wait(timeout=5)
        return service(*call, fetch=True)

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(mutate, calls))
    successes = [bool(result) if operation == "accept" else result[0][0] for result in results]
    assert sum(successes) == 1


def test_send_retries_when_conflicting_friendship_disappears(users):
    """Pause after INSERT/ON CONFLICT, delete the old row, then resume SELECT.

    A statement trigger runs even when ON CONFLICT inserts no row. It is test
    instrumentation only; no production functions or migrations are modified.
    """
    a, b, *_ = users
    old = service("select id from public.send_friend_request(%s,%s)", (a, b), True)[0][0]
    service("select * from public.accept_friend_request(%s,%s)", (old, b), True)
    lock_key = uuid4().int % (2**31)
    application = f"racing_send_{lock_key}"
    execute(f"""
        create function public.test_pause_friend_insert() returns trigger
        language plpgsql as $$
        begin
          if current_setting('application_name') = '{application}' then
            perform pg_advisory_xact_lock({lock_key});
          end if;
          return null;
        end $$;
        create trigger test_pause_friend_insert after insert on public.friend_relationships
          for each statement execute function public.test_pause_friend_insert();
    """)

    def send():
        with psycopg.connect(URL, application_name=application, options="-c statement_timeout=10000") as connection:
            connection.execute("set role service_role")
            return connection.execute("select id,state from public.send_friend_request(%s,%s)", (a, b)).fetchall()

    try:
        with psycopg.connect(URL, autocommit=True) as gate, ThreadPoolExecutor(1) as pool:
            gate.execute("select pg_advisory_lock(%s)", (lock_key,))
            future = pool.submit(send)
            try:
                deadline = monotonic() + 5
                while monotonic() < deadline:
                    waiting = execute("select count(*) from pg_stat_activity where application_name=%s and wait_event='advisory'", (application,), True)[0][0]
                    if waiting:
                        break
                    if future.done():
                        pytest.fail(f"Send did not reach the conflict retry window: {future.exception()}")
                    sleep(0.01)
                else:
                    pytest.fail("Send did not reach the controlled race window")
                assert service("select public.remove_friend(%s,%s)", (b, a), True) == [(True,)]
            finally:
                gate.execute("select pg_advisory_unlock(%s)", (lock_key,))
            rows = future.result(timeout=5)
        assert len(rows) == 1 and rows[0][0] != old and rows[0][1] == "pending"
        assert service("select id from public.list_friend_requests(%s)", (a,), True) == [(rows[0][0],)]
    finally:
        execute("drop trigger test_pause_friend_insert on public.friend_relationships; drop function public.test_pause_friend_insert()")
