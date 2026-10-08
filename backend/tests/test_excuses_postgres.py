"""Excuse lifecycle against disposable PostgreSQL, using service_role RPCs.

The imported administrator-only clock is private test instrumentation. Product
RPCs do not accept actor, decision, or timestamp overrides from API clients.
"""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from time import monotonic, sleep
from uuid import uuid4

import pytest

from test_friendships_postgres import URL, execute, execute_as, psycopg, service, users
from test_habits_postgres import CONFIG, TARGET, create, lifecycle, patch
from test_occurrences_postgres import clock, mutation, occurrences, today, zone
from test_sharing_postgres import befriend, grant, ordered_rpcs, remove, revoke, shared, shared_list

pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not configured")

EXCUSE_FIELDS = {"id", "occurrence_id", "habit_id", "owner_id", "explanation", "status",
                 "decision_source", "decided_by", "decided_at", "created_at", "occurrence"}


def submit(owner, occurrence, explanation="A difficult day"):
    rows = service("select * from public.submit_occurrence_excuse(%s,%s,%s)",
                   (owner, occurrence, explanation), True)
    return rows[0][0] if rows else None


def read_excuse(actor, occurrence):
    rows = service("select * from public.get_occurrence_excuse(%s,%s)", (actor, occurrence), True)
    return rows[0][0] if rows else None


def pending(actor):
    return [row[0] for row in service("select * from public.list_pending_excuses(%s)", (actor,), True)]


def decide(actor, excuse, decision="approve"):
    rows = service("select * from public.decide_occurrence_excuse(%s,%s,%s)",
                   (actor, excuse, decision), True)
    return rows[0][0] if rows else None


def occurrence(owner, identifier):
    return next(row for row in occurrences(owner) if row["id"] == str(identifier))


def setup_shared(owner, friend, config=TARGET):
    befriend(owner, friend)
    habit = create(owner, config)
    grant(owner, habit["id"], friend)
    row = next(row for row in occurrences(owner) if row["habit_id"] == habit["id"])
    return habit, row


@pytest.mark.parametrize("config", [CONFIG, TARGET])
def test_unshared_automatic_approval_preserves_progress_and_snapshots(users, clock, config):
    owner = users[0]
    create(owner, config)
    original = today(owner)["occurrences"][0]
    if config["type"] == "target":
        original = mutation(owner, original["id"], "progress", 4)
    excuse = submit(owner, original["id"], "\u2003\t הייתה לי סיבה — 疲れました 🌙 \n\u00a0")
    assert set(excuse) == EXCUSE_FIELDS
    assert excuse["explanation"] == "הייתה לי סיבה — 疲れました 🌙"
    assert excuse["status"] == "approved" and excuse["decision_source"] == "automatic"
    assert excuse["decided_by"] is None
    assert excuse["created_at"] == excuse["decided_at"] == "2026-03-01T12:00:00+00:00"
    assert excuse["owner_id"] == str(owner) and excuse["occurrence_id"] == original["id"]
    after = occurrence(owner, original["id"])
    assert after["state"] == "excused" and after["completed"] is False
    assert {key: value for key, value in after.items() if key not in ("state", "updated_at")} == {
        key: value for key, value in original.items() if key not in ("state", "updated_at")}
    assert excuse["occurrence"] == after == today(owner)["occurrences"][0]
    assert read_excuse(owner, original["id"]) == excuse
    assert pending(owner) == []
    assert decide(owner, excuse["id"]) is None
    # Reconciliation cannot turn an excuse into a completed or missed occurrence.
    clock("2026-03-04 12:00+00")
    today(owner)
    assert occurrence(owner, original["id"]) == after


def test_shared_submission_is_pending_and_only_current_recipients_see_it(users, clock):
    owner, friend, other, outsider = users
    habit, before = setup_shared(owner, friend)
    befriend(owner, other)
    mutation(owner, before["id"], "progress", 3)
    before = occurrence(owner, before["id"])
    excuse = submit(owner, before["id"])
    assert excuse["status"] == "pending"
    assert excuse["decision_source"] is excuse["decided_by"] is excuse["decided_at"] is None
    assert excuse["occurrence"]["state"] == "justification_pending"
    assert excuse["occurrence"]["progress"] == 3 and excuse["occurrence"]["completed"] is False
    assert excuse["occurrence"]["snapshot"] == before["snapshot"]
    for actor in [owner, friend]:
        assert read_excuse(actor, before["id"]) == excuse
    assert pending(friend) == [excuse]
    assert pending(owner) == pending(other) == pending(outsider) == []
    for actor in [other, outsider]:
        assert read_excuse(actor, before["id"]) is None
        assert decide(actor, excuse["id"]) is None
    assert decide(owner, excuse["id"]) is None
    assert today(owner)["occurrences"][0]["state"] == "justification_pending"
    view = shared(friend, habit["id"])
    assert view["occurrence"]["state"] == "justification_pending"
    # Explanations remain confined to dedicated excuse views.
    assert "explanation" not in str(today(owner))
    assert "explanation" not in str(shared_list(friend))
    assert "explanation" not in str(service("select * from public.list_habits(%s,'all')", (owner,), True))


