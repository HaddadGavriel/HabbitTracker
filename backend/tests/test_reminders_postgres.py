"""Friend reminders against disposable PostgreSQL, with no provider requests.

Product operations use service_role RPCs. Administrator access is limited to
fixtures, the private existing occurrence clock, and security/catalog checks.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from test_friendships_postgres import URL, execute, execute_as, psycopg, service, users
from test_habits_postgres import CONFIG, TARGET, create, lifecycle, patch
from test_occurrences_postgres import clock, mutation, occurrences, today, zone
from test_excuses_postgres import decide, submit
from test_sharing_postgres import befriend, grant, ordered_rpcs, remove, revoke, shared

pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not configured")

RESERVE = "select * from public.reserve_habit_reminder(%s,%s,%s)"
FINISH = "select * from public.finish_habit_reminder(%s,%s,%s)"
REGISTER = "select public.register_device(%s,%s,%s)"
SUMMARY_FIELDS = {
    "id", "habit_id", "occurrence_id", "status", "reserved_at", "finished_at",
    "retry_at", "device_count", "accepted_count", "failed_count", "unknown_count",
}


def reserve(sender, habit, key="reminder-1"):
    rows = service(RESERVE, (sender, habit, key), True)
    return rows[0][0] if rows else None


def finish(sender, reminder, results):
    rows = service(FINISH, (sender, reminder, Jsonb(results)), True)
    return rows[0][0] if rows else None


def register(owner, token=None, platform="ios"):
    token = token or f"ExponentPushToken[{uuid4().hex}]"
    service(REGISTER, (owner, token, platform), True)
    return token


def setup_shared(owner, sender, config=None, devices=1):
    befriend(owner, sender)
    habit = create(owner, config)["id"]
    grant(owner, habit, sender)
    tokens = [register(owner) for _ in range(devices)]
    return habit, tokens


def results_for(reservation, *statuses):
    statuses = statuses or ("accepted",) * len(reservation["devices"])
    assert len(statuses) == len(reservation["devices"])
    return [
        {"device_id": device["id"], "status": status,
         "ticket_id": f"ticket-{index}" if status == "accepted" else None}
        for index, (device, status) in enumerate(zip(reservation["devices"], statuses))
    ]


def saved_reminders(sender):
    return execute("select to_jsonb(r) from public.habit_reminders r where sender_id=%s order by reserved_at,id",
                   (sender,), True)


def test_reservation_uses_owner_devices_and_server_generated_identifiers(users, clock):
    owner, sender, *_ = users
    habit, tokens = setup_shared(owner, sender, devices=2)
    sender_token = register(sender)
    occurrence = occurrences(owner)[0]
    reservation = reserve(sender, habit)
    assert set(reservation) == {"dispatch", "result", "devices", "notification"}
    assert reservation["dispatch"] is True
    summary = reservation["result"]
    assert set(summary) == SUMMARY_FIELDS
    assert summary == {
        "id": summary["id"], "habit_id": habit, "occurrence_id": occurrence["id"],
        "status": "reserved", "reserved_at": "2026-03-01T12:00:00+00:00",
        "finished_at": None, "retry_at": "2026-03-01T13:00:00+00:00",
        "device_count": 2, "accepted_count": 0, "failed_count": 0, "unknown_count": 0,
    }
    assert {device["expo_push_token"] for device in reservation["devices"]} == set(tokens)
    assert all(set(device) == {"id", "expo_push_token", "updated_at"} for device in reservation["devices"])
    assert sender_token not in str(reservation)
    notification = reservation["notification"]
    assert set(notification) == {"title", "body", "data"}
    assert notification["title"] and notification["body"]
    assert notification["data"]["habit_id"] == habit
    assert notification["data"]["occurrence_id"] == occurrence["id"]
    assert not ({"token", "expo_push_token", "explanation"} & notification["data"].keys())
    stored = saved_reminders(sender)[0][0]
    assert stored["owner_id"] == str(owner) and stored["sender_id"] == str(sender)
    assert stored["devices"] == reservation["devices"]
    assert stored["notification"] == notification
    assert occurrences(owner)[0] == occurrence


def test_missing_devices_is_persisted_idempotent_and_consumes_cooldown(users, clock):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender, devices=0)
    first = reserve(sender, habit)
    assert set(first) == {"dispatch", "result"} and first["dispatch"] is False
    assert first["result"]["status"] == "no_devices"
    assert first["result"]["device_count"] == 0
    assert first["result"]["finished_at"] == "2026-03-01T12:00:00+00:00"
    register(owner)
    assert reserve(sender, habit) == first
    assert reserve(sender, habit, "new") == {
        "error": "reminder_cooldown", "retry_at": "2026-03-01T13:00:00+00:00"}
    clock("2026-03-01 13:00+00")
    assert reserve(sender, habit, "new")["dispatch"] is True
    assert reserve(sender, habit) == first


@pytest.mark.parametrize("access", ["owner", "outsider", "accepted_only", "pending", "revoked", "removed", "archived"])
def test_permission_checks_precede_reconciliation_and_match_missing(users, clock, access):
    owner, sender, other, _ = users
    habit, _ = setup_shared(owner, sender)
    actor = sender
    if access == "owner":
        actor = owner
    elif access == "outsider":
        actor = other
    elif access == "accepted_only":
        befriend(owner, other)
        actor = other
    elif access == "pending":
        service("select * from public.send_friend_request(%s,%s)", (owner, other), True)
        actor = other
    elif access == "revoked":
        revoke(owner, habit, sender)
    elif access == "removed":
        remove(owner, sender)
    else:
        lifecycle("archive", owner, habit)
    before = occurrences(owner)
    clock("2026-03-05 12:00+00")
    assert reserve(actor, habit) is reserve(actor, uuid4()) is None
    assert occurrences(owner) == before
    assert saved_reminders(actor) == []


@pytest.mark.parametrize("state", ["completed", "pending", "excused", "missed", "unscheduled"])
def test_only_open_incomplete_occurrences_are_eligible(users, clock, state):
    owner, sender, *_ = users
    config = CONFIG | {"schedule": "selected", "weekdays": [1]} if state == "unscheduled" else CONFIG
    habit, _ = setup_shared(owner, sender, config)
    if state != "unscheduled":
        row = occurrences(owner)[0]
        if state == "completed":
            mutation(owner, row["id"], "completion", True)
        else:
            excuse = submit(owner, row["id"], "Do not put my explanation in a reminder")
            if state in ("excused", "missed"):
                decide(sender, excuse["id"], "approve" if state == "excused" else "reject")
    assert reserve(sender, habit) == {"error": "reminder_not_eligible"}
    assert saved_reminders(sender) == []


@pytest.mark.parametrize("config,operation,complete,undo", [
    (CONFIG, "completion", True, False),
    (TARGET, "progress", 10, 9),
])
def test_undo_or_below_target_progress_makes_open_occurrence_eligible(users, clock, config, operation, complete, undo):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender, config)
    row = occurrences(owner)[0]
    mutation(owner, row["id"], operation, complete)
    assert reserve(sender, habit) == {"error": "reminder_not_eligible"}
    mutation(owner, row["id"], operation, undo)
    assert reserve(sender, habit)["result"]["occurrence_id"] == row["id"]


def test_midnight_closes_previous_occurrence_and_only_new_today_can_be_reserved(users, clock):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender)
    old = occurrences(owner)[0]
    clock("2026-03-01 23:00+00")
    first = reserve(sender, habit)
    assert first["result"]["occurrence_id"] == old["id"]
    clock("2026-03-02 00:00+00")
    second = reserve(sender, habit, "new-day")
    assert second["result"]["occurrence_id"] != old["id"]
    assert [(row["local_date"], row["state"]) for row in occurrences(owner)] == [
        ("2026-03-01", "missed"), ("2026-03-02", "in_progress")]
    assert second["result"]["reserved_at"] == "2026-03-02T00:00:00+00:00"


def test_expired_today_after_timezone_edit_is_rejected_and_reconciliation_commits(users, clock):
    owner, sender, *_ = users
    zone(owner, "Asia/Tokyo")
    habit, _ = setup_shared(owner, sender)
    original = occurrences(owner)[0]
    zone(owner, "UTC")
    clock("2026-03-01 15:00+00")
    assert reserve(sender, habit) == {"error": "reminder_not_eligible"}
    rows = occurrences(owner)
    assert len(rows) == 1 and rows[0]["id"] == original["id"]
    assert rows[0]["state"] == "missed" and rows[0]["closes_at"] == "2026-03-01T15:00:00+00:00"
    assert saved_reminders(sender) == []


@pytest.mark.parametrize("owner_zone,sender_zone,instant,local_date", [
    ("America/New_York", "Asia/Tokyo", "2026-03-02 02:00+00", "2026-03-01"),
    ("Asia/Tokyo", "America/Los_Angeles", "2026-03-01 20:00+00", "2026-03-02"),
    ("America/New_York", "UTC", "2026-03-08 05:00+00", "2026-03-08"),
])
def test_due_today_uses_owner_timezone_and_authoritative_time(users, clock, owner_zone, sender_zone, instant, local_date):
    owner, sender, *_ = users
    clock(instant)
    zone(owner, owner_zone)
    zone(sender, sender_zone)
    habit, _ = setup_shared(owner, sender)
    reservation = reserve(sender, habit)
    row = occurrences(owner)[0]
    assert row["local_date"] == local_date
    assert reservation["result"]["occurrence_id"] == row["id"]
    assert reservation["result"]["reserved_at"] == shared(sender, habit)["server_time"]


def test_backward_timezone_transition_cannot_invent_pre_tracking_today(users, clock):
    owner, sender, *_ = users
    clock("2026-03-01 20:00+00")
    zone(owner, "Asia/Tokyo")
    habit, _ = setup_shared(owner, sender)
    assert occurrences(owner)[0]["local_date"] == "2026-03-02"
    zone(owner, "America/Los_Angeles")
    assert reserve(sender, habit) == {"error": "reminder_not_eligible"}
    assert [row["local_date"] for row in occurrences(owner)] == ["2026-03-02"]
    clock("2026-03-02 08:00+00")
    assert reserve(sender, habit)["dispatch"] is True


def test_notification_uses_occurrence_snapshot_without_private_description(users, clock):
    owner, sender, *_ = users
    original = TARGET | {"name": "Original reading", "description": "PRIVATE DESCRIPTION"}
    habit, _ = setup_shared(owner, sender, original)
    row = occurrences(owner)[0]
    mutation(owner, row["id"], "progress", 7)
    patch(owner, habit, {"name": "Edited name", "target": 5})
    reservation = reserve(sender, habit)
    notification = reservation["notification"]
    assert "Original reading" in notification["body"]
    assert "PRIVATE DESCRIPTION" not in str(notification)
    assert "Edited name" not in str(notification)
    assert occurrences(owner)[0]["snapshot"] == original
    assert occurrences(owner)[0]["state"] == "in_progress"


@pytest.mark.parametrize("key", [None, "", " ", "a b", "a\nb", "é", "x" * 129])
def test_invalid_idempotency_keys_do_not_create_reservations(users, clock, key):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender)
    assert reserve(sender, habit, key) == {"error": "invalid_idempotency_key"}
    assert saved_reminders(sender) == []


def test_cooldown_exact_boundary_and_sender_habit_scoping(users, clock):
    owner, sender, other, _ = users
    habit, _ = setup_shared(owner, sender)
    befriend(owner, other)
    grant(owner, habit, other)
    another_habit = create(owner)["id"]
    grant(owner, another_habit, sender)
    first = reserve(sender, habit, "a")
    assert reserve(other, habit, "a")["dispatch"] is True
    assert reserve(sender, another_habit, "a")["dispatch"] is True
    clock("2026-03-01 12:59:59.999999+00")
    assert reserve(sender, habit, "b") == {"error": "reminder_cooldown", "retry_at": first["result"]["retry_at"]}
    clock("2026-03-01 13:00+00")
    assert reserve(sender, habit, "b")["dispatch"] is True
    assert len(saved_reminders(sender)) == 3


@pytest.mark.parametrize("status", ["accepted", "rejected", "unknown", "invalid_token"])
def test_every_terminal_outcome_consumes_cooldown_and_replays_without_dispatch(users, clock, status):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender)
    reservation = reserve(sender, habit)
    terminal = finish(sender, reservation["result"]["id"], results_for(reservation, status))
    replay = {"dispatch": False, "result": terminal}
    assert reserve(sender, habit) == replay
    assert reserve(sender, habit, "new") == {"error": "reminder_cooldown", "retry_at": terminal["retry_at"]}
    clock("2026-03-01 13:00+00")
    mutation(owner, terminal["occurrence_id"], "completion", True)
    assert reserve(sender, habit) == replay
    assert reserve(sender, habit, "new") == {"error": "reminder_not_eligible"}
    clock("2026-03-02 13:00+00")
    assert reserve(sender, habit) == replay


@pytest.mark.parametrize("restriction", ["revoke", "remove", "archive"])
def test_replays_require_current_authorization_but_authorized_send_can_finish(users, clock, restriction):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender)
    reservation = reserve(sender, habit)
    if restriction == "revoke":
        revoke(owner, habit, sender)
    elif restriction == "remove":
        remove(owner, sender)
    else:
        lifecycle("archive", owner, habit)
    assert reserve(sender, habit) is None
    terminal = finish(sender, reservation["result"]["id"], results_for(reservation))
    assert terminal["status"] == "provider_accepted"
    assert reserve(sender, habit) is None


def test_reserved_replay_after_worker_crash_never_authorizes_a_second_dispatch(users, clock):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender)
    reservation = reserve(sender, habit)
    clock("2026-03-03 12:00+00")
    assert reserve(sender, habit) == {"dispatch": False, "result": reservation["result"]}
    new = reserve(sender, habit, "explicit-new-request")
    assert new["dispatch"] is True and new["result"]["id"] != reservation["result"]["id"]


@pytest.mark.parametrize("statuses,state,counts", [
    (("accepted", "accepted"), "provider_accepted", (2, 0, 0)),
    (("accepted", "rejected"), "partially_accepted", (1, 1, 0)),
    (("accepted", "unknown"), "partially_accepted", (1, 0, 1)),
    (("rejected", "invalid_token"), "failed", (0, 2, 0)),
    (("unknown", "unknown"), "unknown", (0, 0, 2)),
    (("rejected", "unknown"), "unknown", (0, 1, 1)),
])
def test_provider_outcomes_are_aggregated_and_first_finish_is_immutable(users, clock, statuses, state, counts):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender, devices=2)
    reservation = reserve(sender, habit)
    clock("2026-03-01 12:00:02+00")
    terminal = finish(sender, reservation["result"]["id"], results_for(reservation, *statuses))
    assert set(terminal) == SUMMARY_FIELDS
    assert terminal["status"] == state
    assert tuple(terminal[key] for key in ("accepted_count", "failed_count", "unknown_count")) == counts
    assert terminal["finished_at"] == "2026-03-01T12:00:02+00:00"
    assert terminal["reserved_at"] == reservation["result"]["reserved_at"]
    assert finish(sender, terminal["id"], results_for(reservation, "accepted", "accepted")) == terminal
    assert reserve(sender, habit) == {"dispatch": False, "result": terminal}
    assert "ticket" not in str(terminal) and "ExponentPushToken" not in str(terminal)


def test_only_original_sender_can_finish_a_reserved_request(users, clock):
    owner, sender, outsider, _ = users
    habit, _ = setup_shared(owner, sender)
    reservation = reserve(sender, habit)
    results = results_for(reservation)
    for actor in [owner, outsider]:
        assert finish(actor, reservation["result"]["id"], results) is None
        assert finish(actor, uuid4(), results) is None
    assert reserve(sender, habit)["result"]["status"] == "reserved"
    assert finish(sender, reservation["result"]["id"], results)["status"] == "provider_accepted"


@pytest.mark.parametrize("alteration", ["empty", "duplicate", "foreign", "missing", "invalid_status", "extra", "not_array"])
def test_finish_validates_the_complete_reserved_device_set(users, clock, alteration):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender, devices=2)
    reservation = reserve(sender, habit)
    results = results_for(reservation)
    if alteration == "empty":
        results = []
    elif alteration == "duplicate":
        results[1] = results[0]
    elif alteration == "foreign":
        results[0]["device_id"] = str(uuid4())
    elif alteration == "missing":
        results.pop()
    elif alteration == "invalid_status":
        results[0]["status"] = "phone_received"
    elif alteration == "extra":
        results[0]["expo_push_token"] = "not-allowed"
    else:
        results = {}
    assert finish(sender, reservation["result"]["id"], results) == {"error": "invalid_reminder_results"}
    assert reserve(sender, habit)["result"]["status"] == "reserved"
    assert finish(sender, reservation["result"]["id"], results_for(reservation))["status"] == "provider_accepted"


@pytest.mark.parametrize("same_key", [False, True])
def test_concurrent_workers_cannot_bypass_cooldown_or_idempotency(users, clock, same_key):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender)
    barrier = Barrier(4)
    def request(index):
        barrier.wait(timeout=5)
        return reserve(sender, habit, "same" if same_key else f"different-{index}")
    with ThreadPoolExecutor(4) as pool:
        replies = list(pool.map(request, range(4)))
    assert sum(reply.get("dispatch") is True for reply in replies) == 1
    assert len(saved_reminders(sender)) == 1
    if same_key:
        assert len({reply["result"]["id"] for reply in replies}) == 1
        assert sum(reply["dispatch"] is False for reply in replies) == 3
    else:
        assert sum(reply.get("error") == "reminder_cooldown" for reply in replies) == 3


@pytest.mark.parametrize("send_first", [False, True])
@pytest.mark.parametrize("operation", ["complete", "submit", "revoke", "remove", "archive"])
def test_reservation_serializes_with_progress_excuse_and_access_changes(users, clock, send_first, operation):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender)
    occurrence = occurrences(owner)[0]
    sending = (RESERVE, (sender, habit, "a"))
    changing = {
        "complete": ("select * from public.mutate_occurrence(%s,%s,'completion','true',null)", (owner, occurrence["id"])),
        "submit": ("select * from public.submit_occurrence_excuse(%s,%s,'Private')", (owner, occurrence["id"])),
        "revoke": ("select public.revoke_habit_share(%s,%s,%s)", (owner, habit, sender)),
        "remove": ("select public.remove_friend(%s,%s)", (sender, owner)),
        "archive": ("select * from public.archive_habit(%s,%s)", (owner, habit)),
    }[operation]
    first, second = ordered_rpcs(*(sending + changing if send_first else changing + sending))
    reply = first if send_first else second
    if send_first:
        reservation = reply[0][0]
        assert reservation["dispatch"] is True
        assert finish(sender, reservation["result"]["id"], results_for(reservation))["status"] == "provider_accepted"
    elif operation in ("complete", "submit"):
        assert reply == [({"error": "reminder_not_eligible"},)]
    else:
        assert reply == []


def test_overlapping_bidirectional_reminders_shared_reads_and_registration_do_not_deadlock(users, clock):
    owners = sorted(users)[:3]
    habits = {}
    for index, owner in enumerate(owners):
        register(owner)
        habits[owner] = create(owner)["id"]
        for friend in owners[index + 1:]:
            befriend(owner, friend)
    for owner in owners:
        for sender in owners:
            if sender != owner:
                grant(owner, habits[owner], sender)
    operations = [(RESERVE, (sender, habits[owner], "a"))
                  for owner in owners for sender in owners if owner != sender]
    operations += [("select * from public.list_shared_habits(%s)", (owner,)) for owner in owners]
    operations += [(REGISTER, (owners[0], f"ExponentPushToken[{uuid4().hex}]", "ios"))]
    barrier = Barrier(len(operations))
    def run(operation):
        with psycopg.connect(URL) as connection, connection.cursor() as cursor:
            cursor.execute("set role service_role")
            cursor.execute("set statement_timeout='10s'")
            barrier.wait(timeout=10)
            cursor.execute(*operation)
            return cursor.fetchall()
    with ThreadPoolExecutor(len(operations)) as pool:
        replies = list(pool.map(run, operations))
    assert all(replies)
    assert all(rows[0][0]["dispatch"] for rows in replies[:6])


def test_concurrent_terminal_results_are_first_writer_wins(users, clock):
    owner, sender, *_ = users
    habit, _ = setup_shared(owner, sender)
    reservation = reserve(sender, habit)
    barrier = Barrier(2)
    def end(status):
        barrier.wait(timeout=5)
        return finish(sender, reservation["result"]["id"], results_for(reservation, status))
    with ThreadPoolExecutor(2) as pool:
        replies = list(pool.map(end, ["accepted", "unknown"]))
    assert replies[0] == replies[1]
    assert replies[0]["status"] in ("provider_accepted", "unknown")


def test_device_account_switch_transfers_token_and_updates_platform_atomically(users, clock):
    owner, other, *_ = users
    token = register(owner)
    clock("2026-03-01 12:01+00")
    register(other, token, "android")
    assert execute("select user_id,platform from public.device_push_tokens where expo_push_token=%s", (token,), True) == [(other, "android")]
    # Independent uniqueness proves that a caller cannot leave one token on two accounts.
    with pytest.raises(psycopg.errors.UniqueViolation):
        execute("insert into public.device_push_tokens(user_id,expo_push_token,platform) values(%s,%s,'ios')", (owner, token))
    register(owner, token)
    assert execute("select user_id,platform from public.device_push_tokens where expo_push_token=%s", (token,), True) == [(owner, "ios")]


def test_device_registration_works_before_profile_creation(users, clock):
    user = uuid4()
    execute("insert into auth.users values(%s)", (user,))
    try:
        token = register(user)
        assert execute("select user_id from public.device_push_tokens where expo_push_token=%s", (token,), True) == [(user,)]
    finally:
        execute("delete from auth.users where id=%s", (user,))


@pytest.mark.parametrize("reserve_first", [False, True])
def test_account_switch_and_device_snapshot_follow_transaction_order(users, clock, reserve_first):
    owner, sender, other, _ = users
    habit, tokens = setup_shared(owner, sender)
    reserving = (RESERVE, (sender, habit, "switch-race"))
    switching = (REGISTER, (other, tokens[0], "android"))
    first, second = ordered_rpcs(*(reserving + switching if reserve_first else switching + reserving))
    reservation = (first if reserve_first else second)[0][0]
    if reserve_first:
        assert reservation["dispatch"] is True
        assert reservation["devices"][0]["expo_push_token"] == tokens[0]
        # A committed reservation remains authorized after the account switch.
        assert finish(sender, reservation["result"]["id"], results_for(reservation))["status"] == "provider_accepted"
    else:
        assert reservation["dispatch"] is False and reservation["result"]["status"] == "no_devices"
    assert execute("select user_id from public.device_push_tokens where expo_push_token=%s", (tokens[0],), True) == [(other,)]


def test_simultaneous_device_account_switches_preserve_global_uniqueness(users, clock):
    token = f"ExponentPushToken[{uuid4().hex}]"
    barrier = Barrier(4)
    def switch(owner):
        barrier.wait(timeout=5)
        return register(owner, token)
    with ThreadPoolExecutor(4) as pool:
        assert list(pool.map(switch, users)) == [token] * 4
    rows = execute("select user_id from public.device_push_tokens where expo_push_token=%s", (token,), True)
    assert len(rows) == 1 and rows[0][0] in users


@pytest.mark.parametrize("change", ["none", "refresh", "refresh_same_instant", "transfer", "transfer_back"])
def test_invalid_token_cleanup_never_deletes_newer_or_transferred_registration(users, clock, change):
    owner, sender, other, _ = users
    habit, tokens = setup_shared(owner, sender)
    token = tokens[0]
    reservation = reserve(sender, habit)
    if change != "refresh_same_instant":
        clock("2026-03-01 12:00:01+00")
    if change in ("refresh", "refresh_same_instant"):
        register(owner, token)
    elif change in ("transfer", "transfer_back"):
        register(other, token)
        if change == "transfer_back":
            clock("2026-03-01 12:00:02+00")
            register(owner, token)
    terminal = finish(sender, reservation["result"]["id"], results_for(reservation, "invalid_token"))
    assert terminal["status"] == "failed" and terminal["failed_count"] == 1
    rows = execute("select user_id from public.device_push_tokens where expo_push_token=%s", (token,), True)
    assert rows == ([] if change == "none" else [(other if change == "transfer" else owner,)])


RPCS = [
    ("reserve_habit_reminder(uuid,uuid,text)", "reserve_habit_reminder(null::uuid,null::uuid,'key')"),
    ("finish_habit_reminder(uuid,uuid,jsonb)", "finish_habit_reminder(null::uuid,null::uuid,'[]'::jsonb)"),
    ("register_device(uuid,text,text)", "register_device(null::uuid,'ExponentPushToken[abc]','ios')"),
]
HELPERS = [("habit_reminder_summary(public.habit_reminders)", "habit_reminder_summary(null::public.habit_reminders)")]


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("signature,call", RPCS + HELPERS)
def test_rpc_privileges_explicit_revocation_and_fixed_search_path(role, signature, call):
    allowed = role == "service_role" and (signature, call) in RPCS
    assert execute("select has_function_privilege(%s,%s,'EXECUTE')", (role, "public." + signature), True) == [(allowed,)]
    assert execute("select proconfig from pg_proc where oid=%s::regprocedure", ("public." + signature,), True) == [(['search_path=""'],)]
    assert execute("select count(*) from pg_proc p,lateral aclexplode(p.proacl) a where p.oid=%s::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'", ("public." + signature,), True) == [(0,)]
    if not allowed:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            execute_as(role, "select public." + call, fetch=True)
    else:
        assert execute("select prosecdef from pg_proc where oid=%s::regprocedure", ("public." + signature,), True) == [(True,)]


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("operation", ["select", "insert", "update", "delete"])
def test_reminder_records_are_rpc_only_with_rls(role, operation):
    query = {
        "select": "select * from public.habit_reminders",
        "insert": "insert into public.habit_reminders default values",
        "update": "update public.habit_reminders set status='provider_accepted' where false",
        "delete": "delete from public.habit_reminders where false",
    }[operation]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, query)
    assert execute("select relrowsecurity from pg_class where oid='public.habit_reminders'::regclass", fetch=True) == [(True,)]
    assert execute("select count(*) from pg_policies where schemaname='public' and tablename='habit_reminders'", fetch=True) == [(0,)]


@pytest.mark.parametrize("role", ["anon", "authenticated"])
@pytest.mark.parametrize("operation", ["select", "insert", "update", "delete"])
def test_client_roles_cannot_read_or_reassign_device_tokens(role, operation):
    query = {
        "select": "select * from public.device_push_tokens",
        "insert": "insert into public.device_push_tokens default values",
        "update": "update public.device_push_tokens set user_id=null where false",
        "delete": "delete from public.device_push_tokens where false",
    }[operation]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, query)


def test_reservation_requires_a_profile_and_missing_finish_never_authorizes(users, clock):
    with pytest.raises(psycopg.errors.RaiseException, match="profile_not_found"):
        reserve(uuid4(), uuid4())
    assert finish(uuid4(), uuid4(), []) is None


def test_migration_deduplicates_existing_tokens_deterministically_and_preserves_data():
    """Replay privately in a rolled-back admin transaction, never a shared DB."""
    root = Path(__file__).resolve().parents[2]
    with psycopg.connect(URL) as connection, connection.cursor() as cursor:
        try:
            cursor.execute("drop schema public cascade; drop schema auth cascade; create schema public")
            scaffold = (root / "backend/tests/postgres_scaffold.sql").read_text()
            cursor.execute("\n".join(line for line in scaffold.splitlines() if not line.startswith("create role ")))
            migrations = sorted((root / "supabase/migrations").glob("*.sql"))
            split = next(index for index, migration in enumerate(migrations)
                         if migration.name == "202610090001_friend_reminders.sql")
            for migration in migrations[:split]:
                cursor.execute(migration.read_text())
            first, second = uuid4(), uuid4()
            cursor.execute("insert into auth.users values(%s),(%s)", (first, second))
            cursor.execute("insert into public.device_push_tokens(user_id,expo_push_token,platform,updated_at) values(%s,'ExponentPushToken[duplicate]','ios','2026-03-01'),(%s,'ExponentPushToken[duplicate]','android','2026-03-02'),(%s,'ExponentPushToken[unique]','ios','2026-03-01')", (first, second, first))
            for migration in migrations[split:]:
                cursor.execute(migration.read_text())
            cursor.execute("select user_id,platform from public.device_push_tokens where expo_push_token='ExponentPushToken[duplicate]'")
            assert cursor.fetchall() == [(second, "android")]
            cursor.execute("select user_id from public.device_push_tokens where expo_push_token='ExponentPushToken[unique]'")
            assert cursor.fetchall() == [(first,)]
            cursor.execute("select indexdef from pg_indexes where schemaname='public' and tablename='habit_reminders'")
            indexes = " ".join(row[0].lower() for row in cursor.fetchall())
            assert "sender_id, habit_id" in indexes and "reserved_at desc" in indexes
        finally:
            connection.rollback()
