import pytest
from test_friendships_postgres import URL, execute, execute_as, psycopg, service, users
from test_occurrences_postgres import clock, zone, occurrences, mutation
from test_habits_postgres import create, patch, lifecycle, CONFIG, TARGET
from test_excuses_postgres import submit, decide
from test_sharing_postgres import befriend, grant

pytestmark = pytest.mark.skipif(not URL, reason='TEST_DATABASE_URL is not configured')


def plan(owner):
    return service('select public.get_local_reminder_plan(%s)', (owner,), True)[0][0]


def test_snapshots_skipped_today_and_archive(users, clock):
    owner, other, *_ = users
    h = create(owner, CONFIG | {'reminder_times': ['08:00', '21:00']})
    patch(owner, h['id'], {'reminder_times': ['09:00']})
    result = plan(owner)
    assert result['effective'][0]['reminder_times'] == ['08:00', '21:00']
    assert result['future'][0]['reminder_times'] == ['09:00']
    assert result['future'][0]['eligible_from'] == '2026-03-02'
    assert result['owner_id'] == str(owner)
    assert plan(other)['effective'] == [] and plan(other)['future'] == []
    assert len(occurrences(owner)) == 1  # reads do not materialize future rows
    lifecycle('archive', owner, h['id'])
    assert plan(owner)['effective'] == []
    assert plan(owner)['future'] == []
    lifecycle('restore', owner, h['id'])
    assert plan(owner)['effective'] == result['effective']
    assert plan(owner)['future'] == result['future']


@pytest.mark.parametrize('config,operation,complete,reopen', [
    (CONFIG, 'completion', True, False),
    (TARGET, 'progress', 10, 9),
])
def test_complete_and_reopen_preserve_future_and_same_day_snapshot(users, clock, config, operation, complete, reopen):
    owner = users[0]
    habit = create(owner, config | {'reminder_times': ['08:00', '21:00']})
    row = occurrences(owner)[0]
    original = plan(owner)
    mutation(owner, row['id'], operation, complete)
    completed = plan(owner)
    assert completed['effective'] == []
    assert completed['future'] == original['future']
    patch(owner, habit['id'], {'reminder_times': ['22:00']})
    lifecycle('archive', owner, habit['id'])
    lifecycle('restore', owner, habit['id'])
    assert plan(owner)['effective'] == []  # restore does not reopen completion
    mutation(owner, row['id'], operation, reopen)
    reopened = plan(owner)
    assert reopened['effective'] == original['effective']
    assert reopened['future'][0]['reminder_times'] == ['22:00']
    assert reopened['future'][0]['eligible_from'] == '2026-03-02'
    assert len(occurrences(owner)) == 1


@pytest.mark.parametrize('decision', ['automatic', 'pending', 'approve', 'reject'])
def test_all_excuse_locks_suppress_only_their_date_even_after_restore(users, clock, decision):
    owner, friend, *_ = users
    habit = create(owner, CONFIG | {'reminder_times': ['21:00']})
    if decision != 'automatic':
        befriend(owner, friend)
        grant(owner, habit['id'], friend)
    row = occurrences(owner)[0]
    original = plan(owner)
    excuse = submit(owner, row['id'])
    if decision in ('approve', 'reject'):
        decide(friend, excuse['id'], decision)
    assert plan(owner)['effective'] == []
    assert plan(owner)['future'] == original['future']
    lifecycle('archive', owner, habit['id'])
    lifecycle('restore', owner, habit['id'])
    assert plan(owner)['effective'] == []
    assert plan(owner)['future'] == original['future']
    clock('2026-03-02 00:00+00')
    result = plan(owner)
    assert [item['local_date'] for item in result['effective']] == ['2026-03-02']
    assert result['future'][0]['eligible_from'] == '2026-03-03'


def test_restore_after_midnight_excludes_closed_and_archived_dates(users, clock):
    owner = users[0]
    habit = create(owner, CONFIG | {'reminder_times': ['08:00', '21:00']})
    lifecycle('archive', owner, habit['id'])
    clock('2026-03-04 20:00+00')
    assert plan(owner)['effective'] == plan(owner)['future'] == []
    lifecycle('restore', owner, habit['id'])
    result = plan(owner)
    assert [item['local_date'] for item in result['effective']] == ['2026-03-04']
    assert result['future'][0]['eligible_from'] == '2026-03-05'
    assert [row['local_date'] for row in occurrences(owner)] == ['2026-03-01', '2026-03-04']


def test_creation_and_timezone_watermark(users, clock):
    owner = users[0]
    clock('2026-03-01 23:00+00')
    h = create(owner)
    zone(owner, 'Asia/Tokyo')  # advance into Mar 2 immediately
    result = plan(owner)
    assert result['local_date'] == '2026-03-02'
    assert [r['local_date'] for r in result['effective']] == ['2026-03-01', '2026-03-02']
    assert result['future'][0]['eligible_from'] == '2026-03-03'
    zone(owner, 'Pacific/Honolulu')  # no rewind: retain both immutable snapshots
    result = plan(owner)
    assert result['local_date'] == '2026-03-01'
    assert result['future'][0]['eligible_from'] == '2026-03-03'
    assert len(occurrences(owner)) == 2
    assert {r['timezone'] for r in result['effective']} == {'UTC', 'Asia/Tokyo'}


def test_unscheduled_today_cannot_be_invented_by_edit(users, clock):
    owner = users[0]
    h = create(owner, CONFIG | {'schedule': 'selected', 'weekdays': [1]})
    patch(owner, h['id'], {'schedule': 'daily', 'weekdays': []})
    result = plan(owner)
    assert result['effective'] == []
    assert result['future'][0]['eligible_from'] == '2026-03-02'
    assert occurrences(owner) == []


@pytest.mark.parametrize('role', ['anon', 'authenticated'])
def test_no_direct_client_rpc(role):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, 'select public.get_local_reminder_plan(null)', fetch=True)


def test_helpers_remain_private():
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        service('select public.reconcile_occurrences(null)', fetch=True)