@pytest.mark.parametrize("explanation", [None, "", " ", "\t\r\n\u2003\u00a0", "a" * 1001, "🌙" * 1001])
def test_submission_rejects_invalid_explanations_without_writes(users, clock, explanation):
    owner = users[0]
    create(owner)
    before = occurrences(owner)[0]
    assert submit(owner, before["id"], explanation) == {"error": "invalid_excuse_explanation"}
    assert occurrences(owner) == [before]
    assert read_excuse(owner, before["id"]) is None


@pytest.mark.parametrize("explanation", ["a", "🌙" * 1000])
def test_explanation_length_counts_unicode_codepoints_after_trimming(users, clock, explanation):
    owner = users[0]
    create(owner)
    assert submit(owner, occurrences(owner)[0]["id"], "  " + explanation + "\n")["explanation"] == explanation


def test_ownership_missing_resources_and_absent_excuses_have_identical_results(users, clock):
    owner, friend, outsider, _ = users
    _, row = setup_shared(owner, friend)
    assert read_excuse(owner, row["id"]) is None
    for actor in [friend, outsider]:
        assert submit(actor, row["id"]) is None
        assert submit(actor, uuid4()) is None
        assert read_excuse(actor, uuid4()) is None
        assert decide(actor, uuid4()) is None
    assert submit(owner, uuid4()) is None
    assert occurrences(owner) == [row]


@pytest.mark.parametrize("shared_habit", [False, True])
def test_duplicate_submission_cannot_edit_or_replace_excuse(users, clock, shared_habit):
    owner, friend, *_ = users
    if shared_habit:
        _, row = setup_shared(owner, friend)
    else:
        create(owner)
        row = occurrences(owner)[0]
    first = submit(owner, row["id"], "Original explanation")
    assert submit(owner, row["id"], "Replacement explanation") == {"error": "excuse_exists"}
    assert read_excuse(owner, row["id"]) == first
    assert execute("select count(*) from public.occurrence_excuses where occurrence_id=%s", (row["id"],), True) == [(1,)]


@pytest.mark.parametrize("completed", [False, True])
def test_submission_deadline_and_completed_rejection(users, clock, completed):
    owner = users[0]
    create(owner)
    row = occurrences(owner)[0]
    if completed:
        mutation(owner, row["id"], "completion", True)
        assert submit(owner, row["id"]) == {"error": "occurrence_not_in_progress"}
    clock("2026-03-02 00:00+00")
    assert submit(owner, row["id"]) == {"error": "occurrence_closed"}
    assert occurrence(owner, row["id"])["state"] == ("completed" if completed else "missed")
    assert read_excuse(owner, row["id"]) is None


def test_submission_uses_snapshotted_deadline_after_timezone_and_config_edit(users, clock):
    owner = users[0]
    zone(owner, "America/New_York")
    habit = create(owner, TARGET)
    row = occurrences(owner)[0]
    mutation(owner, row["id"], "progress", 4)
    zone(owner, "UTC")
    patch(owner, habit["id"], {"target": 1, "name": "Edited"})
    clock("2026-03-02 04:59:59+00")
    excuse = submit(owner, row["id"])
    assert excuse["occurrence"]["closes_at"] == "2026-03-02T05:00:00+00:00"
    assert excuse["occurrence"]["snapshot"] == TARGET
    assert excuse["occurrence"]["progress"] == 4


