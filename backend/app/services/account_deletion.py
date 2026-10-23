"""Auth adapter and resumable deletion orchestration; never log HTTP exceptions."""
import hashlib

import httpx

from ..config import Settings
from .supabase import SupabaseDatabase


def receipt_hash(receipt: str) -> str:
    return hashlib.sha256(receipt.encode('ascii')).hexdigest()


class ReauthenticationFailed(Exception):
    pass


class AuthDeletionAdapter:
    def __init__(self, settings: Settings):
        self.url = settings.supabase_url.rstrip('/') + '/auth/v1'
        self.public_key = settings.supabase_publishable_key
        self.secret_key = settings.supabase_secret_key

    async def reauthenticate(self, user_id: str, email: str, password: str) -> None:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(self.url + '/token', params={'grant_type': 'password'},
                headers={'apikey': self.public_key}, json={'email': email, 'password': password})
            if response.status_code != 200 or response.json().get('user', {}).get('id') != user_id:
                raise ReauthenticationFailed
            # Reauthentication uses an isolated HTTP client; it never replaces
            # the mobile session or trusts a client-supplied email/user ID.

    async def delete_and_confirm(self, user_id: str) -> bool:
        headers = {'apikey': self.secret_key}
        async with httpx.AsyncClient(timeout=15) as client:
            # First inspect: a retry after a lost DELETE response must succeed.
            response = await client.get(f'{self.url}/admin/users/{user_id}', headers=headers)
            if self._missing(response):
                return True
            response.raise_for_status()
            response = await client.request('DELETE', f'{self.url}/admin/users/{user_id}', headers=headers, json={'should_soft_delete': False})
            if not self._missing(response):
                response.raise_for_status()
            response = await client.get(f'{self.url}/admin/users/{user_id}', headers=headers)
            if self._missing(response):
                return True
            response.raise_for_status()
            return False

    @staticmethod
    def _missing(response: httpx.Response) -> bool:
        # A proxy's generic 404 is not proof that an Auth user was deleted.
        if response.status_code != 404:
            return False
        try:
            body = response.json()
            return body.get('code') == 'user_not_found' or body.get('error_code') == 'user_not_found'
        except (ValueError, AttributeError):
            return False


class AccountDeletion:
    def __init__(self, database: SupabaseDatabase, auth: AuthDeletionAdapter):
        self.database, self.auth = database, auth

    async def resume_user(self, user_id: str) -> str:
        try:
            if not await self.auth.delete_and_confirm(user_id):
                return 'pending'
            # PostgreSQL independently confirms auth.users is absent. If the
            # Auth gateway and DB disagree, leave pending for maintenance.
            return await self.database.deletion_rpc('complete_account_deletion', {'p_user': user_id})
        except (httpx.HTTPError, ValueError):
            # Do not log exceptions: request objects can contain credentials.
            return 'pending'

    async def recover(self, receipt: str) -> str:
        record = await self.database.deletion_rpc('account_deletion_status', {'p_hash': receipt_hash(receipt)})
        if record is None:
            return 'not_found'
        if record['state'] == 'complete':
            return 'complete'
        return await self.resume_user(record['user_id'])
