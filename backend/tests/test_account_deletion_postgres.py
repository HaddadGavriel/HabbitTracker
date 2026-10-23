"""Disposable PostgreSQL: full migrations, service-only cleanup and real locks."""
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from time import sleep

import pytest
from test_friendships_postgres import URL, execute, execute_as, psycopg, service, users
from test_occurrences_postgres import clock, occurrences
from test_excuses_postgres import setup_shared, submit, decide, read_excuse
from test_habits_postgres import create
from test_devices_postgres import register
from test_reminders_postgres import reserve

pytestmark = pytest.mark.skipif(not URL, reason='TEST_DATABASE_URL is not configured')
BEGIN = 'select public.begin_account_deletion(%s,%s)'


def begin(user, receipt=None):
    return service(BEGIN, (user, receipt or uuid4().hex * 2), True)[0][0]


@pytest.mark.parametrize('decision', ['approve', 'reject'])
def test_preserves_finalized_other_owner_history_and_streak(users, clock, decision):
    owner, friend, *_ = users
    habit, occurrence = setup_shared(owner, friend)
    before = decide(friend, submit(owner, occurrence['id'])['id'], decision)
    streak = service('select * from public.get_habit_streak(%s,%s)', (owner, habit['id']), True)
    owned = create(friend)
    register(friend, f'ExpoPushToken[{uuid4().hex}]', uuid4())
    receipt = uuid4().hex * 2
    assert begin(friend, receipt) == begin(friend, receipt) == 'pending'
    after = read_excuse(owner, occurrence['id'])
    assert after == before | {'decided_by': None, 'decision_source': 'deleted_friend'}
    assert service('select * from public.get_habit_streak(%s,%s)', (owner, habit['id']), True) == streak
    for sql in ['update public.occurrence_excuses set decided_at=decided_at where id=%s',
                "update public.occurrence_excuses set status='pending' where id=%s"]:
        with pytest.raises(psycopg.errors.RaiseException):
            execute(sql, (before['id'],))
    assert execute('select count(*) from public.habits where id=%s', (owned['id'],), True) == [(0,)]
    for table, column in [('habit_shares','recipient_id'), ('friend_relationships','requester_id'),
                          ('device_push_tokens','user_id'), ('device_registration_intents','user_id')]:
        assert execute(f'select count(*) from public.{table} where {column}=%s', (friend,), True) == [(0,)]
    # Pending does not mean deleted. Auth FK cascades only after anonymization.
    with pytest.raises(psycopg.errors.RaiseException, match='auth_deletion_unconfirmed'):
        service('select public.complete_account_deletion(%s)', (friend,))
    execute('delete from auth.users where id=%s', (friend,))
    assert service('select public.complete_account_deletion(%s)', (friend,), True) == [('complete',)]
    assert service('select public.complete_account_deletion(%s)', (friend,), True) == [('complete',)]
    assert read_excuse(owner, occurrence['id']) == after
    # Finalized occurrence cannot be rewritten under cleanup capability either.
    with pytest.raises(psycopg.errors.RaiseException, match='occurrence_locked'):
        execute('update public.habit_occurrences set progress=progress where id=%s', (occurrence['id'],))


def test_pending_fences_every_service_entry_point_and_direct_profile_onboarding(users, clock):
    a, b, *_ = users
    habit, occurrence = setup_shared(b, a)
    pending = submit(b, occurrence['id'])
    begin(a)
    calls = [
        ('select public.register_device_intent(%s,%s,%s,%s)', (a, f'ExpoPushToken[{uuid4().hex}]', 'android', uuid4())),
        ('select public.decide_occurrence_excuse(%s,%s,%s)', (a, pending['id'], 'approve')),
        ('select public.grant_habit_share(%s,%s,%s)', (b, habit['id'], a)),
        ('select public.send_friend_request(%s,%s)', (b, a)),
        ('select public.get_today(%s)', (a,)),
        ('select public.reserve_habit_reminder(%s,%s,%s)', (a, habit['id'], 'new')),
        ('update public.profiles set display_name=display_name where user_id=%s', (a,)),
    ]
    for sql, params in calls:
        with pytest.raises(psycopg.errors.RaiseException, match='account_deletion_pending'):
            service(sql, params)
    # No profile is also covered, including a stale request after Auth removal.
    execute('delete from auth.users where id=%s', (a,))
    execute('insert into auth.users values(%s)', (a,))
    with pytest.raises(psycopg.errors.RaiseException, match='account_deletion_pending'):
        service("insert into public.profiles values(%s,'resurrected','Name','UTC',now(),now())", (a,))