@pytest.mark.parametrize("decision,terminal", [("approve", "excused"), ("reject", "missed")])
@pytest.mark.parametrize("late", [False, True])
def test_pending_survives_midnight_and_friend_decisions_are_final(users, clock, decision, terminal, late):
    owner, friend, *_ = users
    habit, row = setup_shared(owner, friend)
    mutation(owner, row["id"], "progress", 4)
    submitted = submit(owner, row["id"])
    if late:
        clock("2026-03-05 12:00+00")
        today(owner)
        assert occurrence(owner, row["id"])["state"] == "justification_pending"
        assert pending(friend) == [submitted]
    decided = decide(friend, submitted["id"], decision)
    assert decided["status"] == ("approved" if decision == "approve" else "rejected")
    assert decided["decision_source"] == "friend" and decided["decided_by"] == str(friend)
    assert decided["decided_at"] == ("2026-03-05T12:00:00+00:00" if late else "2026-03-01T12:00:00+00:00")
    assert decided["created_at"] == submitted["created_at"]
    assert decided["occurrence"]["state"] == terminal
    assert (decided["occurrence"]["progress"], decided["occurrence"]["completed"]) == (4, False)
    assert read_excuse(owner, row["id"]) == read_excuse(friend, row["id"]) == decided
    assert pending(friend) == []
    for retry in ["approve", "reject"]:
        assert decide(friend, submitted["id"], retry) == {"error": "excuse_already_decided"}
    if not late:
        assert shared(friend, habit["id"])["occurrence"]["state"] == terminal
    clock("2026-03-08 12:00+00")
    today(owner)
    assert read_excuse(owner, row["id"]) == decided


@pytest.mark.parametrize("state", ["pending", "automatic", "approved", "rejected"])
@pytest.mark.parametrize("config", [CONFIG, TARGET])
def test_normal_mutations_cannot_alter_submitted_occurrences_before_or_after_midnight(users, clock, state, config):
    owner, friend, *_ = users
    if state == "automatic":
        create(owner, config)
        row = occurrences(owner)[0]
    else:
        _, row = setup_shared(owner, friend, config)
    if config["type"] == "target":
        mutation(owner, row["id"], "progress", 4)
    excuse = submit(owner, row["id"])
    if state in ["approved", "rejected"]:
        decide(friend, excuse["id"], "approve" if state == "approved" else "reject")
    before = occurrence(owner, row["id"])
    operations = [("completion", True), ("completion", False)] if config["type"] == "binary" else [
        ("progress", 4), ("progress", 10), ("adjustment", 0), ("adjustment", 6)]
    for instant in ["2026-03-01 23:59+00", "2026-03-02 00:00+00"]:
        clock(instant)
        for operation, value in operations:
            assert mutation(owner, row["id"], operation, value, "blocked") == {"error": "occurrence_locked"}
        today(owner)
        assert occurrence(owner, row["id"]) == before
    assert execute("select count(*) from public.occurrence_adjustments where occurrence_id=%s", (row["id"],), True) == [(0,)]


@pytest.mark.parametrize("decision", [None, "approve", "reject"])
def test_saved_delta_replay_returns_original_response_without_mutating_excuse(users, clock, decision):
    owner, friend, *_ = users
    _, row = setup_shared(owner, friend)
    saved = mutation(owner, row["id"], "adjustment", 4, "saved")
    excuse = submit(owner, row["id"])
    if decision:
        decide(friend, excuse["id"], decision)
    before = read_excuse(owner, row["id"])
    for instant in ["2026-03-01 23:59+00", "2026-03-04 00:00+00"]:
        clock(instant)
        assert mutation(owner, row["id"], "adjustment", 4, "saved") == saved
        assert mutation(owner, row["id"], "adjustment", 5, "saved") == {"error": "idempotency_conflict"}
        assert mutation(owner, row["id"], "adjustment", 0, "fresh") == {"error": "occurrence_locked"}
        assert read_excuse(owner, row["id"]) == before
    assert execute("select key from public.occurrence_adjustments where occurrence_id=%s", (row["id"],), True) == [("saved",)]


@pytest.mark.parametrize("decision", [None, "", "approved", "automatic", "APPROVE", " approve "])
def test_invalid_decision_cannot_change_pending_excuse(users, clock, decision):
    owner, friend, *_ = users
    _, row = setup_shared(owner, friend)
    before = submit(owner, row["id"])
    assert decide(friend, before["id"], decision) == {"error": "invalid_excuse_decision"}
    assert read_excuse(owner, row["id"]) == before


