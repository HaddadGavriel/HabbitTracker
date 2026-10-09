"""History/streak integration checks against a disposable PostgreSQL database.

Every product operation runs as service_role. Only the existing private clock,
fixture setup, and privilege/catalog inspection use the database administrator.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from threading import Barrier
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from test_friendships_postgres import URL, execute, execute_as, psycopg, service, users
from test_habits_postgres import CONFIG, TARGET, create, lifecycle, patch
from test_occurrences_postgres import clock, mutation, occurrences, today, zone
from test_excuses_postgres import decide, submit
from test_sharing_postgres import befriend, grant, ordered_rpcs, remove, revoke, shared, shared_list

pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not configured")

STREAK_FIELDS = {"habit_id", "current_streak", "provisional", "calculated_at"}
EXCUSE_FIELDS = {"id", "explanation", "status", "decision_source", "decided_by", "decided_at", "created_at"}
HISTORY_SQL = "select * from public.get_habit_history(%s,%s,%s,%s,%s,%s)"
STREAK_SQL = "select * from public.get_habit_streak(%s,%s)"


def history(owner, habit, limit=30, from_date=None, to_date=None, cursor=None):
    rows = service(HISTORY_SQL, (owner, habit, limit, from_date, to_date,
                                Jsonb(cursor) if cursor is not None else None), True)
    return rows[0][0] if rows else None


def streak(owner, habit):
    rows = service(STREAK_SQL, (owner, habit), True)
    return rows[0][0] if rows else None


def assert_streak(owner, habit, count, provisional=False):
    result = streak(owner, habit)
    assert set(result) == STREAK_FIELDS
    assert result["habit_id"] == habit
    assert (result["current_streak"], result["provisional"]) == (count, provisional)
    return result


def todays_occurrence(owner, habit):
    return next(row for row in today(owner)["occurrences"] if row["habit_id"] == habit)


def sequence(owner, friend, clock, states):
    """Create actual daily occurrences and excuse decisions without editing state."""
    befriend(owner, friend)
    habit = create(owner)["id"]
    grant(owner, habit, friend)
    excuses = {}
    for offset, state in enumerate(states):
        day = date(2026, 3, 1) + timedelta(days=offset)
        clock(f"{day} 12:00+00")
        row = todays_occurrence(owner, habit)
        if state == "completed":
            mutation(owner, row["id"], "completion", True)
        elif state in ("pending", "excused"):
            excuses[offset] = submit(owner, row["id"], f"Private explanation {offset}")
            if state == "excused":
                decide(friend, excuses[offset]["id"])
        else:
            assert state == "missed"
    # Close any final incomplete occurrence, leaving an ignored open Today.
    clock(f"{date(2026, 3, 1) + timedelta(days=len(states))} 00:00+00")
    return habit, excuses


def test_empty_history_zero_streak_and_empty_filtered_page(users, clock):
    owner = users[0]
    habit = create(owner, CONFIG | {"schedule": "selected", "weekdays": [1]})["id"]
    assert history(owner, habit) == {"habit_id": habit, "occurrences": [], "next_cursor": None}
    result = assert_streak(owner, habit, 0)
    assert result["calculated_at"] == "2026-03-01T12:00:00+00:00"
    lifecycle("archive", owner, habit)
    assert history(owner, habit)["occurrences"] == []
    assert_streak(owner, habit, 0)
    other = create(owner)["id"]
    assert history(owner, other, from_date="2026-04-01")["occurrences"] == []
    assert history(owner, other, to_date="2026-02-28")["occurrences"] == []


@pytest.mark.parametrize("states,count,provisional", [
    (["completed", "excused", "completed"], 3, False),
    (["completed", "missed", "completed", "excused"], 2, False),
    (["missed"], 0, False),
    (["pending"], 0, True),
    (["pending", "pending"], 0, True),
    (["pending", "completed"], 1, True),
    (["completed", "pending"], 1, True),
    (["completed", "pending", "completed"], 2, True),
    (["pending", "missed", "completed"], 1, False),
    (["completed", "pending", "missed"], 0, False),
    (["completed", "missed", "pending"], 0, True),
    (["pending", "pending", "completed", "pending"], 1, True),
])
def test_streak_counts_successes_after_latest_missed_only(users, clock, states, count, provisional):
    owner, friend, *_ = users
    habit, _ = sequence(owner, friend, clock, states)
    result = assert_streak(owner, habit, count, provisional)
    page = history(owner, habit)
    expected = ["justification_pending" if state == "pending" else state for state in states]
    assert [row["state"] for row in reversed(page["occurrences"])] == expected + ["in_progress"]
    for view in [shared(friend, habit), shared_list(friend)[0]]:
        assert {key: view[key] for key in STREAK_FIELDS - {"habit_id"}} == {
            key: result[key] for key in STREAK_FIELDS - {"habit_id"}}
        assert "Private explanation" not in str(view)
        assert not ({"excuse", "explanation", "decided_by", "history", "occurrences"} & view.keys())
        assert "excuse" not in view["occurrence"]


@pytest.mark.parametrize("decisions,expected", [
    ([(1, "approve"), (3, "approve")], [(4, True), (5, False)]),
    ([(1, "approve"), (3, "reject")], [(4, True), (1, False)]),
    ([(3, "reject"), (1, "approve")], [(1, False), (1, False)]),
    ([(1, "reject"), (3, "approve")], [(2, True), (3, False)]),
    ([(3, "approve"), (1, "reject")], [(4, True), (3, False)]),
])
def test_multiple_late_decisions_recompute_segment_and_compact_history(users, clock, decisions, expected):
    owner, friend, *_ = users
    habit, excuses = sequence(owner, friend, clock, ["completed", "pending", "completed", "pending", "completed"])
    assert_streak(owner, habit, 3, True)
    for (offset, decision), (count, provisional) in zip(decisions, expected):
        result = decide(friend, excuses[offset]["id"], decision)
        assert_streak(owner, habit, count, provisional)
        row = next(row for row in history(owner, habit)["occurrences"]
                   if row["id"] == result["occurrence_id"])
        assert set(row["excuse"]) == EXCUSE_FIELDS
        assert row["excuse"] == {key: result[key] for key in EXCUSE_FIELDS}
        assert row["state"] == ("excused" if decision == "approve" else "missed")
    assert all(row["excuse"] is None for row in history(owner, habit)["occurrences"]
               if row["state"] in ("completed", "in_progress"))


def test_automatic_excuse_counts_and_keeps_decision_metadata(users, clock):
    owner = users[0]
    habit = create(owner)["id"]
    excuse = submit(owner, todays_occurrence(owner, habit)["id"], "A private explanation")
    assert_streak(owner, habit, 1)
    row = history(owner, habit)["occurrences"][0]
    assert row["completed"] is False and row["state"] == "excused"
    assert row["excuse"] == {key: excuse[key] for key in EXCUSE_FIELDS}
    assert row["excuse"]["decision_source"] == "automatic"
    assert row["excuse"]["decided_by"] is None


def test_open_today_preserves_yesterday_until_midnight_closure(users, clock):
    owner = users[0]
    habit = create(owner)["id"]
    mutation(owner, todays_occurrence(owner, habit)["id"], "completion", True)
    clock("2026-03-02 23:59:59+00")
    assert_streak(owner, habit, 1)
    assert history(owner, habit)["occurrences"][0]["state"] == "in_progress"
    clock("2026-03-03 00:00+00")
    result = assert_streak(owner, habit, 0)
    assert result["calculated_at"] == "2026-03-03T00:00:00+00:00"
    assert [row["state"] for row in history(owner, habit)["occurrences"]] == ["in_progress", "missed", "completed"]
    mutation(owner, todays_occurrence(owner, habit)["id"], "completion", True)
    assert_streak(owner, habit, 1)


@pytest.mark.parametrize("config,operation,complete,undo", [
    (CONFIG, "completion", True, False),
    (TARGET | {"schedule": "daily", "weekdays": []}, "progress", 10, 9),
])
def test_binary_undo_and_target_progress_reduction_remove_success_without_breaking_open_day(
    users, clock, config, operation, complete, undo,
):
    owner = users[0]
    habit = create(owner, config)["id"]
    mutation(owner, todays_occurrence(owner, habit)["id"], operation, complete)
    clock("2026-03-02 12:00+00")
    row = todays_occurrence(owner, habit)
    mutation(owner, row["id"], operation, complete)
    assert_streak(owner, habit, 2)
    mutation(owner, row["id"], operation, undo)
    assert_streak(owner, habit, 1)
    assert history(owner, habit)["occurrences"][0]["state"] == "in_progress"
    clock("2026-03-03 00:00+00")
    assert_streak(owner, habit, 0)


def test_historical_name_target_progress_timezone_and_deadline_are_snapshots(users, clock):
    owner = users[0]
    original = TARGET | {"schedule": "daily", "weekdays": []}
    habit = create(owner, original)["id"]
    row = todays_occurrence(owner, habit)
    mutation(owner, row["id"], "progress", 7)
    patch(owner, habit, {"name": "New name", "target": 5})
    zone(owner, "America/New_York")
    before = history(owner, habit)["occurrences"][0]
    assert before["snapshot"] == original
    assert (before["progress"], before["completed"], before["state"]) == (7, False, "in_progress")
    assert before["timezone"] == "UTC" and before["closes_at"] == row["closes_at"]
    assert_streak(owner, habit, 0)
    clock("2026-03-02 12:00+00")
    new = todays_occurrence(owner, habit)
    mutation(owner, new["id"], "progress", 5)
    assert_streak(owner, habit, 1)
    after, old = history(owner, habit)["occurrences"]
    assert after["snapshot"]["target"] == 5 and after["snapshot"]["name"] == "New name"
    assert after["timezone"] == "America/New_York"
    assert old["snapshot"] == original and old["progress"] == 7 and old["state"] == "missed"
    assert old["timezone"] == "UTC" and old["closes_at"] == row["closes_at"]


def test_selected_weekdays_and_archive_gaps_do_not_break_streak(users, clock):
    owner = users[0]
    habit = create(owner, CONFIG | {"schedule": "selected", "weekdays": [7]})["id"]
    mutation(owner, todays_occurrence(owner, habit)["id"], "completion", True)
    clock("2026-03-07 12:00+00")
    assert_streak(owner, habit, 1)
    lifecycle("archive", owner, habit)
    clock("2026-03-09 12:00+00")
    assert_streak(owner, habit, 1)
    assert [row["local_date"] for row in history(owner, habit)["occurrences"]] == ["2026-03-01"]
    lifecycle("restore", owner, habit)
    clock("2026-03-15 12:00+00")
    mutation(owner, todays_occurrence(owner, habit)["id"], "completion", True)
    assert_streak(owner, habit, 2)
    assert [row["local_date"] for row in history(owner, habit)["occurrences"]] == ["2026-03-15", "2026-03-01"]


@pytest.mark.parametrize("old,new,instant,dates", [
    ("UTC", "Asia/Tokyo", "2026-03-01 20:00+00", ["2026-03-02", "2026-03-01"]),
    ("Asia/Tokyo", "America/Los_Angeles", "2026-03-01 20:00+00", ["2026-03-02"]),
    ("Pacific/Honolulu", "Pacific/Kiritimati", "2026-03-01 12:00+00", ["2026-03-02", "2026-03-01"]),
    ("Etc/GMT+12", "Pacific/Kiritimati", "2026-03-01 11:00+00", ["2026-03-02", "2026-02-28"]),
])
def test_timezone_transitions_and_filters_use_stored_local_dates(users, clock, old, new, instant, dates):
    owner = users[0]
    clock(instant)
    zone(owner, old)
    habit = create(owner)["id"]
    original = todays_occurrence(owner, habit)
    mutation(owner, original["id"], "completion", True)
    zone(owner, new)
    for row in history(owner, habit)["occurrences"]:
        if row["state"] == "in_progress":
            mutation(owner, row["id"], "completion", True)
    assert_streak(owner, habit, len(dates))
    rows = history(owner, habit)["occurrences"]
    assert [row["local_date"] for row in rows] == dates
    saved = next(row for row in rows if row["id"] == original["id"])
    assert saved["timezone"] == old and saved["closes_at"] == original["closes_at"]
    assert history(owner, habit, from_date=original["local_date"], to_date=original["local_date"])["occurrences"] == [saved]
    before_tracking = str(date.fromisoformat(original["local_date"]) - timedelta(days=1))
    assert history(owner, habit, to_date=before_tracking)["occurrences"] == []


def test_default_maximum_pagination_filters_and_stable_order(users, clock):
    owner = users[0]
    habit = create(owner)["id"]
    clock("2026-06-20 12:00+00")
    default = service("select * from public.get_habit_history(%s,%s)", (owner, habit), True)[0][0]
    assert len(default["occurrences"]) == 30 and default["next_cursor"] is not None
    assert [row["state"] for row in default["occurrences"]] == ["in_progress"] + ["missed"] * 29
    assert len(history(owner, habit, limit=100)["occurrences"]) == 100
    collected, cursor = [], None
    while True:
        page = history(owner, habit, limit=7, cursor=cursor)
        assert page == history(owner, habit, limit=7, cursor=cursor)
        assert len(page["occurrences"]) <= 7
        collected.extend(page["occurrences"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
        last = page["occurrences"][-1]
        assert cursor == {"v": 1, "habit_id": habit, "from_date": None, "to_date": None,
                          "local_date": last["local_date"], "id": last["id"]}
    keys = [(row["local_date"], row["id"]) for row in collected]
    assert keys == sorted(keys, reverse=True) and len(keys) == len(set(keys)) == 112
    first = history(owner, habit, limit=2, from_date="2026-03-03", to_date="2026-03-05")
    assert [row["local_date"] for row in first["occurrences"]] == ["2026-03-05", "2026-03-04"]
    final = history(owner, habit, limit=100, from_date="2026-03-03", to_date="2026-03-05", cursor=first["next_cursor"])
    assert [row["local_date"] for row in final["occurrences"]] == ["2026-03-03"]
    assert final["next_cursor"] is None
    # Reconciliation and progress changes between pages do not duplicate dates.
    clock("2026-06-21 12:00+00")
    continuation = history(owner, habit, cursor=default["next_cursor"])
    assert max(row["local_date"] for row in continuation["occurrences"]) < default["occurrences"][-1]["local_date"]


@pytest.mark.parametrize("limit", [None, -1, 0, 101, 1000000])
def test_database_rejects_unbounded_or_invalid_limits(users, clock, limit):
    owner = users[0]
    habit = create(owner)["id"]
    with pytest.raises(psycopg.errors.RaiseException, match="invalid_history_limit"):
        history(owner, habit, limit=limit)


def test_database_rejects_reversed_ranges_and_invalid_dates(users, clock):
    owner = users[0]
    habit = create(owner)["id"]
    with pytest.raises(psycopg.errors.RaiseException, match="invalid_history_range"):
        history(owner, habit, from_date="2026-03-02", to_date="2026-03-01")
    for value in ["2026-02-30", "not-a-date"]:
        with pytest.raises(psycopg.DataError):
            history(owner, habit, from_date=value)


@pytest.mark.parametrize("alteration", [
    None, [], "not-a-cursor", 12, {},
    {"v": 2}, {"v": "1"}, {"v": True}, {"extra": "unexpected"},
    {"id": "invalid"}, {"id": str(uuid4())}, {"id": None},
    {"local_date": "2026-02-30"}, {"local_date": "2026-3-1"},
    {"local_date": "2026-03-01T00:00:00Z"}, {"local_date": None},
    {"from_date": "2026-03-01"}, {"to_date": "2026-03-03"},
    {"habit_id": str(uuid4())},
])
def test_database_rejects_malformed_scoped_or_fabricated_cursors(users, clock, alteration):
    owner = users[0]
    habit = create(owner)["id"]
    clock("2026-03-03 12:00+00")
    cursor = history(owner, habit, limit=1)["next_cursor"]
    if alteration is None:
        cursor.pop("id")
    elif isinstance(alteration, dict) and alteration:
        cursor.update(alteration)
    else:
        cursor = alteration
    with pytest.raises(psycopg.errors.RaiseException, match="invalid_history_cursor"):
        history(owner, habit, cursor=cursor)


def test_cursor_is_bound_to_habit_and_filters_but_never_authorizes(users, clock):
    owner, friend, outsider, _ = users
    befriend(owner, friend)
    first, second = create(owner)["id"], create(owner)["id"]
    grant(owner, first, friend)
    clock("2026-03-04 12:00+00")
    cursor = history(owner, first, limit=1)["next_cursor"]
    for habit, start, end in [(second, None, None), (first, "2026-03-01", None), (first, None, "2026-03-04")]:
        with pytest.raises(psycopg.errors.RaiseException, match="invalid_history_cursor"):
            history(owner, habit, from_date=start, to_date=end, cursor=cursor)
    before = occurrences(owner)
    clock("2026-03-08 12:00+00")
    for actor in [friend, outsider]:
        for habit in [first, second, str(uuid4())]:
            assert history(actor, habit, cursor=cursor) is None
            assert streak(actor, habit) is None
    assert occurrences(owner) == before


def test_archived_history_and_streak_are_owner_only_without_unauthorized_reconciliation(users, clock):
    owner, friend, accepted, outsider = users
    befriend(owner, friend)
    befriend(owner, accepted)
    habit = create(owner)["id"]
    grant(owner, habit, friend)
    mutation(owner, todays_occurrence(owner, habit)["id"], "completion", True)
    lifecycle("archive", owner, habit)
    before = occurrences(owner)
    clock("2026-03-04 12:00+00")
    for actor in [friend, accepted, outsider]:
        assert history(actor, habit) is history(actor, uuid4()) is None
        assert streak(actor, habit) is streak(actor, uuid4()) is None
    assert occurrences(owner) == before
    assert len(history(owner, habit)["occurrences"]) == 1
    assert_streak(owner, habit, 1)
    assert shared(friend, habit) is None and shared_list(friend) == []


@pytest.mark.parametrize("restriction", ["revoke", "unfriend"])
def test_shared_streak_disappears_after_current_access_revocation(users, clock, restriction):
    owner, friend, *_ = users
    habit, _ = sequence(owner, friend, clock, ["completed", "pending", "completed"])
    assert shared(friend, habit)["current_streak"] == 2
    assert shared_list(friend)[0]["provisional"] is True
    (revoke(owner, habit, friend) if restriction == "revoke" else remove(owner, friend))
    before = occurrences(owner)
    clock("2026-03-10 12:00+00")
    assert shared(friend, habit) is None and shared_list(friend) == []
    assert occurrences(owner) == before


@pytest.mark.parametrize("reader", ["history", "streak", "shared_detail", "shared_list"])
@pytest.mark.parametrize("read_first", [False, True])
@pytest.mark.parametrize("decision", ["approve", "reject"])
def test_decisions_and_reads_serialize_with_coherent_history_and_streak(users, clock, reader, read_first, decision):
    owner, friend, *_ = users
    habit, excuses = sequence(owner, friend, clock, ["completed", "pending", "completed"])
    reading = {"history": ("select * from public.get_habit_history(%s,%s)", (owner, habit)),
               "streak": (STREAK_SQL, (owner, habit)),
               "shared_detail": ("select * from public.get_shared_habit(%s,%s)", (friend, habit)),
               "shared_list": ("select * from public.list_shared_habits(%s)", (friend,))}[reader]
    changing = ("select * from public.decide_occurrence_excuse(%s,%s,%s)", (friend, excuses[1]["id"], decision))
    first, second = ordered_rpcs(*(reading + changing if read_first else changing + reading))
    view = (first if read_first else second)[0][0]
    final_count = 3 if decision == "approve" else 1
    if reader == "history":
        row = next(row for row in view["occurrences"] if row["id"] == excuses[1]["occurrence_id"])
        assert row["state"] == ("justification_pending" if read_first else "excused" if decision == "approve" else "missed")
        assert row["excuse"]["status"] == ("pending" if read_first else "approved" if decision == "approve" else "rejected")
    else:
        assert (view["current_streak"], view["provisional"]) == ((2, True) if read_first else (final_count, False))
    assert_streak(owner, habit, final_count)


@pytest.mark.parametrize("reader", ["history", "streak"])
@pytest.mark.parametrize("read_first", [False, True])
def test_progress_and_owner_reads_use_the_same_profile_lock(users, clock, reader, read_first):
    owner = users[0]
    habit = create(owner)["id"]
    row = todays_occurrence(owner, habit)
    reading = (f"select * from public.get_habit_{reader}(%s,%s)", (owner, habit))
    changing = ("select * from public.mutate_occurrence(%s,%s,'completion','true',null)", (owner, row["id"]))
    first, second = ordered_rpcs(*(reading + changing if read_first else changing + reading))
    view = (first if read_first else second)[0][0]
    if reader == "history":
        assert view["occurrences"][0]["state"] == ("in_progress" if read_first else "completed")
    else:
        assert view["current_streak"] == (0 if read_first else 1)
    assert_streak(owner, habit, 1)


@pytest.mark.parametrize("reader", ["history", "streak"])
@pytest.mark.parametrize("read_first", [False, True])
def test_archival_and_owner_reads_serialize_and_include_archived_habit(users, clock, reader, read_first):
    owner = users[0]
    habit = create(owner)["id"]
    mutation(owner, todays_occurrence(owner, habit)["id"], "completion", True)
    reading = (f"select * from public.get_habit_{reader}(%s,%s)", (owner, habit))
    changing = ("select * from public.archive_habit(%s,%s)", (owner, habit))
    first, second = ordered_rpcs(*(reading + changing if read_first else changing + reading))
    view = (first if read_first else second)[0][0]
    assert view["habit_id"] == habit
    assert (view["occurrences"][0]["state"] == "completed" if reader == "history" else view["current_streak"] == 1)


@pytest.mark.parametrize("reader", ["list", "detail"])
@pytest.mark.parametrize("read_first", [False, True])
def test_shared_streak_and_revocation_follow_transaction_order(users, clock, reader, read_first):
    owner, friend, *_ = users
    habit, _ = sequence(owner, friend, clock, ["completed", "pending", "completed"])
    reading = (("select * from public.list_shared_habits(%s)", (friend,)) if reader == "list" else
               ("select * from public.get_shared_habit(%s,%s)", (friend, habit)))
    changing = ("select public.revoke_habit_share(%s,%s,%s)", (owner, habit, friend))
    first, second = ordered_rpcs(*(reading + changing if read_first else changing + reading))
    rows = first if read_first else second
    assert len(rows) == (1 if read_first else 0)
    if rows:
        assert (rows[0][0]["current_streak"], rows[0][0]["provisional"]) == (2, True)
    assert shared(friend, habit) is None and shared_list(friend) == []


def test_overlapping_owner_and_shared_reads_decisions_and_reconciliation_do_not_deadlock(users, clock):
    owners = sorted(users)[:3]
    for index, owner in enumerate(owners):
        for friend in owners[index + 1:]:
            befriend(owner, friend)
    habits, excuses = {}, {}
    for owner in owners:
        habits[owner] = create(owner)["id"]
        for friend in owners:
            if friend != owner:
                grant(owner, habits[owner], friend)
        excuses[owner] = submit(owner, todays_occurrence(owner, habits[owner])["id"])
    clock("2026-03-02 12:00+00")
    a, b, c = owners
    operations = [("select * from public.list_shared_habits(%s)", (actor,)) for actor in owners] + [
        (STREAK_SQL, (a, habits[a])),
        ("select * from public.get_habit_history(%s,%s)", (b, habits[b])),
        ("select * from public.decide_occurrence_excuse(%s,%s,'approve')", (a, excuses[c]["id"])),
        ("select * from public.decide_occurrence_excuse(%s,%s,'reject')", (c, excuses[a]["id"])),
        ("select public.revoke_habit_share(%s,%s,%s)", (b, habits[b], c)),
    ]
    barrier = Barrier(len(operations))
    def run(operation):
        with psycopg.connect(URL) as connection, connection.cursor() as cursor:
            cursor.execute("set role service_role")
            cursor.execute("set statement_timeout='10s'")
            barrier.wait(timeout=10)
            cursor.execute(*operation)
            return cursor.fetchall()
    with ThreadPoolExecutor(len(operations)) as pool:
        results = list(pool.map(run, operations))
    assert all(results)
    assert_streak(a, habits[a], 0)
    assert_streak(b, habits[b], 0, True)
    assert_streak(c, habits[c], 1)


RPCS = [
    ("get_habit_history(uuid,uuid,integer,date,date,jsonb)", "get_habit_history(null::uuid,null::uuid)"),
    ("get_habit_streak(uuid,uuid)", "get_habit_streak(null::uuid,null::uuid)"),
]
HELPERS = [("habit_streak_summary(uuid,timestamptz)", "habit_streak_summary(null::uuid,null::timestamptz)")]


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("signature,call", RPCS + HELPERS)
def test_rpc_and_helper_privileges_search_path_and_explicit_client_revocation(role, signature, call):
    allowed = role == "service_role" and (signature, call) in RPCS
    assert execute("select has_function_privilege(%s,%s,'EXECUTE')", (role, "public." + signature), True) == [(allowed,)]
    assert execute("select proconfig from pg_proc where oid=%s::regprocedure", ("public." + signature,), True) == [(['search_path=""'],)]
    assert execute("select count(*) from pg_proc p,lateral aclexplode(p.proacl) a where p.oid=%s::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'", ("public." + signature,), True) == [(0,)]
    if not allowed:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            execute_as(role, "select public." + call, fetch=True)
    else:
        assert execute("select prosecdef from pg_proc where oid=%s::regprocedure", ("public." + signature,), True) == [(True,)]
        with pytest.raises(psycopg.errors.RaiseException, match="profile_not_found"):
            service("select public." + call, fetch=True)


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("table", ["habit_occurrences", "occurrence_excuses", "habit_tracking"])
def test_history_source_tables_remain_backend_rpc_only_with_rls(role, table):
    for sql in [f"select * from public.{table}", f"insert into public.{table} default values",
                f"delete from public.{table} where false"]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            execute_as(role, sql)
    assert execute("select relrowsecurity from pg_class where oid=%s::regclass", ("public." + table,), True) == [(True,)]
    assert execute("select count(*) from pg_policies where schemaname='public' and tablename=%s", (table,), True) == [(0,)]


def test_migration_preserves_tracking_cutover_for_old_habits():
    # Rebuild privately inside a rolled-back administrator transaction, including
    # a habit predating occurrence tracking. Never point this suite at shared DBs.
    root = Path(__file__).resolve().parents[2]
    with psycopg.connect(URL) as connection, connection.cursor() as cursor:
        try:
            cursor.execute("drop schema public cascade; drop schema auth cascade; create schema public")
            scaffold = (root / "backend/tests/postgres_scaffold.sql").read_text()
            cursor.execute("\n".join(line for line in scaffold.splitlines() if not line.startswith("create role ")))
            migrations = sorted((root / "supabase/migrations").glob("*.sql"))
            split = next(index for index, migration in enumerate(migrations)
                         if migration.name == "202610070002_daily_occurrences.sql")
            for migration in migrations[:split]:
                cursor.execute(migration.read_text())
            owner = uuid4()
            cursor.execute("insert into auth.users values(%s)", (owner,))
            cursor.execute("insert into public.profiles(user_id,username,display_name,timezone) values(%s,'history_cutover','Cutover','UTC')", (owner,))
            cursor.execute("insert into public.habits(owner_id,configuration,created_at) values(%s,%s,'2020-01-01') returning id", (owner, Jsonb(CONFIG)))
            habit = cursor.fetchone()[0]
            for migration in migrations[split:]:
                cursor.execute(migration.read_text())
            cursor.execute("select eligible_from from public.habit_tracking where habit_id=%s", (habit,))
            cutover = str(cursor.fetchone()[0])
            cursor.execute("set local role service_role")
            cursor.execute("select * from public.get_habit_history(%s,%s)", (owner, habit))
            page = cursor.fetchone()[0]
            assert [row["local_date"] for row in page["occurrences"]] == [cutover]
            cursor.execute(STREAK_SQL, (owner, habit))
            view = cursor.fetchone()[0]
            assert (view["current_streak"], view["provisional"]) == (0, False)
            cursor.execute("select * from public.get_habit_history(%s,%s,30,'2020-01-01','2020-12-31')", (owner, habit))
            assert cursor.fetchone()[0]["occurrences"] == []
        finally:
            connection.rollback()
