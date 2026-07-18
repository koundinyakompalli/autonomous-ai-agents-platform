from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, os.path.dirname(__file__))

from config import settings
from routers.connections import router as connections_router
from routers.generate import router as generate_router
from routers.health import router as health_router
from routers.lookup import router as lookup_router
from services.field_mapper import FieldMapper
from security import backend_auth_middleware, validate_startup_security
from db.connection import stop_ssh_tunnel


@asynccontextmanager
async def lifespan(app: FastAPI):
    validate_startup_security()
    # Load field mapper at startup
    mapper = FieldMapper()
    mappings_dir = os.path.join(os.path.dirname(__file__), os.path.dirname(settings.mappings_path))
    try:
        mapper.load_dir(mappings_dir)
        print(f"Field mapper loaded: {len(mapper._map)} mappings from {mappings_dir}")
    except Exception as e:
        print(f"Warning: Could not load field mappings: {e}")
    app.state.field_mapper = mapper
    app.state.mappings_dir = mappings_dir
    app.state.active_pool = None
    app.state.active_profile_name = None

    yield

    pool = getattr(app.state, "active_pool", None)
    if pool:
        pool.close()
        await pool.wait_closed()
    tunnel = getattr(app.state, "active_ssh_tunnel", None)
    if tunnel:
        await stop_ssh_tunnel(tunnel)


app = FastAPI(
    title="MERIDIAN",
    description="Managed Evaluation & Resolution Intelligence for Data Investigation, Analysis and Normalization",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.middleware("http")(backend_auth_middleware)

app.include_router(health_router, prefix="/api")
app.include_router(connections_router, prefix="/api")
app.include_router(lookup_router, prefix="/api")
app.include_router(generate_router, prefix="/api")

# Serve React frontend in production (when frontend/dist exists)
dist_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.exists(dist_path):
    app.mount("/", StaticFiles(directory=dist_path, html=True), name="static")
