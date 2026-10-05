import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, get_current_user
from app.config import Settings
from app.dependencies import get_database
from app.main import app
from app.services.supabase import ProfileAlreadyExists, SupabaseDatabase


def database() -> SupabaseDatabase:
    return SupabaseDatabase(Settings(
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="sb_publishable_test",
        supabase_secret_key="sb_secret_test",
    ))


def conflict(constraint: str, column: str, value: str) -> httpx.Response:
    return httpx.Response(409, json={
        "code": "23505",
        "message": f'duplicate key value violates unique constraint "{constraint}"',
        "details": f"Key ({column})=({value}) already exists.",
        "hint": None,
    })


def install_transport(monkeypatch, handler) -> None:
    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr("app.services.supabase.httpx.AsyncClient", lambda *args, **kwargs: original_client(transport=transport))


@pytest.mark.parametrize("method", ["post", "patch"])
def test_username_constraint_maps_to_username_taken_even_when_value_is_profiles_pkey(monkeypatch, method):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method.lower() == method
        body = json.loads(request.content)
        assert body["username"] == "profiles_pkey"
        return conflict("profiles_username_key", "username", body["username"])

    install_transport(monkeypatch, handler)
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id="00000000-0000-0000-0000-000000000002")
    app.dependency_overrides[get_database] = database
    try:
        client = TestClient(app)
        payload = {"username": "profiles_pkey"}
        if method == "post":
            payload.update(display_name="User B", timezone="UTC")
        response = getattr(client, method)("/profiles/me", json=payload)
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "username_taken"
    finally:
        app.dependency_overrides.clear()


def test_primary_key_constraint_maps_to_profile_already_exists(monkeypatch):
    install_transport(monkeypatch, lambda request: conflict(
        "profiles_pkey", "user_id", "00000000-0000-0000-0000-000000000002"
    ))
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id="00000000-0000-0000-0000-000000000002")
    app.dependency_overrides[get_database] = database
    try:
        response = TestClient(app).post("/profiles/me", json={
            "username": "available", "display_name": "User B", "timezone": "UTC"
        })
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "profile_already_exists"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("response_factory", [
    lambda: conflict("some_other_unique_key", "username", "profiles_username_key"),
    lambda: httpx.Response(409, json={"code": "99999", "message": 'duplicate key value violates unique constraint "profiles_username_key"'}),
    lambda: httpx.Response(503, json={"message": 'profiles_username_key'}),
    lambda: httpx.Response(409, content=b"not-json", headers={"content-type": "text/plain"}),
])
async def test_unrecognized_or_malformed_upstream_errors_are_not_mislabeled(monkeypatch, response_factory):
    install_transport(monkeypatch, lambda request: response_factory())
    with pytest.raises(httpx.HTTPStatusError):
        await database().create_profile("00000000-0000-0000-0000-000000000002", {
            "username": "available", "display_name": "User B", "timezone": "UTC"
        })


async def test_adapter_primary_key_exception_is_specific(monkeypatch):
    install_transport(monkeypatch, lambda request: conflict("profiles_pkey", "user_id", "id"))
    with pytest.raises(ProfileAlreadyExists):
        await database().create_profile("00000000-0000-0000-0000-000000000002", {
            "username": "available", "display_name": "User B", "timezone": "UTC"
        })
