"""Registration fencing/transfer against disposable PostgreSQL; no real push."""
from uuid import uuid4
import pytest
from test_friendships_postgres import URL, execute, execute_as, psycopg, service, users
from test_occurrences_postgres import clock
from test_sharing_postgres import ordered_rpcs
from test_reminders_postgres import setup_shared, reserve, finish, results_for

pytestmark = pytest.mark.skipif(not URL, reason='TEST_DATABASE_URL is not configured')
REGISTER = 'select public.register_device_intent(%s,%s,%s,%s)'
UNREGISTER = 'select public.unregister_device(%s,%s)'


def register(user, token, identity):
    return service(REGISTER, (user, token, 'android', identity), True)[0][0]


def unregister(user, identity):
    return service(UNREGISTER, (user, identity), True)[0][0]


def row(token):
    return execute('select user_id,registration_id from public.device_push_tokens where expo_push_token=%s', (token,), True)


def test_transfer_and_transfer_back_survive_stale_unregister_and_register(users, clock):
    a, b, *_ = users
    token = f'ExpoPushToken[{uuid4().hex}]'
    first, second, third = uuid4(), uuid4(), uuid4()
    assert register(a, token, first)
    assert register(b, token, second)
    assert unregister(a, first) is False
    assert register(a, token, first) is None
    assert row(token) == [(b, second)]
    assert register(a, token, third)
    assert unregister(a, first) is False
    assert unregister(b, second) is False
    assert row(token) == [(a, third)]
    assert unregister(a, third) is True
    assert unregister(a, third) is False
    assert register(a, token, third) is None
    assert row(token) == []


def test_refresh_same_clock_tick_and_legacy_refresh_rotate_identity(users, clock):
    a, *_ = users
    token, first, second = f'ExpoPushToken[{uuid4().hex}]', uuid4(), uuid4()
    before = register(a, token, first)
    assert register(a, token, first) == before  # exact replay is idempotent
    assert register(a, token, second) > before
    assert unregister(a, first) is False
    assert row(token) == [(a, second)]
    service('select public.register_device(%s,%s,%s)', (a, token, 'ios'))
    assert unregister(a, second) is False
    assert row(token)[0][1] != second


def test_other_owner_cannot_cancel_or_remove_registration(users, clock):
    a, b, *_ = users
    token, identity = f'ExpoPushToken[{uuid4().hex}]', uuid4()
    assert unregister(b, identity) is False
    assert register(a, token, identity)
    assert unregister(b, identity) is False
    assert row(token) == [(a, identity)]


@pytest.mark.parametrize('register_first', [False, True])
def test_register_unregister_transaction_race_is_fenced_in_both_orders(users, clock, register_first):
    a, *_ = users
    token, identity = f'ExpoPushToken[{uuid4().hex}]', uuid4()
    registering = (REGISTER, (a, token, 'android', identity))
    removing = (UNREGISTER, (a, identity))
    first, second = ordered_rpcs(*(registering + removing if register_first else removing + registering))
    assert row(token) == []
    assert register(a, token, identity) is None
    assert (second if register_first else first) == [(register_first,)]


def test_token_renewal_removes_only_this_installation(users, clock):
    a, *_ = users
    old, renewed, other_device = [f'ExpoPushToken[{uuid4().hex}]' for _ in range(3)]
    first, second, other = uuid4(), uuid4(), uuid4()
    register(a, old, first)
    register(a, other_device, other)
    assert unregister(a, first)
    register(a, renewed, second)
    assert row(old) == [] and row(renewed) == [(a, second)] and row(other_device) == [(a, other)]


def test_unregister_does_not_recall_committed_reminder_or_change_cooldown(users, clock):
    a, sender, *_ = users
    habit, tokens = setup_shared(a, sender)
    identity = uuid4()
    register(a, tokens[0], identity)
    reserved = reserve(sender, habit)
    assert unregister(a, identity)
    assert finish(sender, reserved['result']['id'], results_for(reserved))['status'] == 'provider_accepted'
    assert reserve(sender, habit, 'new')['error'] == 'reminder_cooldown'


@pytest.mark.parametrize('role', ['anon', 'authenticated', 'service_role'])
@pytest.mark.parametrize('signature', ['register_device_intent(uuid,text,text,uuid)', 'unregister_device(uuid,uuid)'])
def test_rpc_security(role, signature):
    assert execute('select has_function_privilege(%s,%s,\'EXECUTE\')', (role, 'public.' + signature), True) == [(role == 'service_role',)]
    assert execute('select proconfig,prosecdef from pg_proc where oid=%s::regprocedure', ('public.' + signature,), True) == [(['search_path=""'], True)]
    assert execute("select count(*) from pg_proc p,lateral aclexplode(p.proacl) a where p.oid=%s::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'", ('public.' + signature,), True) == [(0,)]


@pytest.mark.parametrize('role', ['anon', 'authenticated', 'service_role'])
@pytest.mark.parametrize('operation', ['select * from', 'delete from', 'insert into'])
def test_intent_ledger_is_rpc_only(role, operation):
    sql = operation + ' public.device_registration_intents' + (' default values' if operation == 'insert into' else '')
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        execute_as(role, sql)
    assert execute("select relrowsecurity from pg_class where oid='public.device_registration_intents'::regclass", fetch=True) == [(True,)]
