from __future__ import annotations

import os
import re

from fastapi import APIRouter, HTTPException, Request

from db.connection import create_pool, start_ssh_tunnel, stop_ssh_tunnel
from models.schemas import ConnectionProfile, ConnectionProfilePublic, TicketConnectionRequest
from security import require_profile_store_enabled
from services.profile_store import (
    delete_profile,
    get_profile,
    load_profiles,
    save_profile,
)

router = APIRouter(prefix="/connections", tags=["connections"])



# Placeholders that represent the case/record ID — not parent field dependencies
_CASE_ID_PLACEHOLDERS = {
    'der no', 'grievance no', 'appeal no', 'case no', 'auth reference',
    'review number', 'auth number', 'exrm no', 'provider appeal no',
    'report tracking info id',
}

# Columns that are cross-record references (links to other cases), not scoping parents
_CROSS_RECORD_COLUMNS = {
    'rd_original_der_no', 'original_case_number', 'rd_original_cd_date',
}


async def _derive_cascading_parents(pool, mapper) -> None:
    """Derive parent_columns from DB calc_expression placeholders and set them
    directly on mapper entries — no file written, always fresh from the live DB."""
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute("""
                    SELECT c.table_name, f.name, f.column_name, f.calc_expression
                    FROM data_loader_config_fields f
                    JOIN data_loader_config c ON c.id = f.data_loader_config_id
                    WHERE f.calc_expression IS NOT NULL
                """)
                rows = await cur.fetchall()
    except Exception as e:
        print(f"Warning: could not derive cascading parents: {e}")
        return

    applied = 0
    for table, ui_name, col_name, calc in rows:
        placeholders = [p.strip().lower() for p in re.findall(r'#([^#]+)#', calc)]
        parents = []
        seen = set()
        for p in placeholders:
            if p == ui_name.lower() or p in _CASE_ID_PLACEHOLDERS or p in seen or p == col_name.lower():
                continue
            seen.add(p)
            m = mapper.find_for_module(table, p)
            if m:
                parents.append(m.column_name.lower())
            else:
                col_match = next(
                    (mp.column_name.lower() for (t, u), mp in mapper._map.items()
                     if t == table and mp.column_name.lower() == p),
                    None
                )
                if col_match and col_match not in _CROSS_RECORD_COLUMNS:
                    parents.append(col_match)
        if not parents:
            continue
        self_m = next((mp for (t, u), mp in mapper._map.items()
                       if t == table and mp.column_name.lower() == col_name.lower()), None)
        if self_m and self_m.ref_table:
            parents = [p for p in parents if not any(
                mp.column_name.lower() == p and mp.ref_table == self_m.ref_table
                for (t, u), mp in mapper._map.items() if t == table
            )]
        if parents and self_m:
            self_m.parent_columns = parents
            applied += 1
    print(f"Derived {applied} cascading parent rules from DB")


@router.get("", response_model=list[ConnectionProfilePublic])
async def list_connections(request: Request):
    require_profile_store_enabled()
    profiles = load_profiles()
    active = getattr(request.app.state, "active_profile_name", None)
    for p in profiles:
        p.active = (p.name == active)
    return profiles


@router.post("", response_model=ConnectionProfilePublic)
async def save_connection(profile: ConnectionProfile):
    require_profile_store_enabled()
    save_profile(profile)
    return ConnectionProfilePublic(
        name=profile.name,
        host=profile.host,
        port=profile.port,
        username=profile.username,
        database=profile.database,
    )


@router.delete("/{name}")
async def remove_connection(name: str, request: Request):
    require_profile_store_enabled()
    if not delete_profile(name):
        raise HTTPException(status_code=404, detail=f"Profile '{name}' not found")
    if getattr(request.app.state, "active_profile_name", None) == name:
        pool = getattr(request.app.state, "active_pool", None)
        if pool:
            pool.close()
        tunnel = getattr(request.app.state, "active_ssh_tunnel", None)
        if tunnel:
            await stop_ssh_tunnel(tunnel)
        request.app.state.active_pool = None
        request.app.state.active_profile_name = None
        request.app.state.active_ssh_tunnel = None
    return {"message": f"Profile '{name}' deleted"}


