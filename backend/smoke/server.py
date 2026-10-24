"""Local smoke-only Auth facade around the real API and disposable PostgREST.
Never imported by app.main. No external Auth or push requests are permitted.
"""
import base64
import json
import os
import time

import httpx
import psycopg
from fastapi import FastAPI, HTTPException, Request, Response

if os.environ.get('SMOKE_LOCAL_ONLY') != '1':
    raise RuntimeError('Start using mobile/e2e/stack.py; this is not a deployment entry point')
DB = os.environ['SMOKE_DATABASE_URL']
REST = os.environ['SMOKE_REST_URL']
if not DB.startswith('postgresql://postgres:disposable-only@127.0.0.1:') or not REST.startswith('http://127.0.0.1:'):
    raise RuntimeError('Smoke stack must be disposable and loopback-only')
if os.environ['SUPABASE_URL'] != 'http://127.0.0.1:18000' or os.environ['EXPO_PUSH_URL'] != 'http://127.0.0.1:18000/fixture-push':
    raise RuntimeError('Unsafe smoke configuration')

from app.main import app as api
from app.dependencies import get_push_service

USERS = {
    'alice@habittracker.test': 'aaaaaaaa-1111-4111-8111-111111111111',
    'bob@habittracker.test': 'bbbbbbbb-2222-4222-8222-222222222222',
}
PASSWORD = 'Smoke-only-123!'
TOKENS = {}
pushes = []


def user(email):
    return {'id': USERS[email], 'email': email, 'aud': 'authenticated', 'role': 'authenticated',
            'email_confirmed_at': '2026-01-01T00:00:00Z', 'created_at': '2026-01-01T00:00:00Z',
            'app_metadata': {'provider': 'email'}, 'user_metadata': {}, 'identities': []}


def session(email):
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    token = f"{encode({'alg': 'HS256', 'typ': 'JWT'})}.{encode({'sub': USERS[email], 'exp': int(time.time()) + 3600, 'role': 'authenticated'})}.fixture-signature"
    TOKENS[token] = email
    return {'access_token': token, 'refresh_token': 'fixture-refresh-' + email, 'token_type': 'bearer',
            'expires_in': 3600, 'expires_at': int(time.time()) + 3600, 'user': user(email)}


class NoPush:
    async def send_reminder(self, devices, notification):
        pushes.append({'devices': len(devices), 'type': notification.get('type', 'habit_reminder')})
        return [{'device_id': d['id'], 'status': 'accepted', 'ticket_id': f'fixture-{len(pushes)}-{i}'} for i, d in enumerate(devices)]

    async def send(self, *args):
        raise RuntimeError('Diagnostics are disabled in smoke tests')


api.dependency_overrides[get_push_service] = NoPush
app = FastAPI()
app.mount('/api', api)


@app.get('/smoke-ready')
async def ready():
    return {'environment': 'disposable-local-only', 'real_pushes': False, 'accounts': list(USERS)}


@app.post('/auth/v1/token')
@app.post('/auth/v1/signup')
async def login(request: Request):
    body = await request.json()
    email = body.get('email')
    if request.query_params.get('grant_type') == 'refresh_token':
        email = body.get('refresh_token', '').removeprefix('fixture-refresh-')
    elif body.get('password') != PASSWORD:
        raise HTTPException(400, 'Fixture credentials required')
    if email not in USERS:
        raise HTTPException(400, 'Only the two documented fixture accounts exist')
    with psycopg.connect(DB) as db:
        if not db.execute('select 1 from auth.users where id=%s', (USERS[email],)).fetchone():
            raise HTTPException(400, 'Fixture account deleted')
    return session(email)


@app.get('/auth/v1/user')
async def current_user(request: Request):
    email = TOKENS.get(request.headers.get('authorization', '').removeprefix('Bearer '))
    if not email:
        raise HTTPException(401, 'Invalid fixture session')
    return user(email)


@app.post('/auth/v1/logout')
async def logout():
    return Response(status_code=204)


@app.api_route('/rest/v1/{path:path}', methods=['GET', 'POST', 'PATCH', 'DELETE'])
async def rest_proxy(path: str, request: Request):
    if request.headers.get('apikey') != 'sb_secret_smoke_only':
        raise HTTPException(403, 'No direct mobile database access')
    headers = {k: v for k, v in request.headers.items() if k in ('prefer', 'content-type', 'accept')}
    async with httpx.AsyncClient(trust_env=False) as client:
        response = await client.request(request.method, f'{REST}/{path}', params=request.query_params,
                                        headers=headers, content=await request.body())
    return Response(response.content, response.status_code, media_type=response.headers.get('content-type'),
                    headers={k: v for k, v in response.headers.items() if k in ('content-range', 'range-unit')})


@app.get('/smoke-pushes')
async def recorded_pushes():
    return {'recorded': pushes, 'real_pushes': False}
