from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from ..auth import AuthenticatedUser, get_authenticated_user
from ..config import Settings, get_settings
from ..dependencies import get_database
from ..services.account_deletion import AccountDeletion, AuthDeletionAdapter, ReauthenticationFailed, receipt_hash
from ..services.supabase import SupabaseDatabase

router = APIRouter(prefix='/account', tags=['account'])


class Receipt(BaseModel):
    model_config = ConfigDict(extra='forbid')
    receipt: str = Field(pattern=r'^[0-9a-f]{64}$')


class DeleteAccount(Receipt):
    password: SecretStr = Field(min_length=1, max_length=1024)
    confirmation: Literal['DELETE MY ACCOUNT']


class DeletionResult(BaseModel):
    state: Literal['pending', 'complete', 'not_found']


def get_deletion(database: SupabaseDatabase = Depends(get_database), settings: Settings = Depends(get_settings)):
    return AccountDeletion(database, AuthDeletionAdapter(settings))


@router.post('/deletion', response_model=DeletionResult)
async def delete_account(body: DeleteAccount, user: AuthenticatedUser = Depends(get_authenticated_user),
                         workflow: AccountDeletion = Depends(get_deletion)):
    if not user.email:
        raise HTTPException(400, detail={'code': 'password_account_required', 'message': 'An email/password account is required.'})
    try:
        await workflow.auth.reauthenticate(user.id, user.email, body.password.get_secret_value())
    except ReauthenticationFailed:
        raise HTTPException(403, detail={'code': 'reauthentication_failed', 'message': 'Check your current password.'}) from None
    except (httpx.HTTPError, ValueError):
        raise HTTPException(503, detail={'code': 'reauthentication_unavailable', 'message': 'Unable to verify your password. Retry.'}) from None
    try:
        await workflow.database.deletion_rpc('begin_account_deletion', {'p_user': user.id, 'p_hash': receipt_hash(body.receipt)})
    except httpx.HTTPError:
        # Commit may have happened. The already-persisted receipt is the only
        # recovery credential; never claim rollback or deletion here.
        raise HTTPException(503, detail={'code': 'deletion_unconfirmed', 'message': 'Check deletion status using your saved receipt.'}) from None
    try:
        return {'state': await workflow.recover(body.receipt)}
    except (httpx.HTTPError, ValueError):
        return {'state': 'pending'}


@router.post('/deletion/recover', response_model=DeletionResult)
async def recover_account(body: Receipt, workflow: AccountDeletion = Depends(get_deletion)):
    # The random 256-bit receipt is a narrowly scoped capability, required when
    # Auth has already revoked the user's session. Never put it in a URL or log.
    try:
        return {'state': await workflow.recover(body.receipt)}
    except (httpx.HTTPError, ValueError):
        raise HTTPException(503, detail={'code': 'deletion_unconfirmed', 'message': 'Unable to confirm deletion. Retry status.'}) from None