@pytest.mark.parametrize("restriction", ["revoke", "unfriend", "archive"])
def test_loss_of_all_recipients_preserves_pending_and_restored_access_can_decide(users, clock, restriction):
    owner, friend, *_ = users
    habit, row = setup_shared(owner, friend)
    before = submit(owner, row["id"])
    if restriction == "revoke":
        revoke(owner, habit["id"], friend)
    elif restriction == "unfriend":
        remove(owner, friend)
    else:
        lifecycle("archive", owner, habit["id"])
    assert pending(friend) == [] and read_excuse(friend, row["id"]) is None
    assert decide(friend, before["id"]) is None
    clock("2026-03-05 12:00+00")
    today(owner)
    assert read_excuse(owner, row["id"]) == before
    if restriction == "unfriend":
        befriend(friend, owner)
        assert pending(friend) == [] and read_excuse(friend, row["id"]) is None
        grant(owner, habit["id"], friend)
    elif restriction == "revoke":
        grant(owner, habit["id"], friend)
    else:
        lifecycle("restore", owner, habit["id"])
    assert pending(friend) == [before]
    assert decide(friend, before["id"])["occurrence"]["state"] == "excused"


def test_new_recipient_can_decide_old_pending_excuse_and_former_recipients_cannot_read_final(users, clock):
    owner, original, replacement, outsider = users
    habit, row = setup_shared(owner, original)
    excuse = submit(owner, row["id"])
    revoke(owner, habit["id"], original)
    clock("2026-03-07 12:00+00")
    befriend(owner, replacement)
    grant(owner, habit["id"], replacement)
    assert pending(replacement) == [excuse]
    result = decide(replacement, excuse["id"], "reject")
    assert result["decided_by"] == str(replacement)
    for actor in [original, outsider]:
        assert read_excuse(actor, row["id"]) is None and decide(actor, excuse["id"]) is None
    grant(owner, habit["id"], original)
    assert read_excuse(original, row["id"]) == result
    assert decide(original, excuse["id"]) == {"error": "excuse_already_decided"}
    lifecycle("archive", owner, habit["id"])
    assert read_excuse(original, row["id"]) is None
    assert read_excuse(owner, row["id"]) == result


def test_pending_list_includes_older_dates_and_multiple_owners_in_deterministic_order(users, clock):
    first, second, friend, outsider = users
    h1, row1 = setup_shared(first, friend)
    h2, row2 = setup_shared(second, friend)
    old = [submit(first, row1["id"]), submit(second, row2["id"])]
    clock("2026-03-02 12:00+00")
    newest_row = today(first)["occurrences"][0]
    newest = submit(first, newest_row["id"])
    expected = sorted(old + [newest], key=lambda value: (value["created_at"], value["id"]))
    assert pending(friend) == expected
    assert pending(first) == pending(second) == pending(outsider) == []
    assert pending(friend) == expected
    decide(friend, old[0]["id"])
    revoke(second, h2["id"], friend)
    assert pending(friend) == [newest]
    lifecycle("archive", first, h1["id"])
    assert pending(friend) == []


def test_only_valid_grants_tied_to_current_accepted_friendships_count_as_shared(users, clock):
    owner, friend, other, _ = users
    relationship = befriend(owner, friend)
    habit = create(owner)
    # Deliberately corrupt only relationship state as administrator: a retained
    # grant is not sufficient authorization when its relationship is pending.
    grant(owner, habit["id"], friend)
    execute("update public.friend_relationships set state='pending',accepted_at=null where id=%s", (relationship,))
    row = occurrences(owner)[0]
    assert submit(owner, row["id"])["decision_source"] == "automatic"
    assert pending(friend) == [] and read_excuse(friend, row["id"]) is None
    # A relationship belonging to another pair also cannot authorize a grant.
    relation2 = befriend(owner, other)
    second = create(owner)
    execute("insert into public.habit_shares(habit_id,owner_id,recipient_id,relationship_id) values(%s,%s,%s,%s)",
            (second["id"], owner, friend, relation2))
    row2 = next(row for row in occurrences(owner) if row["habit_id"] == second["id"])
    assert submit(owner, row2["id"])["decision_source"] == "automatic"
    assert read_excuse(friend, row2["id"]) is None


