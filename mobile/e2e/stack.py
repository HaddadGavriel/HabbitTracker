#!/usr/bin/env python3
"""Owns a new local PG/PostgREST stack and fixture API; Ctrl-C removes everything.
No configurable project URLs, real credentials or shared databases are accepted.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
DOCKER = ['docker', '--host=unix:///var/run/docker.sock']
name = 'habittracker-smoke-' + uuid4().hex[:10]
pg, rest = name + '-pg', name + '-rest'
process = None


def docker(*args, input=None):
    return subprocess.check_output([*DOCKER, *args], input=input, text=True).strip()


def port(container, internal):
    return docker('port', container, internal).rsplit(':', 1)[1]


def sql(source):
    docker('exec', '-i', pg, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', input=source)


def stop(*_):
    raise KeyboardInterrupt


signal.signal(signal.SIGTERM, stop)
try:
    # Fixed public fixture port must be unused; never attach to an existing stack.
    import socket
    with socket.socket() as check:
        check.bind(('127.0.0.1', 18000))
    docker('network', 'create', name)
    docker('run', '-d', '--name', pg, '--network', name, '-e', 'POSTGRES_PASSWORD=disposable-only',
           '-p', '127.0.0.1::5432', 'postgres:16')
    for _ in range(30):
        if subprocess.call([*DOCKER, 'exec', pg, 'pg_isready', '-U', 'postgres'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0:
            break
        time.sleep(1)
    sql((ROOT / 'backend/tests/postgres_scaffold.sql').read_text())
    for migration in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
        sql(migration.read_text())
    sql("""insert into auth.users(id) values
      ('aaaaaaaa-1111-4111-8111-111111111111'), ('bbbbbbbb-2222-4222-8222-222222222222');
      select public.register_device_intent('aaaaaaaa-1111-4111-8111-111111111111',
        'ExpoPushToken[smoke-only-never-sent]', 'android', 'eeeeeeee-1111-4111-8111-111111111111');""")
    docker('run', '-d', '--name', rest, '--network', name, '-p', '127.0.0.1::3000',
           '-e', f'PGRST_DB_URI=postgres://postgres:disposable-only@{pg}:5432/postgres',
           '-e', 'PGRST_DB_ANON_ROLE=service_role', '-e', 'PGRST_DB_SCHEMAS=public', 'postgrest/postgrest:v12.2.12')
    env = {**os.environ, 'SMOKE_LOCAL_ONLY': '1',
           'SMOKE_DATABASE_URL': f'postgresql://postgres:disposable-only@127.0.0.1:{port(pg,"5432/tcp")}/postgres',
           'SMOKE_REST_URL': f'http://127.0.0.1:{port(rest,"3000/tcp")}',
           'SUPABASE_URL': 'http://127.0.0.1:18000', 'SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_smoke_only',
           'SUPABASE_SECRET_KEY': 'sb_secret_smoke_only', 'EXPO_PUSH_URL': 'http://127.0.0.1:18000/fixture-push',
           'ENABLE_DIAGNOSTICS': 'false'}
    process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'smoke.server:app', '--host', '127.0.0.1', '--port', '18000', '--no-access-log'], cwd=ROOT / 'backend', env=env)
    for _ in range(40):
        try:
            with urllib.request.urlopen('http://127.0.0.1:18000/smoke-ready', timeout=1) as response:
                assert json.load(response)['environment'] == 'disposable-local-only'
            break
        except OSError:
            if process.poll() is not None:
                raise RuntimeError('Fixture API failed to start')
            time.sleep(.5)
    else:
        raise RuntimeError('Fixture API did not become ready')
    print('Ready: local smoke API :18000; fixture Auth and push recorder; all migrations applied.', flush=True)
    process.wait()
except KeyboardInterrupt:
    pass
finally:
    if process:
        process.terminate()
        process.wait(timeout=10)
    for container in (rest, pg):
        subprocess.run([*DOCKER, 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([*DOCKER, 'network', 'rm', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
