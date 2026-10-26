"""Fair claims against the real migrated schema; Auth is never called."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from app.deletion_maintenance import sweep
from test_friendships_postgres import URL, execute, execute_as, psycopg, service

pytestmark = pytest.mark.skipif(not URL, reason='TEST_DATABASE_URL is not configured')


@pytest.fixture
def ledger():
    # Other tests retain their tombstones. Temporarily quarantine only their
    # maintenance claims, then restore that metadata; never delete their rows.
    previous = execute('select user_id, maintenance_lease_until::text from public.account_deletions', fetch=True)
    execute("update public.account_deletions set maintenance_lease_until=clock_timestamp()+interval '1 day'")
    ids = []
    def seed(count):
        added = [uuid4() for _ in range(count)]
        with psycopg.connect(URL) as connection, connection.cursor() as cursor:
            cursor.executemany('''insert into public.account_deletions(user_id,receipt_hash,requested_at)
                values(%s,%s,timestamptz '2020-01-01' + %s * interval '1 second')''',
                [(user, uuid4().hex * 2, index + len(ids)) for index, user in enumerate(added)])
        ids.extend(added)
        return added
    yield seed
    execute('delete from public.account_deletions where user_id=any(%s)', (ids,))
    with psycopg.connect(URL) as connection, connection.cursor() as cursor:
        cursor.executemany('update public.account_deletions set maintenance_lease_until=%s where user_id=%s',
                           [(lease, user) for user, lease in previous])


def claim(limit):
    return service('select public.claim_account_deletions(%s)', (limit,), True)[0][0]


def test_claims_are_bounded_disjoint_and_recover_after_process_loss(ledger):
    ids = ledger(1201)
    first = claim(1000)
    assert len(first['user_ids']) == 1000 and first['pending_count'] >= 1201
    second = claim(1000)
    assert len(second['user_ids']) == 201
    assert not set(first['user_ids']) & set(second['user_ids'])
    assert claim(1000)['user_ids'] == []
    execute("update public.account_deletions set maintenance_lease_until=clock_timestamp()-interval '1 second' where user_id=any(%s)", (ids,))
    assert set(claim(100)['user_ids']) <= set(first['user_ids'])


async def test_repeated_sweeps_reach_later_completable_requests_despite_older_failures(ledger):
    ids = ledger(101)
    attempted = []
    class Database:
        async def deletion_rpc(self, name, body):
            if name == 'claim_account_deletions':
                return await asyncio.to_thread(claim, body['p_limit'])
            assert name == 'account_deletion_pending_count' and body == {}
            return await asyncio.to_thread(lambda: service('select public.account_deletion_pending_count()', fetch=True)[0][0])
    class Workflow:
        async def resume_user(self, user):
            attempted.append(user)
            if user != str(ids[-1]): return 'pending'
            return await asyncio.to_thread(lambda: service('select public.complete_account_deletion(%s)', (user,), True)[0][0])
    await sweep(Database(), Workflow())
    assert str(ids[-1]) not in attempted
    # A fresh process after the cron interval: expire leases, retain attempt order.
    execute("update public.account_deletions set maintenance_lease_until=clock_timestamp()-interval '1 second' where user_id=any(%s)", (ids,))
    result = await sweep(Database(), Workflow())
    assert attempted[100:104].count(str(ids[-1])) == 1
    assert result['completed'] == 1
    assert execute('select state from public.account_deletions where user_id=%s', (ids[-1],), True) == [('complete',)]


def test_simultaneous_claims_skip_locked_rows_and_never_share_ownership(ledger):
    ids = ledger(8)
    with psycopg.connect(URL) as connection, connection.cursor() as cursor, ThreadPoolExecutor(1) as pool:
        cursor.execute('set role service_role')
        cursor.execute('select public.claim_account_deletions(4)')
        first = cursor.fetchone()[0]['user_ids']
        second = pool.submit(claim, 4).result(timeout=5)['user_ids']
        assert len(first) == len(second) == 4
        assert not set(first) & set(second)
        assert set(first + second) == {str(user) for user in ids}


@pytest.mark.parametrize('role', ['anon', 'authenticated'])
@pytest.mark.parametrize('sql', ['select public.claim_account_deletions(1)', 'select public.account_deletion_pending_count()'])
def test_clients_cannot_claim_or_enumerate_deletions(role, sql):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, sql, fetch=True)


@pytest.mark.parametrize('limit', [None, 0, -1, 1001])
def test_invalid_limits_are_rejected(limit):
    with pytest.raises(psycopg.errors.RaiseException, match='invalid_maintenance_limit'):
        claim(limit)