@pytest.mark.parametrize("restriction", ["revoke", "unfriend", "archive"])
@pytest.mark.parametrize("decision_first", [False, True])
def test_decision_and_access_changes_follow_transaction_order(users, clock, restriction, decision_first):
    owner, friend, *_ = users
    habit, row = setup_shared(owner, friend)
    excuse = submit(owner, row["id"])
    clock("2026-03-03 12:00+00")
    deciding = ("select * from public.decide_occurrence_excuse(%s,%s,%s)", (friend, excuse["id"], "reject"))
    changing = {"revoke": ("select public.revoke_habit_share(%s,%s,%s)", (owner, habit["id"], friend)),
                "unfriend": ("select public.remove_friend(%s,%s)", (owner, friend)),
                "archive": ("select * from public.archive_habit(%s,%s)", (owner, habit["id"]))}[restriction]
    first, second = ordered_rpcs(*(deciding + changing if decision_first else changing + deciding))
    result = first if decision_first else second
    assert (result[0][0]["status"] if result else None) == ("rejected" if decision_first else None)
    assert read_excuse(owner, row["id"])["status"] == ("rejected" if decision_first else "pending")
    assert read_excuse(friend, row["id"]) is None and pending(friend) == []


@pytest.mark.parametrize("sharing_first", [False, True])
@pytest.mark.parametrize("change", ["grant", "revoke", "unfriend"])
def test_submission_and_sharing_changes_choose_recipients_atomically(users, clock, sharing_first, change):
    owner, friend, *_ = users
    befriend(owner, friend)
    habit = create(owner)
    row = occurrences(owner)[0]
    if change != "grant":
        grant(owner, habit["id"], friend)
    submitting = ("select * from public.submit_occurrence_excuse(%s,%s,%s)", (owner, row["id"], "Reason"))
    changing = {"grant": ("select * from public.grant_habit_share(%s,%s,%s)", (owner, habit["id"], friend)),
                "revoke": ("select public.revoke_habit_share(%s,%s,%s)", (owner, habit["id"], friend)),
                "unfriend": ("select public.remove_friend(%s,%s)", (owner, friend))}[change]
    first, second = ordered_rpcs(*(changing + submitting if sharing_first else submitting + changing))
    submitted = (second if sharing_first else first)[0][0]
    expected_pending = sharing_first if change == "grant" else not sharing_first
    assert submitted["status"] == ("pending" if expected_pending else "approved")
    assert read_excuse(owner, row["id"]) == submitted
    assert submitted["decision_source"] == (None if expected_pending else "automatic")


@pytest.mark.parametrize("decisions", [("approve", "reject"), ("approve", "approve"), ("reject", "reject")])
def test_concurrent_friend_decisions_have_exactly_one_winner(users, clock, decisions):
    owner, friend, second_friend, _ = users
    habit, row = setup_shared(owner, friend)
    befriend(owner, second_friend)
    grant(owner, habit["id"], second_friend)
    excuse = submit(owner, row["id"])
    clock("2026-03-02 00:00+00")
    barrier = Barrier(2)
    def run(item):
        actor, decision = item
        barrier.wait(timeout=5)
        return decide(actor, excuse["id"], decision)
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(run, zip([friend, second_friend], decisions)))
    assert results.count({"error": "excuse_already_decided"}) == 1
    winner = next(result for result in results if "error" not in result)
    index = results.index(winner)
    assert winner["decided_by"] == str([friend, second_friend][index])
    assert winner["status"] == ("approved" if decisions[index] == "approve" else "rejected")
    assert read_excuse(owner, row["id"]) == winner
    assert pending(friend) == pending(second_friend) == []


def test_concurrent_duplicate_submissions_record_exactly_one_excuse(users, clock):
    owner = users[0]
    create(owner)
    row = occurrences(owner)[0]
    barrier = Barrier(2)
    def run(reason):
        barrier.wait(timeout=5)
        return submit(owner, row["id"], reason)
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(run, ["First explanation", "Second explanation"]))
    assert results.count({"error": "excuse_exists"}) == 1
    assert read_excuse(owner, row["id"]) == next(result for result in results if "error" not in result)
    assert execute("select count(*) from public.occurrence_excuses where occurrence_id=%s", (row["id"],), True) == [(1,)]


ENTRY_POINTS = [
    ("submit_occurrence_excuse(uuid,uuid,text)", "submit_occurrence_excuse(null::uuid,null::uuid,'reason')"),
    ("get_occurrence_excuse(uuid,uuid)", "get_occurrence_excuse(null::uuid,null::uuid)"),
    ("list_pending_excuses(uuid)", "list_pending_excuses(null::uuid)"),
    ("decide_occurrence_excuse(uuid,uuid,text)", "decide_occurrence_excuse(null::uuid,null::uuid,'approve')"),
]
HELPERS = [
    ("normalize_excuse_explanation(text)", "normalize_excuse_explanation('reason')"),
    ("is_current_habit_recipient(uuid,uuid,uuid)", "is_current_habit_recipient(null::uuid,null::uuid,null::uuid)"),
    ("excuse_view(public.occurrence_excuses)", "excuse_view(null::public.occurrence_excuses)"),
]


