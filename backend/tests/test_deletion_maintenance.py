import asyncio
import json

import pytest

from app import deletion_maintenance as maintenance


class Database:
    def __init__(self, users):
        self.users = users
        self.claimed = set()
        self.completed = set()

    async def deletion_rpc(self, name, body):
        if name == 'account_deletion_pending_count':
            assert body == {}
            return len(self.users) - len(self.completed)
        assert name == 'claim_account_deletions'
        selected = [user for user in self.users if user not in self.claimed][:body['p_limit']]
        self.claimed.update(selected)
        return {'user_ids': selected, 'pending_count': len(self.users) - len(self.completed)}


async def test_sweep_only_resumes_pending_ledger_rows_with_bounded_concurrency():
    active = peak = 0
    calls = []
    database = Database(list(range(12)))
    class Workflow:
        async def resume_user(self, user):
            nonlocal active, peak
            calls.append(user)
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0)
            active -= 1
            database.completed.add(user)
            return 'complete'
    result = await maintenance.sweep(database, Workflow(), limit=10, concurrency=3)
    assert set(calls) == set(range(10))
    assert peak == 3
    assert result == {'event': 'deletion_maintenance', 'attempted': 10, 'completed': 10,
                      'pending': 2, 'errors': 0, 'timed_out': False}


async def test_one_failure_keeps_other_deletions_running_without_disclosing_identity(capsys):
    database = Database(['private-user', 'retry', 'ok'])
    class Workflow:
        async def resume_user(self, user):
            if user == 'private-user':
                raise RuntimeError('credential-bearing exception must not appear')
            if user == 'retry': return 'pending'
            database.completed.add(user)
            return 'complete'
    result = await maintenance.sweep(database, Workflow())
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
    assert result['timed_out'] is True and result['completed'] == 1 and result['pending'] == 2
    assert cancelled == ['slow']


@pytest.mark.parametrize('state,exit_code', [('complete', 0), ('pending', 1)])
async def test_command_exits_nonzero_for_unfinished_work(monkeypatch, capsys, state, exit_code):
    database = Database(['private-user'])
    class Workflow:
        async def resume_user(self, user):
            if state == 'complete': database.completed.add(user)
            return state
    monkeypatch.setattr(maintenance, 'get_settings', lambda: object())
    monkeypatch.setattr(maintenance, 'SupabaseDatabase', lambda _: database)
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


async def test_claim_timeout_is_inside_budget_and_reports_unknown_backlog():
    class SlowDatabase:
        async def deletion_rpc(self, *_):
            await asyncio.Event().wait()
    result = await maintenance.sweep(SlowDatabase(), object(), max_seconds=.01)
    assert result['timed_out'] and result['pending'] is None and result['attempted'] == 0


@pytest.mark.parametrize('kwargs', [{'limit': 0}, {'limit': 1001}, {'concurrency': 0},
                                  {'concurrency': 17}, {'max_seconds': 0}, {'max_seconds': 241}])
async def test_bounds_prevent_work_outliving_database_claim(kwargs):
    with pytest.raises(ValueError, match='bounds'):
        await maintenance.sweep(object(), object(), **kwargs)


async def test_timeout_does_not_claim_a_whole_sweep_of_unattempted_requests():
    database = Database(list(range(100)))
    class SlowWorkflow:
        async def resume_user(self, _):
            await asyncio.Event().wait()
    result = await maintenance.sweep(database, SlowWorkflow(), concurrency=2, max_seconds=.01)
    assert result['attempted'] == len(database.claimed) == 2
