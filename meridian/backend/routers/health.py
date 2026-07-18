from __future__ import annotations

from fastapi import APIRouter, Request
from security import packaged_mode

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(request: Request):
    pool = getattr(request.app.state, "active_pool", None)
    db_status = "no active connection"
    if pool:
        try:
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute("SELECT 1")
            db_status = "connected"
        except Exception as e:
            db_status = f"error: {e}"
    return {
        "status": "ok",
        "database": db_status,
        "active_profile": getattr(request.app.state, "active_profile_name", None),
    }
