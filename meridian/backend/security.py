from __future__ import annotations

import os
import secrets
from typing import Awaitable, Callable

from fastapi import HTTPException, Request
from starlette.responses import Response


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def packaged_mode() -> bool:
    return _env_flag("MERIDIAN_PACKAGED_BACKEND", False)


def auth_required() -> bool:
    return packaged_mode() or _env_flag("MERIDIAN_REQUIRE_BACKEND_AUTH", True)


def profile_store_enabled() -> bool:
    if os.environ.get("MERIDIAN_ENABLE_PROFILE_STORE") is not None:
        return _env_flag("MERIDIAN_ENABLE_PROFILE_STORE", False)
    return False


def validate_startup_security() -> None:
    if auth_required() and not os.environ.get("MERIDIAN_BACKEND_TOKEN", "").strip():
        raise RuntimeError(
            "MERIDIAN_BACKEND_TOKEN is required when MERIDIAN backend auth is enabled."
        )


def _provided_token(request: Request) -> str | None:
    auth_header = request.headers.get("authorization", "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return request.headers.get("x-meridian-backend-token", "").strip() or None


def require_backend_auth(request: Request) -> None:
    if not auth_required():
        return
    expected = os.environ.get("MERIDIAN_BACKEND_TOKEN", "").strip()
    provided = _provided_token(request)
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="MERIDIAN backend authentication required")


async def backend_auth_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    # Keep liveness checks available to the worker without exposing DB/query data.
    if request.method == "GET" and request.url.path == "/api/health":
        return await call_next(request)
    require_backend_auth(request)
    return await call_next(request)


def require_profile_store_enabled() -> None:
    if not profile_store_enabled():
        raise HTTPException(
            status_code=403,
            detail="Stored connection profiles are disabled for MERIDIAN governance-review runs.",
        )
