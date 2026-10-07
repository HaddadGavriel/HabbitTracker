from copy import deepcopy
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, get_current_user
from app.dependencies import get_database
from app.main import app
from app.routers.occurrences import ERRORS
from app.services.supabase import OccurrenceError
from test_habits import BASE

OWNER, OID = str(UUID(int=1)), str(UUID(int=2))
ROW = {'id': OID, 'habit_id': str(UUID(int=3)), 'owner_id': OWNER,
       'local_date': '2026-03-01', 'timezone': 'UTC', 'closes_at': '2026-03-02T00:00:00Z',
       'snapshot': BASE | {'name': 'Read'}, 'progress': 0, 'completed': False, 'state': 'in_progress',
       'created_at': '2026-03-01T12:00:00Z', 'updated_at': '2026-03-01T12:00:00Z'}
ENDPOINTS = [('GET', '/today', None, {}),
    ('PUT', f'/occurrences/{OID}/completion', {'completed': True}, {}),
    ('PUT', f'/occurrences/{OID}/progress', {'progress': 10}, {}),
    ('POST', f'/occurrences/{OID}/progress-adjustments', {'delta': -1}, {'Idempotency-Key': 'request-1'})]


class Database:
    def __init__(self): self.calls = []; self.failure = None; self.missing = False; self.row = deepcopy(ROW)

    async def get_today(self, owner):
        self.calls.append(('today', owner))
        if self.failure: raise OccurrenceError(self.failure)
        return {'local_date': '2026-03-01', 'timezone': 'UTC', 'server_time': '2026-03-01T12:00:00Z', 'occurrences': [deepcopy(self.row)]}

    async def mutate_occurrence(self, owner, identifier, operation, value, key=None):
        self.calls.append((owner, identifier, operation, value, key))
        if self.failure: raise OccurrenceError(self.failure)
        return None if self.missing else deepcopy(ROW)


@pytest.fixture(autouse=True)
def overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def api():
    db = Database()
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=OWNER)
    app.dependency_overrides[get_database] = lambda: db
    with TestClient(app) as c: yield c, db


@pytest.mark.parametrize('method,path,body,headers', ENDPOINTS)
@pytest.mark.parametrize('token', [None, 'expired-token'])
def test_all_routes_require_valid_auth(monkeypatch, method, path, body, headers, token):
    original = httpx.AsyncClient
    monkeypatch.setattr('app.auth.httpx.AsyncClient', lambda *a, **kw: original(transport=httpx.MockTransport(lambda r: httpx.Response(401))))
    with TestClient(app) as c:
        if token: headers = headers | {'Authorization': 'Bearer ' + token}
        assert c.request(method, path, json=body, headers=headers).status_code == 401


@pytest.mark.parametrize('completed', [False, True])
def test_today_contract_and_completed_rows(api, completed):
    c, db = api
    db.row.update(completed=completed, state='completed' if completed else 'in_progress')
    response = c.get('/today'); assert response.status_code == 200
    assert response.json()['occurrences'][0]['snapshot']['name'] == 'Read'
    assert response.json()['occurrences'][0]['completed'] is completed
    assert db.calls == [('today', OWNER)]


@pytest.mark.parametrize('method,path,body,headers,operation,value,key', [
    (*ENDPOINTS[1], 'completion', True, None),
    ('PUT', f'/occurrences/{OID}/completion', {'completed': False}, {}, 'completion', False, None),
    (*ENDPOINTS[2], 'progress', 10, None), (*ENDPOINTS[3], 'adjustment', -1, 'request-1')])
def test_dispatch_uses_authenticated_owner_and_explicit_values(api, method, path, body, headers, operation, value, key):
    c, db = api
    assert c.request(method, path, json=body, headers=headers).status_code == 200
    assert db.calls == [(OWNER, OID, operation, value, key)]


@pytest.mark.parametrize('method,path,body,headers', ENDPOINTS)
def test_profile_required(api, method, path, body, headers):
    c, db = api; db.failure = 'profile_not_found'
    r = c.request(method, path, json=body, headers=headers)
    assert r.status_code == 404 and r.json()['detail']['code'] == 'profile_not_found'


@pytest.mark.parametrize('code', list(ERRORS)[1:])
def test_domain_errors(api, code):
    c, db = api; db.failure = code
    r = c.put(f'/occurrences/{OID}/progress', json={'progress': 1})
    assert r.status_code == ERRORS[code][0] and r.json()['detail']['code'] == code


@pytest.mark.parametrize('method,path,body,headers', ENDPOINTS[1:])
def test_missing_and_foreign_ids_have_same_404(api, method, path, body, headers):
    c, db = api; db.missing = True
    first = c.request(method, path, json=body, headers=headers)
    second = c.request(method, path.replace(OID, str(UUID(int=4))), json=body, headers=headers)
    assert first.status_code == second.status_code == 404 and first.json() == second.json()


@pytest.mark.parametrize('route,field,values', [
    ('completion', 'completed', [0, 1, 'true', None, 0.5]),
    ('progress', 'progress', [-1, True, False, 1.0, 1.5, '1', None]),
    ('progress-adjustments', 'delta', [True, False, 1.0, 1.5, '1', None]),
])
def test_strict_input_validation(api, route, field, values):
    c, db = api; method = 'POST' if route == 'progress-adjustments' else 'PUT'
    for value in values:
        assert c.request(method, f'/occurrences/{OID}/{route}', json={field: value}, headers={'Idempotency-Key': 'key'}).status_code == 422
    assert db.calls == []


@pytest.mark.parametrize('key', [None, '', 'x' * 129, 'with spaces', 'bad/key'])
def test_delta_key_required(api, key):
    c, db = api
    headers = {} if key is None else {'Idempotency-Key': key}
    assert c.post(f'/occurrences/{OID}/progress-adjustments', json={'delta': 1}, headers=headers).status_code == 422
    assert db.calls == []


@pytest.mark.parametrize('extra', ['owner_id', 'local_date', 'status', 'closes_at', 'timezone', 'now', 'test_clock'])
@pytest.mark.parametrize('method,path,body,headers', ENDPOINTS[1:])
def test_no_client_authority_fields(api, extra, method, path, body, headers):
    c, db = api
    assert c.request(method, path, json=body | {extra: 'untrusted'}, headers=headers).status_code == 422
    assert db.calls == []
