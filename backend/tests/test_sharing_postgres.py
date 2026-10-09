"""Selective sharing against disposable PostgreSQL; all product RPCs use service_role."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from time import monotonic, sleep
from uuid import uuid4

import pytest

from test_friendships_postgres import URL, execute, execute_as, psycopg, service, users
from test_habits_postgres import CONFIG, TARGET, create, lifecycle, patch, read
from test_occurrences_postgres import clock, mutation, occurrences, zone

pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not configured")

PUBLIC_IDENTITY = {"user_id", "username", "display_name"}
SHARED_FIELDS = {"id", "owner", "configuration", "local_date", "timezone", "server_time", "due_today", "occurrence", "current_streak", "provisional", "calculated_at"}
OCCURRENCE_FIELDS = {"id", "local_date", "timezone", "closes_at", "snapshot", "progress", "completed", "state"}


def befriend(owner, friend):
    relationship = service("select id from public.send_friend_request(%s,%s)", (owner, friend), True)[0][0]
    service("select id from public.accept_friend_request(%s,%s)", (relationship, friend), True)
    return relationship


def grant(owner, habit, friend):
    rows = service("select * from public.grant_habit_share(%s,%s,%s)", (owner, habit, friend), True)
    return rows[0][0] if rows else None


def revoke(owner, habit, friend):
    return service("select public.revoke_habit_share(%s,%s,%s)", (owner, habit, friend), True)[0][0]


def shares(owner, habit):
    return service("select public.list_habit_shares(%s,%s)", (owner, habit), True)[0][0]


def shared(recipient, habit):
    rows = service("select * from public.get_shared_habit(%s,%s)", (recipient, habit), True)
    return rows[0][0] if rows else None


def shared_list(recipient):
    return [r[0] for r in service("select * from public.list_shared_habits(%s)", (recipient,), True)]


def remove(owner, friend):
    return service("select public.remove_friend(%s,%s)", (owner, friend), True)[0][0]


def test_owner_grant_list_revoke_and_selective_recipient_views(users, clock):
    owner, friend, other_friend, outsider = users
    befriend(owner, friend); befriend(owner, other_friend)
    habit, private = create(owner, TARGET), create(owner)
    assert shares(owner, habit["id"]) == []
    assert shared_list(friend) == [] and shared(friend, habit["id"]) is None
    first = grant(owner, habit["id"], friend)
    assert set(first) == PUBLIC_IDENTITY and first["user_id"] == str(friend)
    assert grant(owner, habit["id"], friend) == first
    assert shares(owner, habit["id"]) == [first]
    view = shared(friend, habit["id"])
    assert shared_list(friend) == [view]
    assert set(view) == SHARED_FIELDS and set(view["owner"]) == PUBLIC_IDENTITY
    assert view["owner"]["user_id"] == str(owner)
    assert view["id"] == habit["id"] and view["configuration"] == TARGET
    assert view["local_date"] == "2026-03-01" and view["timezone"] == "UTC"
    assert view["server_time"] == "2026-03-01T12:00:00+00:00" and view["due_today"] is True
    occurrence = view["occurrence"]
    assert set(occurrence) == OCCURRENCE_FIELDS and occurrence["snapshot"] == TARGET
    assert (occurrence["progress"], occurrence["completed"], occurrence["state"]) == (0, False, "in_progress")
    assert occurrence["closes_at"] == "2026-03-02T00:00:00+00:00"
    for actor in [friend, other_friend, outsider]:
        assert shared(actor, private["id"]) is None
    for actor in [owner, other_friend, outsider]:
        assert shared(actor, habit["id"]) is None and shared_list(actor) == []
    # Grant and owner identities always reflect public profile changes.
    service("update public.profiles set username='renamed_friend',display_name='Renamed friend' where user_id=%s", (friend,))
    service("update public.profiles set display_name='Renamed owner' where user_id=%s", (owner,))
    assert shares(owner, habit["id"])[0] == {"user_id": str(friend), "username": "renamed_friend", "display_name": "Renamed friend"}
    assert shared(friend, habit["id"])["owner"]["display_name"] == "Renamed owner"
    assert revoke(owner, habit["id"], friend) is True
    assert revoke(owner, habit["id"], friend) is True
    assert shares(owner, habit["id"]) == [] and shared_list(friend) == []
    assert shared(friend, habit["id"]) is None


def test_grant_requires_current_accepted_friend_and_owner_before_idempotency(users, clock):
    owner, friend, outsider, _ = users
    habit = create(owner)["id"]
    for recipient, error in [(owner, "self_share"), (friend, "friendship_required"), (uuid4(), "friendship_required")]:
        with pytest.raises(psycopg.errors.RaiseException, match=error):
            grant(owner, habit, recipient)
    request = service("select id from public.send_friend_request(%s,%s)", (owner, friend), True)[0][0]
    with pytest.raises(psycopg.errors.RaiseException, match="friendship_required"):
        grant(owner, habit, friend)
    service("select id from public.accept_friend_request(%s,%s)", (request, friend), True)
    grant(owner, habit, friend)
    for actor in [friend, outsider]:
        for identifier in [habit, uuid4()]:
            assert grant(actor, identifier, friend) is None
            assert revoke(actor, identifier, friend) is False
            assert shares(actor, identifier) is None
    assert len(shares(owner, habit)) == 1
    assert revoke(owner, uuid4(), friend) is False
    assert grant(owner, uuid4(), owner) is None


def test_recipients_cannot_use_existing_owner_habit_or_occurrence_rpcs(users, clock):
    owner, recipient, *_ = users
    befriend(owner, recipient)
    habit = create(owner, TARGET)["id"]
    grant(owner, habit, recipient)
    before = shared(recipient, habit)
    oid = before["occurrence"]["id"]
    assert read(recipient, habit) is None
    assert service("select * from public.list_habits(%s,'all')", (recipient,), True) == []
    assert patch(recipient, habit, {"name": "Stolen"}) == []
    assert lifecycle("archive", recipient, habit) == []
    assert lifecycle("restore", recipient, habit) == []
    for operation, value in [("completion", True), ("completion", False), ("progress", 20), ("adjustment", 20)]:
        assert mutation(recipient, oid, operation, value, "forged") is None
    assert shared(recipient, habit) == before


def test_friendship_removal_atomically_revokes_both_directions_without_resurrection(users, clock):
    owner, friend, other, _ = users
    first_relationship = befriend(owner, friend); befriend(owner, other)
    owners_habit, friends_habit = create(owner)["id"], create(friend)["id"]
    grant(owner, owners_habit, friend); grant(friend, friends_habit, owner)
    grant(owner, owners_habit, other)
    assert remove(friend, owner) is True
    assert shared_list(owner) == shared_list(friend) == []
    assert shared(owner, friends_habit) is None and shared(friend, owners_habit) is None
    assert [p["user_id"] for p in shares(owner, owners_habit)] == [str(other)]
    assert shares(friend, friends_habit) == []
    assert execute("select count(*) from public.habit_shares where relationship_id=%s", (first_relationship,), True) == [(0,)]
    second_relationship = befriend(friend, owner)
    assert second_relationship != first_relationship
    assert shared_list(owner) == shared_list(friend) == []
    grant(owner, owners_habit, friend)
    assert shared(friend, owners_habit) is not None
    assert shared(owner, friends_habit) is None


def test_archive_restore_preserves_grants_but_hides_views(users, clock):
    owner, friend, *_ = users
    befriend(owner, friend)
    habit = create(owner)["id"]; grant(owner, habit, friend)
    saved_grants = shares(owner, habit)
    lifecycle("archive", owner, habit)
    assert shared(friend, habit) is None and shared_list(friend) == []
    assert shares(owner, habit) == saved_grants
    assert grant(owner, habit, friend) == saved_grants[0]
    lifecycle("restore", owner, habit)
    assert shared(friend, habit) is not None
    lifecycle("archive", owner, habit)
    revoke(owner, habit, friend)
    lifecycle("restore", owner, habit)
    assert shared(friend, habit) is None
    grant(owner, habit, friend)
    lifecycle("archive", owner, habit)
    remove(owner, friend); befriend(owner, friend)
    lifecycle("restore", owner, habit)
    assert shares(owner, habit) == [] and shared(friend, habit) is None


@pytest.mark.parametrize("participant", [0, 1])
@pytest.mark.parametrize("table,column", [("public.profiles", "user_id"), ("auth.users", "id")])
def test_profile_and_account_deletion_cascade_shares_in_both_directions(users, clock, participant, table, column):
    owner, friend, *_ = users
    relationship = befriend(owner, friend)
    habit, reverse = create(owner)["id"], create(friend)["id"]
    grant(owner, habit, friend); grant(friend, reverse, owner)
    execute(f"delete from {table} where {column}=%s", (users[participant],))
    assert execute("select count(*) from public.habit_shares where relationship_id=%s", (relationship,), True) == [(0,)]
    assert shared_list(users[1 - participant]) == []
    with pytest.raises(psycopg.errors.RaiseException, match="profile_not_found"):
        shared_list(users[participant])


@pytest.mark.parametrize("owner_zone,recipient_zone,instant,local_date,closing", [
    ("America/New_York", "Asia/Tokyo", "2026-03-02 02:00+00", "2026-03-01", "2026-03-02T05:00:00+00:00"),
    ("Asia/Tokyo", "America/Los_Angeles", "2026-03-01 20:00+00", "2026-03-02", "2026-03-02T15:00:00+00:00"),
    ("America/New_York", "UTC", "2026-03-08 05:00+00", "2026-03-08", "2026-03-09T04:00:00+00:00"),
])
def test_shared_today_uses_owner_timezone_including_dst(users, clock, owner_zone, recipient_zone, instant, local_date, closing):
    owner, friend, *_ = users
    clock(instant); zone(owner, owner_zone); zone(friend, recipient_zone)
    befriend(owner, friend)
    habit = create(owner)["id"]; grant(owner, habit, friend)
    view = shared(friend, habit)
    assert view["local_date"] == view["occurrence"]["local_date"] == local_date
    assert view["timezone"] == view["occurrence"]["timezone"] == owner_zone
    assert view["occurrence"]["closes_at"] == closing
    assert shared_list(friend) == [view]


def test_list_keeps_each_owner_today_and_snapshot_timezone_after_profile_edit(users, clock):
    owner, another_owner, friend, _ = users
    clock("2026-03-01 20:00+00")
    zone(owner, "America/New_York"); zone(another_owner, "Asia/Tokyo"); zone(friend, "UTC")
    befriend(owner, friend); befriend(another_owner, friend)
    first, second = create(owner)["id"], create(another_owner)["id"]
    grant(owner, first, friend); grant(another_owner, second, friend)
    before = shared(friend, first)["occurrence"]
    zone(owner, "America/Los_Angeles")
    by_habit = {view["id"]: view for view in shared_list(friend)}
    assert by_habit[first]["local_date"] == "2026-03-01"
    assert by_habit[first]["timezone"] == "America/Los_Angeles"
    assert by_habit[first]["occurrence"] == before
    assert before["timezone"] == "America/New_York"
    assert by_habit[second]["local_date"] == "2026-03-02"
    assert by_habit[second]["timezone"] == "Asia/Tokyo"


def test_unscheduled_today_is_explicit_and_configuration_distinct_from_snapshot(users, clock):
    owner, friend, *_ = users
    befriend(owner, friend)
    unscheduled = create(owner, TARGET | {"weekdays": [1]})["id"]
    target = create(owner, TARGET)["id"]
    grant(owner, unscheduled, friend); grant(owner, target, friend)
    view = shared(friend, unscheduled)
    assert view["due_today"] is False and view["occurrence"] is None
    old = shared(friend, target)["occurrence"]
    mutation(owner, old["id"], "progress", 7)
    patch(owner, target, {"target": 5, "name": "New name", "unit": "new unit"})
    view = shared(friend, target)
    assert view["configuration"]["target"] == 5 and view["configuration"]["name"] == "New name"
    assert view["occurrence"]["id"] == old["id"] and view["occurrence"]["snapshot"] == TARGET
    assert (view["occurrence"]["progress"], view["occurrence"]["completed"], view["occurrence"]["state"]) == (7, False, "in_progress")
    mutation(owner, old["id"], "progress", 10)
    assert shared(friend, target)["occurrence"]["state"] == "completed"


@pytest.mark.parametrize("operation", ["list", "detail"])
def test_authorized_reads_reconcile_stale_owner_occurrences(users, clock, operation):
    owner, friend, *_ = users
    befriend(owner, friend)
    habit = create(owner)["id"]; grant(owner, habit, friend)
    clock("2026-03-04 12:00+00")
    assert [o["local_date"] for o in occurrences(owner)] == ["2026-03-01"]
    view = shared_list(friend)[0] if operation == "list" else shared(friend, habit)
    assert view["local_date"] == view["occurrence"]["local_date"] == "2026-03-04"
    rows = occurrences(owner)
    assert [o["local_date"] for o in rows] == [f"2026-03-0{i}" for i in range(1, 5)]
    assert [o["state"] for o in rows] == ["missed", "missed", "missed", "in_progress"]


def test_unauthorized_and_archived_reads_do_not_reconcile_another_owner(users, clock):
    owner, friend, outsider, _ = users
    befriend(owner, friend)
    private, archived = create(owner)["id"], create(owner)["id"]
    grant(owner, archived, friend); lifecycle("archive", owner, archived)
    before = occurrences(owner)
    clock("2026-03-04 12:00+00")
    for actor in [friend, outsider]:
        assert shared_list(actor) == []
        for habit in [private, archived, uuid4()]:
            assert shared(actor, habit) is None
    assert occurrences(owner) == before


@pytest.mark.parametrize("restriction", ["revoke", "unfriend"])
def test_former_recipients_cannot_trigger_reconciliation(users, clock, restriction):
    owner, friend, *_ = users
    befriend(owner, friend)
    habit = create(owner)["id"]; grant(owner, habit, friend)
    if restriction == "revoke":
        revoke(owner, habit, friend)
    else:
        remove(owner, friend)
    before = occurrences(owner)
    clock("2026-03-04 12:00+00")
    assert shared_list(friend) == [] and shared(friend, habit) is None
    assert occurrences(owner) == before


ENTRY_POINTS = [
    ("grant_habit_share(uuid,uuid,uuid)", "grant_habit_share(null::uuid,null::uuid,null::uuid)"),
    ("revoke_habit_share(uuid,uuid,uuid)", "revoke_habit_share(null::uuid,null::uuid,null::uuid)"),
    ("list_habit_shares(uuid,uuid)", "list_habit_shares(null::uuid,null::uuid)"),
    ("list_shared_habits(uuid)", "list_shared_habits(null::uuid)"),
    ("get_shared_habit(uuid,uuid)", "get_shared_habit(null::uuid,null::uuid)"),
]


@pytest.mark.parametrize("signature,call", ENTRY_POINTS)
def test_sharing_rpcs_require_existing_profile(signature, call):
    with pytest.raises(psycopg.errors.RaiseException, match="profile_not_found"):
        service("select public." + call, fetch=True)


@pytest.mark.parametrize("role", ["anon", "authenticated"])
@pytest.mark.parametrize("signature,call", ENTRY_POINTS)
def test_client_roles_cannot_execute_sharing_rpcs(role, signature, call):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, "select public." + call, fetch=True)


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("operation", ["select", "insert", "update", "delete"])
def test_direct_sharing_table_access_is_denied(role, operation):
    sql = {"select": "select * from public.habit_shares", "insert": "insert into public.habit_shares default values",
           "update": "update public.habit_shares set recipient_id=null", "delete": "delete from public.habit_shares"}[operation]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, sql)


HELPERS = [
    ("lock_share_profiles(uuid[])", "lock_share_profiles(array[]::uuid[])"),
    ("shared_habit_view(public.habits,jsonb)", "shared_habit_view(null::public.habits,null::jsonb)"),
]


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("signature,call", ENTRY_POINTS + HELPERS)
def test_function_privileges_security_definer_and_fixed_search_path(role, signature, call):
    entry_point = (signature, call) in ENTRY_POINTS
    expected = role == "service_role" and entry_point
    assert execute("select has_function_privilege(%s,%s,'EXECUTE')", (role, "public." + signature), True) == [(expected,)]
    assert execute("select prosecdef,proconfig from pg_proc where oid=%s::regprocedure", ("public." + signature,), True) == [(entry_point, ['search_path=""'])]
    assert execute("select count(*) from pg_proc p,lateral aclexplode(p.proacl) a where p.oid=%s::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'", ("public." + signature,), True) == [(0,)]
    if not expected:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            execute_as(role, "select public." + call, fetch=True)


def test_sharing_table_retains_rls_and_has_no_client_policies():
    assert execute("select relrowsecurity from pg_class where oid='public.habit_shares'::regclass", fetch=True) == [(True,)]
    assert execute("select count(*) from pg_policies where schemaname='public' and tablename='habit_shares'", fetch=True) == [(0,)]


def test_sharing_database_unique_grant_owner_fk_and_relationship_cascade(users, clock):
    owner, friend, outsider, _ = users
    relationship = befriend(owner, friend)
    habit = create(owner)["id"]; grant(owner, habit, friend)
    sql = "insert into public.habit_shares(habit_id,owner_id,recipient_id,relationship_id) values(%s,%s,%s,%s)"
    with pytest.raises(psycopg.errors.UniqueViolation):
        execute(sql, (habit, owner, friend, relationship))
    revoke(owner, habit, friend)
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        execute(sql, (habit, outsider, friend, relationship))
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        execute(sql, (habit, owner, friend, uuid4()))
    grant(owner, habit, friend)
    execute("delete from public.friend_relationships where id=%s", (relationship,))
    assert shares(owner, habit) == []


def ordered_rpcs(first_sql, first_args, second_sql, second_args):
    """Hold a real successful RPC uncommitted and prove the second waits on it."""
    started = Event()
    pid = []
    def second():
        try:
            with psycopg.connect(URL) as connection, connection.cursor() as cursor:
                cursor.execute("set role service_role")
                cursor.execute("set statement_timeout='10s'")
                cursor.execute("select pg_backend_pid()")
                pid.append(cursor.fetchone()[0]); started.set()
                cursor.execute(second_sql, second_args)
                return cursor.fetchall()
        except psycopg.errors.RaiseException as exc:
            return exc.diag.message_primary
    with psycopg.connect(URL) as connection, connection.cursor() as cursor, ThreadPoolExecutor(1) as pool:
        cursor.execute("set role service_role")
        cursor.execute("set statement_timeout='10s'")
        cursor.execute(first_sql, first_args)
        first_result = cursor.fetchall()
        future = pool.submit(second)
        try:
            assert started.wait(5)
            deadline = monotonic() + 5
            while monotonic() < deadline:
                if execute("select wait_event_type from pg_stat_activity where pid=%s", (pid[0],), True) == [("Lock",)]:
                    break
                if future.done():
                    pytest.fail(f"Second RPC did not serialize with the first: {future.result()}")
                sleep(0.01)
            else:
                pytest.fail("Second RPC never reached the first transaction's lock")
        finally:
            connection.commit()
        return first_result, future.result(timeout=12)


@pytest.mark.parametrize("grant_first", [True, False])
def test_concurrent_grant_and_friendship_removal_follow_transaction_order(users, clock, grant_first):
    owner, friend, *_ = users
    befriend(owner, friend)
    habit = create(owner)["id"]
    granting = ("select * from public.grant_habit_share(%s,%s,%s)", (owner, habit, friend))
    removing = ("select public.remove_friend(%s,%s)", (friend, owner))
    first, second = ordered_rpcs(*(granting + removing if grant_first else removing + granting))
    if grant_first:
        assert first[0][0]["user_id"] == str(friend) and second == [(True,)]
    else:
        assert first == [(True,)] and second == "friendship_required"
    assert shares(owner, habit) == [] and shared(friend, habit) is None
    befriend(owner, friend)
    assert shared_list(friend) == []


@pytest.mark.parametrize("read_first", [True, False])
@pytest.mark.parametrize("read_kind", ["list", "detail"])
@pytest.mark.parametrize("change", ["revoke", "archive", "unfriend"])
def test_concurrent_shared_read_and_permission_change_follow_transaction_order(users, clock, read_first, read_kind, change):
    owner, friend, *_ = users
    befriend(owner, friend)
    habit = create(owner)["id"]; grant(owner, habit, friend)
    before = occurrences(owner)
    clock("2026-03-04 12:00+00")
    reading = (("select * from public.list_shared_habits(%s)", (friend,)) if read_kind == "list" else
               ("select * from public.get_shared_habit(%s,%s)", (friend, habit)))
    changing = {"revoke": ("select public.revoke_habit_share(%s,%s,%s)", (owner, habit, friend)),
                "archive": ("select * from public.archive_habit(%s,%s)", (owner, habit)),
                "unfriend": ("select public.remove_friend(%s,%s)", (owner, friend))}[change]
    first, second = ordered_rpcs(*(reading + changing if read_first else changing + reading))
    read_result = first if read_first else second
    assert [row[0]["id"] for row in read_result] == ([habit] if read_first else [])
    assert shared(friend, habit) is None and shared_list(friend) == []
    if read_first or change == "archive":
        assert len(occurrences(owner)) == 4
    else:
        assert occurrences(owner) == before


def test_overlapping_multi_owner_reads_and_opposite_shares_do_not_deadlock(users, clock):
    a, b, c, _ = sorted(users)
    befriend(a, b); befriend(a, c); befriend(b, c)
    ha, hb, hc = create(a)["id"], create(b)["id"], create(c)["id"]
    for owner, habit, recipient in [(a, ha, b), (a, ha, c), (b, hb, a), (b, hb, c), (c, hc, a), (c, hc, b)]:
        grant(owner, habit, recipient)
    clock("2026-03-04 12:00+00")
    operations = [("select * from public.list_shared_habits(%s)", (a,)),
                  ("select * from public.list_shared_habits(%s)", (b,)),
                  ("select * from public.list_shared_habits(%s)", (c,)),
                  ("select * from public.grant_habit_share(%s,%s,%s)", (a, ha, b)),
                  ("select * from public.grant_habit_share(%s,%s,%s)", (b, hb, a)),
                  ("select public.remove_friend(%s,%s)", (b, a)),
                  ("select public.get_today(%s)", (c,))]
    barrier = Barrier(len(operations))
    def run(operation):
        try:
            with psycopg.connect(URL) as connection, connection.cursor() as cursor:
                cursor.execute("set role service_role")
                cursor.execute("set statement_timeout='10s'")
                barrier.wait(timeout=5)
                cursor.execute(*operation)
                return cursor.fetchall()
        except psycopg.errors.RaiseException as exc:
            assert exc.diag.message_primary == "friendship_required"
            return exc.diag.message_primary
    with ThreadPoolExecutor(len(operations)) as pool:
        results = list(pool.map(run, operations))
    assert results[5] == [(True,)]
    assert shared(a, hb) is None and shared(b, ha) is None
    assert shared(c, ha) is not None and shared(c, hb) is not None
    assert [o["local_date"] for o in occurrences(c)] == [f"2026-03-0{i}" for i in range(1, 5)]


def test_list_retries_when_another_owner_is_granted_between_discovery_and_locks(users, clock):
    """A new grant followed by old revocation must never produce a mixed empty list."""
    owner, another_owner, recipient, _ = users
    befriend(owner, recipient); befriend(another_owner, recipient)
    old_habit, new_habit = create(owner)["id"], create(another_owner)["id"]
    grant(owner, old_habit, recipient)
    before = occurrences(owner)
    clock("2026-03-04 12:00+00")
    lock_key = uuid4().int % (2**31)
    application = f"sharing_list_discovery_{lock_key}"
    original = execute("select pg_get_functiondef('public.lock_share_profiles(uuid[])'::regprocedure)", fetch=True)[0][0]
    # Disposable administrator-only instrumentation widens a real gap without
    # adding a clock/gate input to a production RPC or granting client access.
    execute(f"""create or replace function public.lock_share_profiles(p_users uuid[])
        returns void language plpgsql set search_path='' as $$
        begin
          if current_setting('application_name') = '{application}' then
            perform pg_advisory_xact_lock({lock_key});
          end if;
          perform 1 from public.profiles where user_id=any(p_users) order by user_id for update;
        end $$""")

    def read_during_gap():
        with psycopg.connect(URL, application_name=application, options="-c statement_timeout=10000") as connection:
            connection.execute("set role service_role")
            return connection.execute("select * from public.list_shared_habits(%s)", (recipient,)).fetchall()

    try:
        with psycopg.connect(URL, autocommit=True) as gate, ThreadPoolExecutor(1) as pool:
            gate.execute("select pg_advisory_lock(%s)", (lock_key,))
            future = pool.submit(read_during_gap)
            try:
                deadline = monotonic() + 5
                while monotonic() < deadline:
                    if execute("select count(*) from pg_stat_activity where application_name=%s and wait_event='advisory'", (application,), True) == [(1,)]:
                        break
                    if future.done():
                        pytest.fail(f"List did not reach the discovery gap: {future.result()}")
                    sleep(0.01)
                else:
                    pytest.fail("List never paused after discovering its original owner")
                grant(another_owner, new_habit, recipient)
                revoke(owner, old_habit, recipient)
            finally:
                gate.execute("select pg_advisory_unlock(%s)", (lock_key,))
            rows = future.result(timeout=12)
        assert [row[0]["id"] for row in rows] == [new_habit]
        assert rows[0][0]["occurrence"]["local_date"] == "2026-03-04"
        assert occurrences(owner) == before
        assert len(occurrences(another_owner)) == 4
    finally:
        execute(original)