@pytest.mark.parametrize("signature,call", ENTRY_POINTS)
def test_all_excuse_rpcs_require_existing_profile(signature, call):
    with pytest.raises(psycopg.errors.RaiseException, match="profile_not_found"):
        service("select public." + call, fetch=True)


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("signature,call", ENTRY_POINTS + HELPERS)
def test_excuse_function_privileges_security_and_fixed_search_path(role, signature, call):
    entry = (signature, call) in ENTRY_POINTS
    allowed = role == "service_role" and entry
    assert execute("select has_function_privilege(%s,%s,'EXECUTE')", (role, "public." + signature), True) == [(allowed,)]
    assert execute("select prosecdef,proconfig from pg_proc where oid=%s::regprocedure", ("public." + signature,), True) == [(entry, ['search_path=""'])]
    assert execute("select count(*) from pg_proc p,lateral aclexplode(p.proacl) a where p.oid=%s::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'",
                   ("public." + signature,), True) == [(0,)]
    if not allowed:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            execute_as(role, "select public." + call, fetch=True)


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("operation", ["select", "insert", "update", "delete"])
def test_direct_excuse_table_access_is_denied(role, operation):
    sql = {"select": "select * from public.occurrence_excuses",
           "insert": "insert into public.occurrence_excuses default values",
           "update": "update public.occurrence_excuses set explanation='changed'",
           "delete": "delete from public.occurrence_excuses"}[operation]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, sql)


def test_excuse_table_has_rls_and_no_client_policies():
    assert execute("select relrowsecurity from pg_class where oid='public.occurrence_excuses'::regclass", fetch=True) == [(True,)]
    assert execute("select count(*) from pg_policies where schemaname='public' and tablename='occurrence_excuses'", fetch=True) == [(0,)]


@pytest.mark.parametrize("state", ["pending", "approved", "rejected"])
def test_direct_occurrence_updates_cannot_bypass_excuse_terminal_guard(users, clock, state):
    owner, friend, *_ = users
    _, row = setup_shared(owner, friend)
    excuse = submit(owner, row["id"])
    if state != "pending":
        decide(friend, excuse["id"], "approve" if state == "approved" else "reject")
    before = occurrence(owner, row["id"])
    for instant in ["2026-03-01 23:59+00", "2026-03-02 00:00+00"]:
        clock(instant)
        for sql in ["progress=progress", "progress=10,completed=true,state='completed'", "state='in_progress'",
                    "state='excused'" if state == "pending" else "state='justification_pending'"]:
            with pytest.raises(psycopg.errors.RaiseException):
                execute(f"update public.habit_occurrences set {sql} where id=%s", (row["id"],))
        assert occurrence(owner, row["id"]) == before


@pytest.mark.parametrize("shared_habit", [False, True])
def test_midnight_between_submission_check_and_write_rolls_back_excuse_atomically(users, clock, shared_habit):
    owner, friend, *_ = users
    # Preserve a sibling's reconciliation even if the attempted submission fails.
    zone(owner, "Asia/Tokyo")
    sibling = create(owner)
    sibling_row = occurrences(owner)[0]
    zone(owner, "UTC")
    if shared_habit:
        _, row = setup_shared(owner, friend)
    else:
        habit = create(owner)
        row = next(row for row in occurrences(owner) if row["habit_id"] == habit["id"])
    execute("""create or replace function public.occurrence_now() returns timestamptz
        language sql volatile set search_path='' as $$
        select case when pg_catalog.pg_trigger_depth()>0 then '2026-03-02 00:00+00'::timestamptz
                    else '2026-03-01 23:59:59.999+00'::timestamptz end $$""")
    assert submit(owner, row["id"]) == {"error": "occurrence_closed"}
    assert read_excuse(owner, row["id"]) is None
    assert occurrence(owner, row["id"])["state"] == "missed"
    assert occurrence(owner, sibling_row["id"])["state"] == "missed"
    assert pending(friend) == []
    assert execute("select count(*) from public.occurrence_excuses where occurrence_id=%s", (row["id"],), True) == [(0,)]


