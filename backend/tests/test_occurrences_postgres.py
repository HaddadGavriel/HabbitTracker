"""Only a disposable PostgreSQL DB. Clock replacement requires its administrator.

Production has no test clock input or client-accessible override mechanism.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database
from app.main import app
from test_friend_database_adapter import db, transport
from test_friendships_postgres import URL, execute, execute_as, psycopg, service, users
from test_habits_postgres import CONFIG, TARGET, create, lifecycle, patch

pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not configured")


@pytest.fixture
def clock(users):
    execute("create schema occurrence_test_clock; revoke all on schema occurrence_test_clock from public,anon,authenticated,service_role")
    execute("create table occurrence_test_clock.instant(n timestamptz not null)")
    execute("insert into occurrence_test_clock.instant values ('2026-03-01 12:00:00+00')")
    execute("create or replace function public.occurrence_now() returns timestamptz language sql volatile set search_path='' as $$ select n from occurrence_test_clock.instant $$")
    def set_time(value):
        execute("update occurrence_test_clock.instant set n=%s", (value,))
    yield set_time
    execute("create or replace function public.occurrence_now() returns timestamptz language sql volatile set search_path='' as $$ select clock_timestamp() $$")
    execute("drop schema occurrence_test_clock cascade")


def today(owner):
    return service("select public.get_today(%s)", (owner,), True)[0][0]


def mutation(owner, occurrence, operation, value, key=None):
    rows = service("select * from public.mutate_occurrence(%s,%s,%s,%s,%s)",
                   (owner, occurrence, operation, Jsonb(value), key), True)
    return rows[0][0] if rows else None


def occurrences(owner):
    return [r[0] for r in execute("select to_jsonb(o) from public.habit_occurrences o where owner_id=%s order by local_date,habit_id", (owner,), True)]


def zone(owner, value):
    # Match the adapter's direct service-role profile PATCH path.
    service("update public.profiles set timezone=%s where user_id=%s", (value, owner))


@pytest.mark.parametrize("config,count", [(CONFIG, 1), (TARGET, 1), (TARGET | {"weekdays": [1]}, 0)])
def test_creation_today_and_iso_schedules(users, clock, config, count):
    a = users[0]
    h = create(a, config)
    view = today(a)
    assert view['local_date'] == '2026-03-01' and view['timezone'] == 'UTC'
    assert len(view['occurrences']) == count
    if count:
        o = view['occurrences'][0]
        assert o['habit_id'] == h['id'] and o['snapshot'] == config
        assert (o['progress'], o['completed'], o['state']) == (0, False, 'in_progress')
        assert o['closes_at'] == '2026-03-02T00:00:00+00:00'
    assert today(a) == view


@pytest.mark.parametrize("z,instant,date,closing", [
    ('America/New_York', '2026-03-02 02:00+00', '2026-03-01', '2026-03-02T05:00:00+00:00'),
    ('Asia/Tokyo', '2026-03-01 20:00+00', '2026-03-02', '2026-03-02T15:00:00+00:00'),
    ('America/New_York', '2026-03-08 05:00+00', '2026-03-08', '2026-03-09T04:00:00+00:00'),
    ('America/New_York', '2026-11-01 04:00+00', '2026-11-01', '2026-11-02T05:00:00+00:00'),
])
def test_local_midnight_utc_and_dst(users, clock, z, instant, date, closing):
    a = users[0]; clock(instant); zone(a, z); create(a)
    view = today(a); o = view['occurrences'][0]
    assert view['local_date'] == o['local_date'] == date
    assert o['timezone'] == z and o['closes_at'] == closing
    assert mutation(a, o['id'], 'completion', True)['state'] == 'completed'
    before = datetime.fromisoformat(closing).timestamp() - 0.001
    clock(datetime.fromtimestamp(before, timezone.utc))
    assert mutation(a, o['id'], 'completion', False)['state'] == 'in_progress'
    clock(closing)
    assert mutation(a, o['id'], 'completion', True) == {'error': 'occurrence_closed'}
    assert occurrences(a)[0]['state'] == 'missed'


def test_completed_survives_closure_and_today_includes_completed(users, clock):
    a = users[0]; create(a); o = today(a)['occurrences'][0]
    mutation(a, o['id'], 'completion', True)
    assert today(a)['occurrences'][0]['state'] == 'completed'
    clock('2026-03-02 00:00+00')
    assert mutation(a, o['id'], 'completion', False) == {'error': 'occurrence_closed'}
    assert occurrences(a)[0]['state'] == 'completed'


def test_multi_day_inactivity_daily_and_selected(users, clock):
    a = users[0]; daily = create(a); selected = create(a, TARGET)
    clock('2026-03-08 12:00+00'); view = today(a)
    rows = occurrences(a)
    assert [o['local_date'] for o in rows if o['habit_id'] == daily['id']] == [f'2026-03-{i:02}' for i in range(1, 9)]
    assert [o['local_date'] for o in rows if o['habit_id'] == selected['id']] == ['2026-03-01', '2026-03-02', '2026-03-04', '2026-03-08']
    assert all(o['state'] == 'missed' for o in rows if o['local_date'] != '2026-03-08')
    assert len(view['occurrences']) == 2
    today(a); assert occurrences(a) == rows


def test_progress_crossings_absolute_retry_and_delta_replay(users, clock):
    a = users[0]; create(a, TARGET); o = today(a)['occurrences'][0]; oid = o['id']
    assert mutation(a, oid, 'progress', 9)['state'] == 'in_progress'
    first = mutation(a, oid, 'progress', 10)
    assert first['state'] == 'completed' and first['progress'] == 10
    assert mutation(a, oid, 'progress', 10)['progress'] == 10
    assert mutation(a, oid, 'progress', 0)['state'] == 'in_progress'
    result = mutation(a, oid, 'adjustment', 12, 'request-1')
    assert result['state'] == 'completed'
    assert mutation(a, oid, 'adjustment', -3, 'request-2')['state'] == 'in_progress'
    assert mutation(a, oid, 'adjustment', 12, 'request-1') == result
    assert mutation(a, oid, 'adjustment', 13, 'request-1') == {'error': 'idempotency_conflict'}
    clock('2026-03-02 00:00+00')
    assert mutation(a, oid, 'adjustment', 12, 'request-1') == result
    assert mutation(a, oid, 'adjustment', 1, 'new') == {'error': 'occurrence_closed'}
    row = occurrences(a)[0]
    assert (row['progress'], row['completed'], row['state']) == (9, False, 'missed')
    assert execute('select key from public.occurrence_adjustments where occurrence_id=%s order by key',
                   (oid,), True) == [('request-1',), ('request-2',)]


@pytest.mark.parametrize("operation,value,key,error", [
    ('progress', -1, None, 'negative_progress'), ('adjustment', -1, 'a', 'negative_progress'),
    ('progress', True, None, 'invalid_occurrence_value'), ('progress', 1.5, None, 'invalid_occurrence_value'),
    ('progress', 1.0, None, 'invalid_occurrence_value'), ('progress', '2', None, 'invalid_occurrence_value'),
    ('progress', None, None, 'invalid_occurrence_value'), ('adjustment', False, 'a', 'invalid_occurrence_value'),
    ('adjustment', 1, None, 'invalid_idempotency_key'), ('adjustment', 1, '', 'invalid_idempotency_key'),
    ('adjustment', 1, 'x' * 129, 'invalid_idempotency_key'), ('completion', True, None, 'wrong_occurrence_type'),
    ('bad', 1, None, 'invalid_occurrence_value'),
])
def test_invalid_target_mutations(users, clock, operation, value, key, error):
    a = users[0]; create(a, TARGET); o = today(a)['occurrences'][0]
    assert mutation(a, o['id'], operation, value, key) == {'error': error}
    assert occurrences(a)[0] == o


@pytest.mark.parametrize("operation,value,error", [('progress', 1, 'wrong_occurrence_type'),
    ('adjustment', 1, 'wrong_occurrence_type'), ('completion', 1, 'invalid_occurrence_value'),
    ('completion', 'true', 'invalid_occurrence_value')])
def test_invalid_binary_mutations(users, clock, operation, value, error):
    a = users[0]; create(a); o = today(a)['occurrences'][0]
    assert mutation(a, o['id'], operation, value, 'key') == {'error': error}


def test_config_edit_before_first_today_preserves_today_and_elapsed_days(users, clock):
    a = users[0]; h = create(a, TARGET); oid = occurrences(a)[0]['id']
    mutation(a, oid, 'progress', 7)
    clock('2026-03-04 12:00+00')
    patch(a, h['id'], {'target': 5, 'name': 'New', 'schedule': 'daily', 'weekdays': [], 'reminder_times': ['12:00']})
    old = occurrences(a)
    assert [o['local_date'] for o in old] == ['2026-03-01', '2026-03-02', '2026-03-04']
    assert all(o['snapshot'] == TARGET for o in old)
    assert old[0]['progress'] == 7 and old[0]['id'] == oid
    clock('2026-03-05 12:00+00')
    current = today(a)['occurrences'][0]
    assert current['snapshot']['target'] == 5 and current['snapshot']['name'] == 'New'
    for before, after in zip(old, occurrences(a)[:3]):
        assert {k: v for k, v in before.items() if k not in ('state', 'updated_at')} == {k: v for k, v in after.items() if k not in ('state', 'updated_at')}
        assert after['state'] == 'missed'


def test_unscheduled_today_edit_only_affects_subsequent_dates(users, clock):
    a = users[0]; h = create(a, TARGET | {'weekdays': [1]})
    patch(a, h['id'], {'schedule': 'daily', 'weekdays': []})
    assert today(a)['occurrences'] == []
    clock('2026-03-02 12:00+00'); assert len(today(a)['occurrences']) == 1


def test_archive_restore_gaps_and_preserved_deadline(users, clock):
    a = users[0]; h = create(a); original = occurrences(a)[0]
    lifecycle('archive', a, h['id'])
    assert today(a)['occurrences'] == [original]
    assert mutation(a, original['id'], 'completion', True)['completed']
    clock('2026-03-06 12:00+00')
    lifecycle('restore', a, h['id'])
    rows = occurrences(a)
    assert [o['local_date'] for o in rows] == ['2026-03-01', '2026-03-06']
    assert rows[0]['id'] == original['id'] and rows[0]['closes_at'] == original['closes_at']
    lifecycle('restore', a, h['id']); assert occurrences(a) == rows
    lifecycle('archive', a, h['id']); lifecycle('restore', a, h['id']); assert occurrences(a) == rows


@pytest.mark.parametrize("old,new,instant,expected_dates", [
    ('UTC', 'Asia/Tokyo', '2026-03-01 20:00+00', ['2026-03-01', '2026-03-02']),
    ('Asia/Tokyo', 'America/Los_Angeles', '2026-03-01 20:00+00', ['2026-03-02']),
    ('UTC', 'Europe/Berlin', '2026-03-01 12:00+00', ['2026-03-01']),
])
def test_timezone_transition_preserves_and_suppresses_retroactive_dates(users, clock, old, new, instant, expected_dates):
    a = users[0]; clock(instant); zone(a, old); create(a); before = occurrences(a)[0]
    zone(a, new); today(a)
    rows = occurrences(a)
    assert [o['local_date'] for o in rows] == expected_dates
    assert next(o for o in rows if o['id'] == before['id']) == before
    clock('2026-03-04 12:00+00'); today(a)
    assert len({o['local_date'] for o in occurrences(a)}) == len(occurrences(a))
    assert occurrences(a)[-1]['timezone'] == new


def test_timezone_edit_reconciles_inactivity_before_switch_and_restore_floor(users, clock):
    a = users[0]; create(a); clock('2026-03-04 20:00+00'); zone(a, 'Asia/Tokyo')
    rows = occurrences(a)
    assert [o['local_date'] for o in rows] == [f'2026-03-0{i}' for i in range(1, 6)]
    assert all(o['timezone'] == 'UTC' for o in rows[:-1]) and rows[-1]['timezone'] == 'Asia/Tokyo'
    h = create(a); lifecycle('archive', a, h['id']); zone(a, 'America/Los_Angeles')
    lifecycle('restore', a, h['id'])
    assert [o['local_date'] for o in occurrences(a) if o['habit_id'] == h['id']] == ['2026-03-05']


def test_concurrent_reconciliation_increments_and_same_key(users, clock):
    a = users[0]; create(a, TARGET | {'schedule': 'daily', 'weekdays': []})
    clock('2026-03-05 12:00+00')
    with ThreadPoolExecutor(8) as pool:
        views = list(pool.map(lambda _: today(a), range(16)))
    assert all(v == views[0] for v in views) and len(occurrences(a)) == 5
    oid = views[0]['occurrences'][0]['id']
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda i: mutation(a, oid, 'adjustment', 1, f'key-{i}'), range(24)))
    assert today(a)['occurrences'][0]['progress'] == 24
    with ThreadPoolExecutor(8) as pool:
        replay = list(pool.map(lambda _: mutation(a, oid, 'adjustment', 2, 'same'), range(16)))
    assert all(o == replay[0] for o in replay) and today(a)['occurrences'][0]['progress'] == 26
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda v: mutation(a, oid, 'adjustment', v, 'conflict'), [1, 2]))
    assert sum(r == {'error': 'idempotency_conflict'} for r in results) == 1


def test_reconciliation_config_lifecycle_timezone_and_progress_share_lock(users, clock):
    a = users[0]; h = create(a, TARGET | {'schedule': 'daily', 'weekdays': []})
    clock('2026-03-04 12:00+00')
    oid = today(a)['occurrences'][0]['id']
    operations = [lambda: today(a), lambda: patch(a, h['id'], {'target': 20}),
        lambda: zone(a, 'Europe/Berlin'), lambda: lifecycle('archive', a, h['id']),
        lambda: mutation(a, oid, 'adjustment', 1, 'concurrent')]
    # Archived edits may validly conflict; every other operation must finish.
    def run(op):
        try: return op()
        except psycopg.errors.RaiseException as exc:
            assert exc.diag.message_primary == 'habit_archived'
    with ThreadPoolExecutor(5) as pool: list(pool.map(run, operations))
    rows = occurrences(a)
    assert len(rows) == 4 and rows[-1]['id'] == oid and rows[-1]['progress'] == 1
    assert all(o['snapshot']['target'] == 10 for o in rows)
    assert len({o['local_date'] for o in rows}) == 4


def test_restore_unscheduled_day_does_not_fill_archive_gap(users, clock):
    a = users[0]; h = create(a, TARGET | {'weekdays': [7]})
    lifecycle('archive', a, h['id']); clock('2026-03-09 12:00+00')
    lifecycle('restore', a, h['id'])
    assert today(a)['occurrences'] == []
    assert [o['local_date'] for o in occurrences(a)] == ['2026-03-01']
    clock('2026-03-15 12:00+00')
    assert [o['local_date'] for o in today(a)['occurrences']] == ['2026-03-15']


def test_large_integer_progress_and_rejected_decrement_atomicity(users, clock):
    a = users[0]; create(a, TARGET | {'target': 10**30}); oid = today(a)['occurrences'][0]['id']
    result = mutation(a, oid, 'adjustment', 10**30, 'large')
    assert result['completed'] and result['progress'] == 10**30
    assert mutation(a, oid, 'adjustment', -(10**30+1), 'reusable') == {'error': 'negative_progress'}
    assert mutation(a, oid, 'adjustment', -1, 'reusable')['progress'] == 10**30-1
    assert not today(a)['occurrences'][0]['completed']


def test_snapshot_identity_and_closed_progress_guards(users, clock):
    a = users[0]; create(a, TARGET); o = today(a)['occurrences'][0]
    for assignment, value in [('snapshot=%s', Jsonb(TARGET | {'target': 5})),
                              ('local_date=%s', '2026-02-28'), ('closes_at=%s', '2030-01-01'),
                              ('owner_id=%s', users[1]), ('timezone=%s', 'Asia/Tokyo')]:
        with pytest.raises(psycopg.errors.RaiseException, match='immutable_occurrence'):
            execute(f'update public.habit_occurrences set {assignment} where id=%s', (value, o['id']))
    with pytest.raises(psycopg.errors.RaiseException, match='invalid_occurrence_state'):
        execute("update public.habit_occurrences set state='missed' where id=%s", (o['id'],))
    clock('2026-03-02 00:00+00')
    with pytest.raises(psycopg.errors.RaiseException, match='occurrence_closed'):
        execute('update public.habit_occurrences set progress=1 where id=%s', (o['id'],))


@pytest.mark.parametrize('config,initial,operation,value', [
    pytest.param(CONFIG, False, 'completion', True, id='binary-complete'),
    pytest.param(TARGET, 0, 'progress', 10, id='target-set'),
    pytest.param(TARGET, 0, 'adjustment', 10, id='target-increment'),
    pytest.param(CONFIG, False, 'completion', False, id='binary-incomplete-noop'),
    pytest.param(TARGET, 3, 'progress', 3, id='target-incomplete-noop'),
    pytest.param(TARGET, 3, 'adjustment', 0, id='target-zero-adjustment'),
    pytest.param(CONFIG, True, 'completion', True, id='binary-completed-noop'),
    pytest.param(TARGET, 10, 'progress', 10, id='target-completed-noop'),
])
def test_midnight_between_check_and_update_is_committed_conflict(
    users, clock, monkeypatch, config, initial, operation, value,
):
    a = users[0]
    # This earlier deadline is reconciled before the mutation's subtransaction.
    # Its persisted missed state proves the rejected write did not roll it back.
    zone(a, 'Asia/Tokyo'); sibling = create(a); zone(a, 'UTC')
    sibling_before = next(o for o in occurrences(a) if o['habit_id'] == sibling['id'])
    assert sibling_before['closes_at'] == '2026-03-01T15:00:00+00:00'
    assert sibling_before['state'] == 'in_progress'
    habit = create(a, config)
    oid = next(o['id'] for o in today(a)['occurrences'] if o['habit_id'] == habit['id'])
    before = mutation(a, oid, 'completion' if config['type'] == 'binary' else 'progress', initial)
    # An administrator-only test replacement advances at the UPDATE trigger,
    # deterministically reproducing the check/write race without waiting.
    execute("""create or replace function public.occurrence_now() returns timestamptz
        language sql volatile set search_path='' as $$
        select case when pg_catalog.pg_trigger_depth()>0 then '2026-03-02 00:00+00'::timestamptz
                    else '2026-03-01 23:59:59.999+00'::timestamptz end $$""")

    # Use the real route and adapter; only PostgREST's HTTP transport is replaced
    # with the actual disposable-database RPC running as service_role.
    captured = []
    key = 'midnight' if operation == 'adjustment' else None
    def handler(request):
        assert request.method == 'POST' and request.url.path == '/rest/v1/rpc/mutate_occurrence'
        payload = json.loads(request.content)
        assert payload == {'p_owner': str(a), 'p_occurrence': oid, 'p_operation': operation,
                           'p_value': value, 'p_key': key}
        result = mutation(payload['p_owner'], payload['p_occurrence'], payload['p_operation'],
                          payload['p_value'], payload['p_key'])
        captured.append(result)
        return httpx.Response(200, json=[result])

    route, field = {'completion': ('completion', 'completed'), 'progress': ('progress', 'progress'),
                    'adjustment': ('progress-adjustments', 'delta')}[operation]
    with monkeypatch.context() as patching:
        transport(patching, handler)
        patching.setitem(app.dependency_overrides, get_current_user, lambda: AuthenticatedUser(id=str(a)))
        patching.setitem(app.dependency_overrides, get_database, db)
        with TestClient(app) as client:
            response = client.request('POST' if operation == 'adjustment' else 'PUT',
                f'/occurrences/{oid}/{route}', json={field: value},
                headers={'Idempotency-Key': key} if key else {})
    assert captured == [{'error': 'occurrence_closed'}]
    assert response.status_code == 409
    assert response.json() == {'detail': {'code': 'occurrence_closed', 'message': 'Occurrence is closed'}}
    rows = {o['id']: o for o in occurrences(a)}
    row = rows[oid]
    assert (row['progress'], row['completed']) == (before['progress'], before['completed'])
    assert row['state'] == ('completed' if before['completed'] else 'missed')
    assert rows[sibling_before['id']]['state'] == 'missed'
    assert execute('select count(*) from public.occurrence_adjustments where occurrence_id=%s', (oid,), True) == [(0,)]


def test_midnight_race_cannot_undo_completed_occurrence(users, clock):
    a = users[0]; create(a); oid = today(a)['occurrences'][0]['id']
    mutation(a, oid, 'completion', True)
    execute("""create or replace function public.occurrence_now() returns timestamptz
        language sql volatile set search_path='' as $$
        select case when pg_catalog.pg_trigger_depth()>0 then '2026-03-02 00:00+00'::timestamptz
                    else '2026-03-01 23:59:59.999+00'::timestamptz end $$""")
    assert mutation(a, oid, 'completion', False) == {'error': 'occurrence_closed'}
    assert occurrences(a)[0]['state'] == 'completed'


@pytest.mark.parametrize('sql', ['select public.get_today(%s)',
    "select public.mutate_occurrence(%s,null,'completion','true',null)"])
def test_entry_points_require_profile(sql):
    with pytest.raises(psycopg.errors.RaiseException, match='profile_not_found'):
        service(sql, (uuid4(),), True)


@pytest.mark.parametrize('role', ['anon', 'authenticated'])
@pytest.mark.parametrize('sql', ['select public.get_today(null)',
    "select public.mutate_occurrence(null,null,'completion','true',null)"])
def test_client_cannot_call_entry_points(role, sql):
    with pytest.raises(psycopg.errors.InsufficientPrivilege): execute_as(role, sql, fetch=True)


def test_cross_user_even_friends_and_missing_are_identical(users, clock):
    a, b, c, _ = users; create(a); oid = today(a)['occurrences'][0]['id']
    req = service('select id from public.send_friend_request(%s,%s)', (a, b), True)[0][0]
    service('select public.accept_friend_request(%s,%s)', (req, b))
    for actor in [b, c]:
        assert today(actor)['occurrences'] == []
        for identifier in [oid, uuid4()]:
            for op, val in [('completion', True), ('progress', 3), ('adjustment', 1)]:
                assert mutation(actor, identifier, op, val, 'key') is None
    assert occurrences(a)[0]['progress'] == 0


@pytest.mark.parametrize('role', ['anon', 'authenticated', 'service_role'])
@pytest.mark.parametrize('table', ['habit_tracking', 'habit_occurrences', 'occurrence_adjustments'])
@pytest.mark.parametrize('operation', ['select', 'insert', 'update', 'delete'])
def test_direct_table_restrictions(role, table, operation):
    sql = {'select': f'select * from public.{table}', 'insert': f'insert into public.{table} default values',
           'update': f'update public.{table} set '+ ('next_date=current_date' if table == 'habit_tracking' else "created_at=now()"),
           'delete': f'delete from public.{table}'}[operation]
    with pytest.raises(psycopg.errors.InsufficientPrivilege): execute_as(role, sql)
    assert execute('select relrowsecurity from pg_class where oid=%s::regclass', (f'public.{table}',), True) == [(True,)]


FUNCTIONS = ['occurrence_now()', 'materialize_occurrence(public.habits,date,text)', 'reconcile_occurrences(uuid)',
    'track_new_habit()', 'reconcile_habit_edit()', 'track_habit_restore()', 'reconcile_timezone_edit()',
    'track_timezone_edit()', 'guard_occurrence_update()', 'get_today(uuid)', 'mutate_occurrence(uuid,uuid,text,jsonb,text)']


@pytest.mark.parametrize('role', ['anon', 'authenticated', 'service_role'])
@pytest.mark.parametrize('function', FUNCTIONS)
def test_function_restrictions_and_fixed_search_path(role, function):
    expected = role == 'service_role' and function in FUNCTIONS[-2:]
    assert execute("select has_function_privilege(%s,%s,'EXECUTE')", (role, 'public.' + function), True) == [(expected,)]
    assert execute('select proconfig from pg_proc where oid=%s::regprocedure', ('public.' + function,), True) == [(['search_path=""'],)]
    assert execute("select count(*) from pg_proc p,lateral aclexplode(p.proacl) a where p.oid=%s::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'", ('public.'+function,), True) == [(0,)]


def test_database_uniqueness_and_no_public_clock_override(users, clock):
    a = users[0]; create(a); o = occurrences(a)[0]
    with pytest.raises(psycopg.errors.UniqueViolation):
        execute('insert into public.habit_occurrences(habit_id,owner_id,local_date,timezone,closes_at,snapshot) values(%s,%s,%s,%s,%s,%s)',
                (o['habit_id'], a, o['local_date'], o['timezone'], o['closes_at'], Jsonb(o['snapshot'])))
    for role in ['anon', 'authenticated', 'service_role']:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            execute_as(role, 'update occurrence_test_clock.instant set n=now()')
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            execute_as(role, "create or replace function public.occurrence_now() returns timestamptz language sql as $$select now()$$")


def test_migration_existing_habits_cutover_not_creation_date():
    # Fresh schema inside an administrator transaction, rolled back afterwards.
    # Keeps this test isolated from every other fixture and never touches a shared DB.
    root = Path(__file__).resolve().parents[2]
    with psycopg.connect(URL) as connection, connection.cursor() as c:
        try:
            c.execute('drop schema public cascade; drop schema auth cascade; create schema public')
            scaffold = (root / 'backend/tests/postgres_scaffold.sql').read_text()
            c.execute('\n'.join(line for line in scaffold.splitlines() if not line.startswith('create role ')))
            migrations = sorted((root / 'supabase/migrations').glob('*.sql'))
            cutover = next(i for i, migration in enumerate(migrations)
                           if migration.name == '202610070002_daily_occurrences.sql')
            for migration in migrations[:cutover]: c.execute(migration.read_text())
            owner = uuid4()
            c.execute('insert into auth.users values(%s)', (owner,))
            c.execute("insert into public.profiles(user_id,username,display_name,timezone) values(%s,'cutover','Cutover','UTC')", (owner,))
            c.execute("insert into public.habits(owner_id,configuration,created_at) values(%s,%s,'2020-01-01') returning id", (owner, Jsonb(CONFIG)))
            habit = c.fetchone()[0]
            for migration in migrations[cutover:]: c.execute(migration.read_text())
            c.execute('select next_date,eligible_from from public.habit_tracking where habit_id=%s', (habit,))
            start, eligible = c.fetchone(); assert start == eligible
            c.execute('select (clock_timestamp() at time zone \'UTC\')::date'); assert c.fetchone()[0] == start
            c.execute('set local role service_role')
            c.execute('select public.get_today(%s)', (owner,)); rows = c.fetchone()[0]['occurrences']
            assert len(rows) == 1 and rows[0]['local_date'] == str(start)
        finally:
            connection.rollback()
