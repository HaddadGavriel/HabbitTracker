import asyncio
import json

import pytest

from app import deletion_maintenance as maintenance


class Database:
    def __init__(self, users):
        self.users = users

    async def deletion_rpc(self, name, body):
        assert (name, body) == ('pending_account_deletions', {})
        return self.users


async def test_sweep_only_resumes_pending_ledger_rows_with_bounded_concurrency():
    active = peak = 0
    calls = []
    class Workflow:
        async def resume_user(self, user):
            nonlocal active, peak
            calls.append(user)
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0)
            active -= 1
            return 'complete'
    result = await maintenance.sweep(Database(list(range(12))), Workflow(), limit=10, concurrency=3)
    assert set(calls) == set(range(10))
    assert peak == 3
    assert result == {'event': 'deletion_maintenance', 'attempted': 10, 'completed': 10,
                      'pending': 2, 'deferred': 2, 'errors': 0, 'timed_out': False}


async def test_one_failure_keeps_other_deletions_running_without_disclosing_identity(capsys):
    class Workflow:
        async def resume_user(self, user):
            if user == 'private-user':
                raise RuntimeError('credential-bearing exception must not appear')
            return 'pending' if user == 'retry' else 'complete'
    result = await maintenance.sweep(Database(['private-user', 'retry', 'ok']), Workflow())
    assert result['completed'] == 1 and result['pending'] == 2 and result['errors'] == 1
    assert capsys.readouterr().out == ''


async def test_deadline_cancels_inflight_work_and_leaves_it_pending_for_next_sweep():
    cancelled = []
    class Workflow:
        async def resume_user(self, user):
            if user == 'fast':
                return 'complete'
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(user)
    result = await maintenance.sweep(Database(['fast', 'slow']), Workflow(), max_seconds=0.02)
    assert result['timed_out'] is True and result['completed'] == 1 and result['pending'] == 1
    assert cancelled == ['slow']


@pytest.mark.parametrize('state,exit_code', [('complete', 0), ('pending', 1)])
async def test_command_exits_nonzero_for_unfinished_work(monkeypatch, capsys, state, exit_code):
    class Workflow:
        async def resume_user(self, user):
            return state
    monkeypatch.setattr(maintenance, 'get_settings', lambda: object())
    monkeypatch.setattr(maintenance, 'SupabaseDatabase', lambda _: Database(['private-user']))
    monkeypatch.setattr(maintenance, 'AuthDeletionAdapter', lambda _: object())
    monkeypatch.setattr(maintenance, 'AccountDeletion', lambda *_: Workflow())
    assert await maintenance.main() == exit_code
    output = capsys.readouterr().out
    assert 'private-user' not in output
    assert json.loads(output)['completed'] == (state == 'complete')


async def test_unavailable_configuration_or_ledger_reports_failure_without_secrets(monkeypatch, capsys):
    def unavailable():
        raise ValueError('SUPABASE_SECRET_KEY=private')
    monkeypatch.setattr(maintenance, 'get_settings', unavailable)
    assert await maintenance.main() == 1
    assert json.loads(capsys.readouterr().out) == {'event': 'deletion_maintenance', 'status': 'failed'}


async def test_empty_ledger_never_calls_auth_deletion():
    result = await maintenance.sweep(Database([]), object())
    assert result['attempted'] == result['completed'] == result['pending'] == 0