@pytest.mark.parametrize("read_kind", ["list", "detail"])
@pytest.mark.parametrize("restriction", ["revoke", "unfriend", "archive"])
@pytest.mark.parametrize("read_first", [False, True])
def test_excuse_reads_and_permission_changes_follow_transaction_order(users, clock, read_kind, restriction, read_first):
    owner, friend, *_ = users
    habit, row = setup_shared(owner, friend)
    excuse = submit(owner, row["id"])
    reading = (("select * from public.list_pending_excuses(%s)", (friend,)) if read_kind == "list" else
               ("select * from public.get_occurrence_excuse(%s,%s)", (friend, row["id"])))
    changing = {"revoke": ("select public.revoke_habit_share(%s,%s,%s)", (owner, habit["id"], friend)),
                "unfriend": ("select public.remove_friend(%s,%s)", (owner, friend)),
                "archive": ("select * from public.archive_habit(%s,%s)", (owner, habit["id"]))}[restriction]
    first, second = ordered_rpcs(*(reading + changing if read_first else changing + reading))
    result = first if read_first else second
    assert result == ([(excuse,)] if read_first else [])
    assert read_excuse(friend, row["id"]) is None and pending(friend) == []
    assert read_excuse(owner, row["id"]) == excuse


def test_overlapping_decisions_reads_reconciliation_and_access_changes_do_not_deadlock(users, clock):
    a, b, c, _ = sorted(users)
    befriend(a, b)
    befriend(a, c)
    befriend(b, c)
    habits = {actor: create(actor) for actor in [a, b, c]}
    for owner, habit in habits.items():
        for recipient in [a, b, c]:
            if owner != recipient:
                grant(owner, habit["id"], recipient)
    excuses = {actor: submit(actor, occurrences(actor)[0]["id"]) for actor in [a, b, c]}
    clock("2026-03-04 12:00+00")
    operations = [
        ("select * from public.decide_occurrence_excuse(%s,%s,'approve')", (b, excuses[a]["id"])),
        ("select * from public.decide_occurrence_excuse(%s,%s,'reject')", (a, excuses[b]["id"])),
        ("select * from public.list_pending_excuses(%s)", (c,)),
        ("select * from public.list_shared_habits(%s)", (a,)),
        ("select public.remove_friend(%s,%s)", (a, b)),
        ("select public.revoke_habit_share(%s,%s,%s)", (c, habits[c]["id"], a)),
        ("select public.get_today(%s)", (c,)),
    ]
    barrier = Barrier(len(operations))
    def run(operation):
        with psycopg.connect(URL, options="-c statement_timeout=10000") as connection:
            connection.execute("set role service_role")
            barrier.wait(timeout=5)
            return connection.execute(*operation).fetchall()
    with ThreadPoolExecutor(len(operations)) as pool:
        results = list(pool.map(run, operations))
    assert results[4] == [(True,)] and results[5] == [(True,)]
    assert read_excuse(b, excuses[a]["occurrence_id"]) is None
    assert read_excuse(a, excuses[b]["occurrence_id"]) is None
    assert read_excuse(a, excuses[c]["occurrence_id"]) is None
    assert read_excuse(c, excuses[a]["occurrence_id"])["status"] in ["pending", "approved"]
    assert read_excuse(c, excuses[b]["occurrence_id"])["status"] in ["pending", "rejected"]
    assert read_excuse(c, excuses[c]["occurrence_id"])["status"] == "pending"


@pytest.mark.parametrize("status,source,decider,at", [
    ("unknown", None, False, None),
    ("pending", "friend", True, "2026-03-01 12:00+00"),
    ("pending", None, False, "2026-03-01 12:00+00"),
    ("approved", None, False, "2026-03-01 12:00+00"),
    ("approved", None, True, "2026-03-01 12:00+00"),
    ("approved", "automatic", True, "2026-03-01 12:00+00"),
    ("approved", "friend", False, "2026-03-01 12:00+00"),
    ("approved", "automatic", False, None),
    ("rejected", "automatic", False, "2026-03-01 12:00+00"),
    ("rejected", "friend", True, None),
    ("rejected", "friend", True, "2026-03-01 11:59+00"),
])
def test_excuse_database_constraints_reject_invalid_decision_metadata(users, clock, status, source, decider, at):
    owner, friend, *_ = users
    create(owner)
    row = occurrences(owner)[0]
    with pytest.raises(psycopg.errors.CheckViolation):
        execute("""insert into public.occurrence_excuses
            (occurrence_id,explanation,status,decision_source,decided_by,decided_at)
            values(%s,'Reason',%s,%s,%s,%s)""", (row["id"], status, source, friend if decider else None, at))
    assert read_excuse(owner, row["id"]) is None


