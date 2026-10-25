"""Bounded, idempotent sweep of already-authorized deletion requests only."""
import argparse
import asyncio
import json
from .config import get_settings
from .services.supabase import SupabaseDatabase
from .services.account_deletion import AccountDeletion, AuthDeletionAdapter


async def sweep(database, workflow, *, limit=100, concurrency=4, max_seconds=240):
    pending = await database.deletion_rpc('pending_account_deletions', {})
    completed = attempted = errors = 0
    selected = pending[:limit]
    semaphore = asyncio.Semaphore(concurrency)

    async def resume(user_id):
        nonlocal completed, attempted, errors
        async with semaphore:
            attempted += 1
            try:
                state = await workflow.resume_user(user_id)
                completed += state == 'complete'
            except Exception:
                # One corrupt/transient request must not stop other authorized
                # requests. Never print exceptions carrying HTTP credentials.
                errors += 1

    timed_out = False
    try:
        async with asyncio.timeout(max_seconds):
            await asyncio.gather(*(resume(user_id) for user_id in selected))
    except TimeoutError:
        # Cancellation can follow a successful remote delete. The durable ledger
        # makes the next sweep confirm absence and safely finish that request.
        timed_out = True
    return {'event': 'deletion_maintenance', 'attempted': attempted, 'completed': completed,
            'pending': len(pending) - completed, 'deferred': len(pending) - attempted,
            'errors': errors, 'timed_out': timed_out}


async def main(*, limit=100, concurrency=4, max_seconds=240):
    try:
        settings = get_settings()
        database = SupabaseDatabase(settings)
        workflow = AccountDeletion(database, AuthDeletionAdapter(settings))
        result = await sweep(database, workflow, limit=limit, concurrency=concurrency, max_seconds=max_seconds)
    except Exception:
        print(json.dumps({'event': 'deletion_maintenance', 'status': 'failed'}))
        return 1
    # Aggregate counts only. A remaining backlog is a failed run for monitoring,
    # not a success merely because the process reached the end of its loop.
    print(json.dumps(result, sort_keys=True))
    return int(result['pending'] > 0 or result['timed_out'] or result['errors'] > 0)


def positive_integer(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError('must be positive')
    return number


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--limit', type=positive_integer, default=100)
    parser.add_argument('--concurrency', type=positive_integer, default=4)
    parser.add_argument('--max-seconds', type=positive_integer, default=240)
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(**vars(args))))