@pytest.mark.parametrize('role', ['anon','authenticated','service_role'])
def test_ledger_permissions_and_internal_bypass_are_closed(role):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, 'select * from public.account_deletions')
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, 'select public._deletion_impl_register_device(null,null,null)')
    for signature in ['begin_account_deletion(uuid,text)', 'complete_account_deletion(uuid)',
                      'account_deletion_status(text)', 'pending_account_deletions()']:
        assert execute('select has_function_privilege(%s,%s,\'execute\')', (role, 'public.'+signature), True) == [(role == 'service_role',)]


def test_reservation_data_is_removed_but_already_committed_dispatch_is_not_recalled(users, clock):
    owner, friend, *_ = users
    habit, _ = setup_shared(owner, friend)
    register(owner, f'ExpoPushToken[{uuid4().hex}]', uuid4())
    reservation = reserve(friend, habit['id'])
    assert reservation['dispatch']
    begin(owner)
    assert execute('select count(*) from public.habit_reminders where id=%s', (reservation['result']['id'],), True) == [(0,)]
    assert reservation['notification']  # external committed snapshot may exist


@pytest.mark.parametrize('operation', ['decision','sharing','registration','reservation'])
@pytest.mark.parametrize('deletion_first', [False, True])
def test_transaction_barrier_orders_deletion_and_concurrent_work(users, clock, operation, deletion_first):
    owner, friend, *_ = users
    habit, occurrence = setup_shared(owner, friend)
    excuse = submit(owner, occurrence['id']) if operation == 'decision' else None
    calls = {
        'decision': ('select public.decide_occurrence_excuse(%s,%s,%s)', (friend, excuse['id'] if excuse else uuid4(), 'approve')),
        'sharing': ('select public.grant_habit_share(%s,%s,%s)', (owner, habit['id'], friend)),
        'registration': ('select public.register_device_intent(%s,%s,%s,%s)', (friend, f'ExpoPushToken[{uuid4().hex}]', 'android', uuid4())),
        'reservation': ('select public.reserve_habit_reminder(%s,%s,%s)', (friend, habit['id'], 'race')),
    }
    deletion = (BEGIN, (friend, uuid4().hex * 2))
    first, second = (deletion, calls[operation]) if deletion_first else (calls[operation], deletion)
    with psycopg.connect(URL) as connection, connection.cursor() as cursor, ThreadPoolExecutor(1) as pool:
        cursor.execute('set role service_role')
        cursor.execute(*first)
        def contender():
            try:
                return service(*second, fetch=True)
            except psycopg.errors.RaiseException as error:
                return error.diag.message_primary
        future = pool.submit(contender)
        sleep(.1)
        assert not future.done(), 'Contender must wait for transaction barrier'
        connection.commit()
        result = future.result(timeout=5)
    if deletion_first:
        assert result == 'account_deletion_pending'
    if operation == 'decision':
        after = read_excuse(owner, occurrence['id'])
        assert after['status'] == ('pending' if deletion_first else 'approved')
        if not deletion_first:
            assert after['decision_source'] == 'deleted_friend' and after['decided_by'] is None


def test_account_without_profile_has_the_same_pending_fence(users):
    user = users[0]
    execute('delete from public.profiles where user_id=%s', (user,))
    assert begin(user) == 'pending'
    with pytest.raises(psycopg.errors.RaiseException, match='account_deletion_pending'):
        register(user, f'ExpoPushToken[{uuid4().hex}]', uuid4())
    assert execute('select count(*) from auth.users where id=%s', (user,), True) == [(1,)]
