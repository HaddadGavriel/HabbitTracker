import json

import httpx
import pytest

from app.services.supabase import OccurrenceError
from test_friend_database_adapter import db, transport


async def test_today_payload_and_object(monkeypatch):
    view = {'local_date': '2026-03-01', 'timezone': 'UTC', 'occurrences': []}
    def handler(request):
        assert request.url.path == '/rest/v1/rpc/get_today'
        assert request.method == 'POST' and json.loads(request.content) == {'p_owner': 'owner'}
        assert request.headers['apikey'] == 'sb_secret_test' and 'authorization' not in request.headers
        return httpx.Response(200, json=view)
    transport(monkeypatch, handler)
    assert await db().get_today('owner') == view


@pytest.mark.parametrize('operation,value,key', [('completion', True, None), ('completion', False, None),
    ('progress', 0, None), ('progress', 10**30, None), ('adjustment', -2, 'request-1')])
@pytest.mark.parametrize('rows', [[], [{'id': 'occurrence'}]])
async def test_atomic_mutation_payload_headers_and_result(monkeypatch, operation, value, key, rows):
    def handler(request):
        assert request.method == 'POST' and request.url.path == '/rest/v1/rpc/mutate_occurrence'
        assert request.headers['apikey'] == 'sb_secret_test' and 'authorization' not in request.headers
        assert json.loads(request.content) == {'p_owner': 'owner', 'p_occurrence': 'occurrence',
            'p_operation': operation, 'p_value': value, 'p_key': key}
        return httpx.Response(200, json=rows)
    transport(monkeypatch, handler)
    assert await db().mutate_occurrence('owner', 'occurrence', operation, value, key) == (rows[0] if rows else None)


@pytest.mark.parametrize('code', ['wrong_occurrence_type', 'occurrence_closed', 'negative_progress',
    'invalid_occurrence_value', 'invalid_idempotency_key', 'idempotency_conflict'])
async def test_committed_error_envelopes(monkeypatch, code):
    transport(monkeypatch, lambda r: httpx.Response(200, json=[{'error': code}]))
    with pytest.raises(OccurrenceError) as exc: await db().mutate_occurrence('a', 'b', 'progress', 1)
    assert exc.value.code == code


@pytest.mark.parametrize('method,args', [('get_today', ['a']), ('mutate_occurrence', ['a', 'b', 'completion', True])])
async def test_profile_missing(monkeypatch, method, args):
    transport(monkeypatch, lambda r: httpx.Response(400, json={'code': 'P0001', 'message': 'profile_not_found'}))
    with pytest.raises(OccurrenceError, match='profile_not_found'):
        await getattr(db(), method)(*args)


@pytest.mark.parametrize('status,payload', [(500, {'code': 'XX000', 'message': 'profile_not_found'}),
    (400, []), (400, {'message': 'profile_not_found'}), (400, {'code': 'P0001', 'message': 'unknown'}),
    (400, 'invalid json')])
async def test_unknown_database_failures_propagate(monkeypatch, status, payload):
    transport(monkeypatch, lambda r: httpx.Response(status, text=payload) if isinstance(payload, str) else httpx.Response(status, json=payload))
    with pytest.raises(httpx.HTTPStatusError): await db().get_today('a')
