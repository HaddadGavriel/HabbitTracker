"""Isolated testing entry point; production continues to use app.main:app."""
import os
from pathlib import Path
import re
import sys

PRODUCTION_REF = 'zsqzenswefkjaundwyct'


def validate(environment):
    ref = environment.get('INTERNAL_TESTING_SUPABASE_REF', '')
    if not re.fullmatch('[a-z]{20}', ref) or ref == PRODUCTION_REF:
        raise ValueError('An isolated Supabase branch ref is required; production is forbidden.')
    if environment.get('SUPABASE_URL', '').rstrip('/') != f'https://{ref}.supabase.co':
        raise ValueError('Backend URL must match the isolated Supabase branch.')
    if not environment.get('SUPABASE_PUBLISHABLE_KEY', '').startswith('sb_publishable_'):
        raise ValueError('The isolated project publishable key is required.')
    if not environment.get('SUPABASE_SECRET_KEY'):
        raise ValueError('The isolated project server secret is required.')
    if environment.get('ENABLE_DIAGNOSTICS', 'false').lower() != 'false':
        raise ValueError('Diagnostics must remain disabled.')


if __name__ == '__main__':
    try:
        validate(os.environ)
    except ValueError as error:
        raise SystemExit(str(error))
    backend = Path(__file__).resolve().parents[2] / 'backend'
    os.chdir(backend)
    os.execv(sys.executable, [sys.executable, '-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', os.environ.get('PORT', '10000')])
