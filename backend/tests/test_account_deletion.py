import httpx
import pytest
from fastapi.testclient import TestClient
from app.auth import AuthenticatedUser, get_authenticated_user, get_current_user
from app.main import app
from app.routers.account import get_deletion
from app.services.account_deletion import AccountDeletion, AuthDeletionAdapter, ReauthenticationFailed, receipt_hash
from app.config import get_settings

RECEIPT = 'a' * 64

class Database:
    def __init__(self):
        self.records = {}; self.calls = []; self.fail_complete = False
    async def deletion_rpc(self, function, body):
        self.calls.append((function, body))
        if function == 'begin_account_deletion':
            self.records[body['p_hash']] = {'user_id': body['p_user'], 'state': 'pending'}
            return 'pending'
        if function == 'account_deletion_status': return self.records.get(body['p_hash'])
        if function == 'complete_account_deletion':
            if self.fail_complete: raise httpx.ConnectError('sensitive error must not escape')
            for record in self.records.values(): record['state'] = 'complete'
            return 'complete'

class Auth:
    def __init__(self): self.fail = False; self.confirm = True; self.reauth = True; self.deleted = []
    async def reauthenticate(self, user, email, password):
        if not self.reauth: raise ReauthenticationFailed
        assert (user,email,password) == ('validated-user','existing@example.com','current-password')
    async def delete_and_confirm(self, user):
        self.deleted.append(user)
        if self.fail: raise httpx.ConnectError('password token secret')
        return self.confirm

@pytest.fixture
def api():
    db, auth = Database(), Auth()
    workflow = AccountDeletion(db, auth)
    app.dependency_overrides[get_authenticated_user] = lambda: AuthenticatedUser('validated-user','existing@example.com')
    app.dependency_overrides[get_deletion] = lambda: workflow
    yield TestClient(app), db, auth, workflow
    app.dependency_overrides.clear()


def payload(**extra): return {'receipt':RECEIPT,'password':'current-password','confirmation':'DELETE MY ACCOUNT',**extra}


def test_password_confirmation_and_target_authorization(api):
    client, db, auth, _ = api
    for change in [{'user_id':'victim'}, {'email':'victim@example.com'}, {'confirmation':'yes'}]:
        assert client.post('/account/deletion',json=payload(**change)).status_code == 422
    auth.reauth = False
    response = client.post('/account/deletion',json=payload())
    assert response.status_code == 403 and not db.calls and not auth.deleted
    auth.reauth = True
    assert client.post('/account/deletion',json=payload()).json() == {'state':'complete'}
    assert auth.deleted == ['validated-user']
    assert db.calls[0] == ('begin_account_deletion', {'p_user':'validated-user','p_hash':receipt_hash(RECEIPT)})


def test_auth_failure_persists_pending_and_receipt_recovers_without_session(api):
    client, db, auth, _ = api
    auth.fail = True
    assert client.post('/account/deletion',json=payload()).json() == {'state':'pending'}
    assert db.records[receipt_hash(RECEIPT)]['state'] == 'pending'
    auth.fail = False
    app.dependency_overrides.pop(get_authenticated_user)
    assert client.post('/account/deletion/recover',json={'receipt':RECEIPT}).json() == {'state':'complete'}
    assert client.post('/account/deletion/recover',json={'receipt':RECEIPT}).json() == {'state':'complete'}
    assert client.post('/account/deletion/recover',json={'receipt':'b'*64}).json() == {'state':'not_found'}
    assert client.post('/account/deletion/recover',json={'receipt':RECEIPT,'user_id':'victim'}).status_code == 422


def test_unconfirmed_auth_and_failed_finalization_never_report_complete(api):
    client, db, auth, _ = api
    auth.confirm = False
    assert client.post('/account/deletion',json=payload()).json() == {'state':'pending'}
    auth.confirm = True; db.fail_complete = True
    assert client.post('/account/deletion/recover',json={'receipt':RECEIPT}).json() == {'state':'pending'}
    db.fail_complete = False
    assert client.post('/account/deletion/recover',json={'receipt':RECEIPT}).json() == {'state':'complete'}