@router.post("/{name}/test")
async def test_connection(name: str):
    require_profile_store_enabled()
    profile = get_profile(name)
    if not profile:
        raise HTTPException(status_code=404, detail=f"Profile '{name}' not found")
    try:
        pool = await create_pool(profile)
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT 1")
        pool.close()
        return {"status": "ok", "message": f"Connected to {profile.database} on {profile.host}:{profile.port}"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{name}/activate")
async def activate_connection(name: str, request: Request):
    require_profile_store_enabled()
    profile = get_profile(name)
    if not profile:
        raise HTTPException(status_code=404, detail=f"Profile '{name}' not found")
    # Close existing pool
    old_pool = getattr(request.app.state, "active_pool", None)
    if old_pool:
        try:
            old_pool.close()
        except Exception:
            pass
    try:
        pool = await create_pool(profile)
        request.app.state.active_pool = pool
        request.app.state.active_profile_name = name
        # Refresh field mappings from the live DB on every activation.
        # data_loader_config_fields is the single source of truth — calc_expressions
        # and cascading parent rules are derived live so any DB updates are
        # picked up immediately without any file intermediary.
        mapper = getattr(request.app.state, "field_mapper", None)
        db_count = 0
        mc_count = 0
        if mapper:
            db_count = await mapper.load_from_db(pool)
            await _derive_cascading_parents(pool, mapper)
            mc_count = await mapper.load_from_message_constant(pool)
            if mc_count:
                print(f"Loaded {mc_count} mappings from message_constant (Tier 3)")
        return {
            "status": "ok",
            "message": f"Activated '{name}'",
            "db_mappings_loaded": db_count,
            "message_constant_mappings": mc_count,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/activate-from-ticket")
async def activate_from_ticket(body: TicketConnectionRequest, request: Request):
    """Called by Cockpit with routing info only (client, env, host, port, db).
    Credentials come from MERIDIAN_DB_USERNAME / MERIDIAN_DB_PASSWORD in Meridian's own env.
    When ssh_host is provided, Meridian opens its own SSH tunnel — no pre-existing tunnel needed."""
    from config import settings
    username = settings.db_username
    password = settings.db_password
    if not username or not password:
        raise HTTPException(
            status_code=503,
            detail="MERIDIAN_DB_USERNAME and MERIDIAN_DB_PASSWORD must be set in Meridian env before ticket-driven activation.",
        )

    # Close any existing pool and SSH tunnel
    old_pool = getattr(request.app.state, "active_pool", None)
    old_tunnel = getattr(request.app.state, "active_ssh_tunnel", None)
    if old_pool:
        try:
            old_pool.close()
        except Exception:
            pass
    if old_tunnel:
        try:
            await stop_ssh_tunnel(old_tunnel)
        except Exception:
            pass
    request.app.state.active_pool = None
    request.app.state.active_ssh_tunnel = None

    # Open SSH tunnel when ssh_host is provided; otherwise connect directly
    ssh_tunnel = None
    connect_host = body.host
    connect_port = body.port
    try:
        if body.ssh_host:
            ssh_user = body.ssh_user or os.environ.get("MERIDIAN_SSH_USER") or os.environ.get("INVESTIGATION_SSH_USER")
            control_path = os.environ.get("INVESTIGATION_SSH_CONTROL_PATH") or os.environ.get("MERIDIAN_SSH_CONTROL_PATH")
            ssh_tunnel = await start_ssh_tunnel(
                ssh_host=body.ssh_host,
                remote_host=body.host,
                remote_port=body.port,
                ssh_port=body.ssh_port,
                ssh_user=ssh_user,
                control_path=control_path,
            )
            connect_host = "127.0.0.1"
            connect_port = ssh_tunnel.local_port
            print(f"[meridian] SSH tunnel {body.ssh_host} → {body.host}:{body.port} on local port {ssh_tunnel.local_port}")

        profile = ConnectionProfile(
            name=f"ticket-{body.client}-{body.environment}".lower(),
            host=connect_host,
            port=connect_port,
            username=username,
            password=password,
            database=body.database,
        )

        pool = await create_pool(profile)
        request.app.state.active_pool = pool
        request.app.state.active_profile_name = profile.name
        request.app.state.active_ssh_tunnel = ssh_tunnel

        mapper = getattr(request.app.state, "field_mapper", None)
        db_count = 0
        mc_count = 0
        if mapper:
            db_count = await mapper.load_from_db(pool)
            await _derive_cascading_parents(pool, mapper)
            mc_count = await mapper.load_from_message_constant(pool)
            if mc_count:
                print(f"Loaded {mc_count} mappings from message_constant (Tier 3)")

        via = f" via SSH {body.ssh_host}" if body.ssh_host else ""
        return {
            "status": "ok",
            "message": f"Connected to {body.host}:{body.port}/{body.database}{via} for {body.client}/{body.environment}",
            "db_mappings_loaded": db_count,
            "message_constant_mappings": mc_count,
            "active_profile": profile.name,
        }
    except Exception as e:
        # Clean up tunnel if pool creation failed
        if ssh_tunnel:
            try:
                await stop_ssh_tunnel(ssh_tunnel)
            except Exception:
                pass
        raise HTTPException(status_code=400, detail=str(e))
