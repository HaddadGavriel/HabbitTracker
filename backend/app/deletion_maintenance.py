"""Run with: python -m app.deletion_maintenance (server credentials only)."""
import asyncio
from .config import get_settings
from .services.supabase import SupabaseDatabase
from .services.account_deletion import AccountDeletion, AuthDeletionAdapter


async def main():
    settings = get_settings()
    database = SupabaseDatabase(settings)
    workflow = AccountDeletion(database, AuthDeletionAdapter(settings))
    pending = await database.deletion_rpc('pending_account_deletions', {})
    completed = 0
    for user_id in pending:
        completed += await workflow.resume_user(user_id) == 'complete'
    # Aggregate counts only. No identities, receipts, passwords, or tokens.
    print(f'Deletion maintenance: {completed} completed; {len(pending)-completed} pending')


if __name__ == '__main__':
    asyncio.run(main())