@pytest.mark.parametrize("explanation", ["", " ", " Reason", "Reason\u2003", "x" * 1001])
def test_excuse_database_constraint_requires_trimmed_valid_explanation(users, clock, explanation):
    owner = users[0]
    create(owner)
    row = occurrences(owner)[0]
    with pytest.raises(psycopg.errors.CheckViolation):
        execute("insert into public.occurrence_excuses(occurrence_id,explanation,status) values(%s,%s,'pending')",
                (row["id"], explanation))


def test_excuse_uniqueness_foreign_keys_immutability_and_owner_deletion_cascade(users, clock):
    owner, friend, *_ = users
    _, row = setup_shared(owner, friend)
    submitted = submit(owner, row["id"])
    with pytest.raises(psycopg.errors.UniqueViolation):
        execute("insert into public.occurrence_excuses(occurrence_id,explanation,status) values(%s,'Duplicate','pending')", (row["id"],))
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        execute("insert into public.occurrence_excuses(occurrence_id,explanation,status) values(%s,'Missing','pending')", (uuid4(),))
    for assignment in ["explanation='Edited'", "created_at=created_at + interval '1 second'", "occurrence_id=gen_random_uuid()"]:
        with pytest.raises(psycopg.errors.RaiseException, match="immutable_excuse"):
            execute(f"update public.occurrence_excuses set {assignment} where id=%s", (submitted["id"],))
    final = decide(friend, submitted["id"])
    with pytest.raises(psycopg.errors.RaiseException, match="excuse_already_decided"):
        execute("update public.occurrence_excuses set status='rejected' where id=%s", (submitted["id"],))
    assert read_excuse(owner, row["id"]) == final
    # Friendship removal cannot erase the deciding identity or its durable result.
    remove(owner, friend)
    assert read_excuse(owner, row["id"]) == final
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        execute("delete from public.profiles where user_id=%s", (friend,))
    execute("delete from public.profiles where user_id=%s", (owner,))
    assert execute("select count(*) from public.occurrence_excuses where id=%s", (submitted["id"],), True) == [(0,)]


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
def test_excuse_trigger_is_internal_and_fixed_search_path(role):
    assert execute("select has_function_privilege(%s,'public.guard_excuse_update()','EXECUTE')", (role,), True) == [(False,)]
    assert execute("select prosecdef,proconfig from pg_proc where oid='public.guard_excuse_update()'::regprocedure", fetch=True) == [(False, ['search_path=""'])]


def test_pending_list_retries_when_new_shared_owner_appears_during_discovery(users, clock):
    """A grant plus revocation between discovery and locks cannot yield a mixed view."""
    owner, another_owner, recipient, existing_recipient = users
    old_habit, old_row = setup_shared(owner, recipient)
    new_habit, new_row = setup_shared(another_owner, existing_recipient)
    befriend(another_owner, recipient)
    submit(owner, old_row["id"])
    new_excuse = submit(another_owner, new_row["id"])
    lock_key = uuid4().int % (2**31)
    application = f"excuse_pending_discovery_{lock_key}"
    original = execute("select pg_get_functiondef('public.lock_share_profiles(uuid[])'::regprocedure)", fetch=True)[0][0]
    # Disposable administrator instrumentation pauses only this test connection.
    # No production timestamp parameter or client-executable hook is introduced.
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
            return connection.execute("select * from public.list_pending_excuses(%s)", (recipient,)).fetchall()
    try:
        with psycopg.connect(URL, autocommit=True) as gate, ThreadPoolExecutor(1) as pool:
            gate.execute("select pg_advisory_lock(%s)", (lock_key,))
            future = pool.submit(read_during_gap)
            try:
                deadline = monotonic() + 5
                while monotonic() < deadline:
                    if execute("select count(*) from pg_stat_activity where application_name=%s and wait_event='advisory'",
                               (application,), True) == [(1,)]:
                        break
                    if future.done():
                        pytest.fail(f"Pending list did not reach discovery gap: {future.result()}")
                    sleep(0.01)
                else:
                    pytest.fail("Pending list never paused before sorted locks")
                grant(another_owner, new_habit["id"], recipient)
                revoke(owner, old_habit["id"], recipient)
            finally:
                gate.execute("select pg_advisory_unlock(%s)", (lock_key,))
            assert future.result(timeout=12) == [(new_excuse,)]
    finally:
        execute(original)
