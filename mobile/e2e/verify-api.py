#!/usr/bin/env python3
"""Exercises the real local HTTP/PostgREST stack, without native UI or live Auth/FCM.
Run on a fresh stack. Restart stack before Maestro, which owns its own fixture data.
"""
import json
import urllib.request
import urllib.error

BASE = 'http://127.0.0.1:18000'

def request(path, token=None, body=None, method='GET', expected=200, headers=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
      method=method, headers={'Content-Type': 'application/json', **({'Authorization': f'Bearer {token}'} if token else {}), **(headers or {})})
    try:
        response = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read()
    assert response.status == expected, (path, response.status, raw.decode()[:500])
    return json.loads(raw) if raw else None

assert request('/smoke-ready') == {'environment': 'disposable-local-only', 'real_pushes': False, 'accounts': ['alice@habittracker.test', 'bob@habittracker.test']}
a, b = [request('/auth/v1/token?grant_type=password', body={'email': f'{name}@habittracker.test', 'password': 'Smoke-only-123!'}, method='POST') for name in ('alice', 'bob')]
A, B = a['access_token'], b['access_token']
for session, name in [(a, 'alice'), (b, 'bob')]:
    request('/api/profiles/me', session['access_token'], {'username': f'smoke_{name}', 'display_name': name, 'timezone': 'UTC'}, 'POST', 201)
habit = request('/api/habits', A, {'name': 'HTTP shared', 'type': 'binary', 'schedule': 'daily', 'weekdays': [], 'reminder_times': ['08:00', '21:30']}, 'POST', 201)
hid = habit['id']
assert request('/api/shared-habits', B) == []
friend = request('/api/friend-requests', A, {'recipient_user_id': b['user']['id']}, 'POST', 201)
request(f"/api/friend-requests/{friend['id']}/accept", B, {}, 'POST')
request(f"/api/habits/{hid}/shares/{b['user']['id']}", A, {}, 'PUT')
assert len(request('/api/shared-habits', B)) == 1
request(f'/api/habits/{hid}', B, expected=404)
occurrence = request('/api/today', A)['occurrences'][0]['id']
request(f'/api/occurrences/{occurrence}/completion', A, {'completed': True}, 'PUT')
request(f'/api/occurrences/{occurrence}/completion', A, {'completed': False}, 'PUT')
reminder = request(f'/api/shared-habits/{hid}/reminders', B, {}, 'POST', headers={'Idempotency-Key': 'fixture-one'})
assert reminder['status'] == 'provider_accepted', reminder
assert request(f'/api/shared-habits/{hid}/reminders', B, {}, 'POST', headers={'Idempotency-Key': 'fixture-one'})['id'] == reminder['id']
assert len(request('/smoke-pushes')['recorded']) == 1
excuse = request(f'/api/occurrences/{occurrence}/excuse', A, {'explanation': 'HTTP fixture'}, 'POST', 201)
assert len(request('/api/excuses/pending', B)) == 1
request(f"/api/excuses/{excuse['id']}/decision", B, {'decision': 'approve'}, 'POST')
assert request('/api/today', A)['occurrences'][0]['state'] == 'excused'
request(f"/api/habits/{hid}/shares/{b['user']['id']}", A, method='DELETE', expected=204)
assert request('/api/shared-habits', B) == []
request(f'/api/shared-habits/{hid}', B, expected=404)
request('/api/today', expected=401)
request('/rest/v1/profiles', headers={'apikey': 'sb_publishable_smoke_only'}, expected=403)
print('PASS: local Auth fixture → real HTTP API → real PostgREST → migrated PostgreSQL; owner/social authorization, idempotency and fake push recording. No device or live Auth/FCM claim.')