@pytest.mark.asyncio
@pytest.mark.parametrize('mode',['already_absent','delete_lost','delete_failed','verify_active','success','generic_404'])
async def test_real_auth_adapter_http_failure_modes(monkeypatch, mode):
    requests = []
    async def handler(request):
        requests.append(request)
        assert request.headers['apikey'] == 'sb_secret_test'
        assert 'authorization' not in request.headers
        missing = httpx.Response(404,json={'code':'user_not_found'})
        if mode == 'generic_404': return httpx.Response(404,text='Proxy missing')
        if len(requests) == 1: return missing if mode == 'already_absent' else httpx.Response(200,json={'id':'u'})
        if request.method == 'DELETE':
            if mode == 'delete_lost': raise httpx.ReadTimeout('lost')
            return httpx.Response(500 if mode == 'delete_failed' else 200,json={})
        return httpx.Response(200,json={'id':'u'}) if mode == 'verify_active' else missing
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx,'AsyncClient',lambda **kwargs: original(transport=httpx.MockTransport(handler)))
    adapter = AuthDeletionAdapter(get_settings())
    if mode in ('delete_lost','delete_failed','generic_404'):
        with pytest.raises(httpx.HTTPError): await adapter.delete_and_confirm('u')
    else: assert await adapter.delete_and_confirm('u') == (mode != 'verify_active')


@pytest.mark.asyncio
async def test_reauthentication_checks_returned_identity(monkeypatch):
    async def handler(request):
        assert request.url.params['grant_type'] == 'password'
        return httpx.Response(200,json={'user':{'id':'other'},'access_token':'never log'})
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx,'AsyncClient',lambda **kwargs: original(transport=httpx.MockTransport(handler)))
    with pytest.raises(ReauthenticationFailed):
        await AuthDeletionAdapter(get_settings()).reauthenticate('expected','existing@example.com','password')


def test_account_validation_does_not_echo_password_or_receipt(api):
    client, *_ = api
    response = client.post('/account/deletion', json=payload(confirmation='wrong', password='private-password'))
    assert response.status_code == 422
    assert 'private-password' not in response.text and RECEIPT not in response.text


def test_pending_account_is_blocked_before_profile_read_or_reonboarding(api, monkeypatch):
    from app.services.supabase import SupabaseDatabase
    async def pending(self, function, body):
        assert function == 'account_is_deleting' and body == {'p_user':'validated-user'}
        return True
    monkeypatch.setattr(SupabaseDatabase, 'deletion_rpc', pending)
    client, *_ = api
    for method in ['get','post','patch']:
        response = getattr(client, method)('/profiles/me')
        assert response.status_code == 409
        assert response.json()['detail']['code'] == 'account_deletion_pending'


def test_deletion_start_requires_validated_authentication():
    assert TestClient(app).post('/account/deletion', json=payload()).status_code == 401


def test_lost_begin_response_is_recoverable_and_status_failure_after_commit_is_pending(api):
    client, db, auth, workflow = api
    original = db.deletion_rpc
    mode = 'lost_begin'
    async def failure(function, body):
        result = await original(function, body)
        if mode == 'lost_begin' and function == 'begin_account_deletion':
            raise httpx.ReadTimeout('commit response lost')
        if mode == 'lost_status' and function == 'account_deletion_status':
            raise httpx.ConnectError('read unavailable')
        return result
    db.deletion_rpc = failure
    assert client.post('/account/deletion',json=payload()).status_code == 503
    assert not auth.deleted and db.records
    mode = 'lost_status'
    assert client.post('/account/deletion',json=payload()).json() == {'state':'pending'}
    mode = 'recovered'
    assert client.post('/account/deletion/recover',json={'receipt':RECEIPT}).json() == {'state':'complete'}
