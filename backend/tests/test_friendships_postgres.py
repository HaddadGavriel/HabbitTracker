"""Disposable-PostgreSQL checks. Set TEST_DATABASE_URL; never use a shared database."""
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest

URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not configured")


def execute(sql, params=(), fetch=False):
    with psycopg.connect(URL) as connection, connection.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchall() if fetch else None


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
    request = execute("select id from public.send_friend_request(%s,%s)", (a, b), True)[0][0]
    execute("update public.profiles set username='renamed_user' where user_id=%s", (b,))
    assert execute("select profile->>'username' from public.list_friend_requests(%s)", (a,), True) == [("renamed_user",)]
    with pytest.raises(psycopg.errors.CheckViolation):
        execute("insert into public.friend_relationships(requester_id,recipient_id) values (%s,%s)", (a, a))
    with psycopg.connect(URL) as connection, connection.cursor() as cursor:
        cursor.execute("set role authenticated")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cursor.execute("select * from public.friend_relationships")
    execute("delete from public.profiles where user_id=%s", (a,))
    assert execute("select count(*) from public.friend_relationships where id=%s", (request,), True)[0][0] == 0


def test_concurrent_opposite_send_and_stale_decisions(users):
    a, b, *_ = users
    def send(pair):
        try:
            return execute("select id from public.send_friend_request(%s,%s)", pair, True)[0][0]
        except psycopg.errors.RaiseException as exc:
            return exc.diag.message_primary
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(send, [(a, b), (b, a)]))
    assert sum(not isinstance(value, str) for value in results) == 1
    assert any(value in ("incoming_request_exists", "outgoing_request_exists") for value in results if isinstance(value, str))
    assert execute("select count(*) from public.friend_relationships where least(requester_id,recipient_id)=least(%s,%s)", (a, b), True)[0][0] == 1
    request = next(value for value in results if not isinstance(value, str))
    def decide(sql): return execute(sql, (request, b), True)
    with ThreadPoolExecutor(2) as pool:
        accepted, rejected = pool.map(decide, ["select id from public.accept_friend_request(%s,%s)", "select public.reject_friend_request(%s,%s)"])
    assert bool(accepted) != rejected[0][0]
    assert execute("select id from public.accept_friend_request(%s,%s)", (request, b), True) == []


def test_concurrent_duplicate_send_and_recipient_only_transition(users):
    a, b, outsider, _ = users
    def send():
        try: return execute("select id from public.send_friend_request(%s,%s)", (a, b), True)
        except psycopg.errors.RaiseException as exc: return exc.diag.message_primary
    with ThreadPoolExecutor(2) as pool: results = list(pool.map(lambda _: send(), range(2)))
    assert sum(isinstance(value, list) for value in results) == 1
    request = next(value[0][0] for value in results if isinstance(value, list))
    assert execute("select id from public.accept_friend_request(%s,%s)", (request, outsider), True) == []
    assert execute("select id from public.accept_friend_request(%s,%s)", (request, a), True) == []
    assert len(execute("select id from public.accept_friend_request(%s,%s)", (request, b), True)) == 1
