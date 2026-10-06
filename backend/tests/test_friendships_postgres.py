"""Disposable-PostgreSQL checks. Set TEST_DATABASE_URL; never use a shared database."""
import os
from concurrent.futures import ThreadPoolExecutor
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
    def send(pair):
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
    def decide(sql): return service(sql, (request, recipient), True)
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
    def send():
        try: return service("select id from public.send_friend_request(%s,%s)", (a, b), True)
        except psycopg.errors.RaiseException as exc: return exc.diag.message_primary
    with ThreadPoolExecutor(2) as pool: results = list(pool.map(lambda _: send(), range(2)))
    assert sum(isinstance(value, list) for value in results) == 1
    request = next(value[0][0] for value in results if isinstance(value, list))
    assert service("select id from public.accept_friend_request(%s,%s)", (request, outsider), True) == []
    assert service("select id from public.accept_friend_request(%s,%s)", (request, a), True) == []
    assert len(service("select id from public.accept_friend_request(%s,%s)", (request, b), True)) == 1
