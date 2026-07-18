from __future__ import annotations

import asyncio
import os
import re
import socket
import subprocess
from dataclasses import dataclass, field
from typing import Any

from mysql.connector.aio import connect
from models.schemas import ConnectionProfile


@dataclass
class SshTunnel:
    process: asyncio.subprocess.Process
    local_port: int
    stderr_tail: list[str] = field(default_factory=list)
    _supervisor: asyncio.Task | None = field(default=None, init=False, repr=False)


def _get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _wait_for_port(port: int, timeout_s: float = 10.0) -> None:
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection("127.0.0.1", port), timeout=1.0
            )
            writer.close()
            await writer.wait_closed()
            return
        except (OSError, asyncio.TimeoutError):
            await asyncio.sleep(0.5)
    raise TimeoutError(f"SSH tunnel did not become ready on 127.0.0.1:{port}")


async def start_ssh_tunnel(
    ssh_host: str,
    remote_host: str,
    remote_port: int,
    ssh_port: int = 22,
    ssh_user: str | None = None,
    control_path: str | None = None,
) -> SshTunnel:
    local_port = _get_free_port()
    destination = f"{ssh_user}@{ssh_host}" if ssh_user else ssh_host
    args = [
        "ssh", "-N",
        "-L", f"127.0.0.1:{local_port}:{remote_host}:{remote_port}",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=10",
        "-o", "ServerAliveCountMax=1",
        "-o", "StrictHostKeyChecking=accept-new",
    ]
    if control_path:
        args += ["-o", "ControlMaster=auto", "-o", f"ControlPath={control_path}", "-o", "ControlPersist=5m"]
    if ssh_port != 22:
        args += ["-p", str(ssh_port)]
    args.append(destination)

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    tunnel = SshTunnel(process=proc, local_port=local_port)

    # Give the process 1 second to fail fast before checking port readiness
    try:
        await asyncio.wait_for(proc.wait(), timeout=1.0)
        stderr = (await proc.stderr.read()).decode(errors="replace").strip() if proc.stderr else ""
        if proc.returncode == 0:
            await _wait_for_port(local_port)
            return tunnel
        raise RuntimeError(f"SSH tunnel exited early (code={proc.returncode}): {stderr}")
    except asyncio.TimeoutError:
        pass  # still running — good

    await _wait_for_port(local_port)
    return tunnel


async def stop_ssh_tunnel(tunnel: SshTunnel) -> None:
    if tunnel._supervisor and not tunnel._supervisor.done():
        tunnel._supervisor.cancel()
    if tunnel.process.returncode is not None:
        return
    try:
        tunnel.process.terminate()
        await asyncio.wait_for(tunnel.process.wait(), timeout=3.0)
    except (asyncio.TimeoutError, ProcessLookupError):
        try:
            tunnel.process.kill()
        except ProcessLookupError:
            pass


def _make_supervisor(tunnel: SshTunnel, restart_fn) -> asyncio.Task:
    """Restart the SSH tunnel if the subprocess exits unexpectedly."""
    async def _supervise():
        while True:
            await tunnel.process.wait()
            if tunnel.process.returncode is None:
                return
            try:
                new_tunnel = await restart_fn()
                tunnel.process = new_tunnel.process
                tunnel.local_port = new_tunnel.local_port
            except Exception as e:
                print(f"[meridian-ssh-supervisor] failed to restart tunnel: {e}")
                return
    return asyncio.create_task(_supervise())

_READONLY_INIT_COMMAND = (
    "SET SESSION max_execution_time=10000, "
    "SESSION transaction_read_only=ON"
)


class MeridianConnectorCursor:
    def __init__(self, raw_connection: Any):
        self._raw_connection = raw_connection
        self._cursor: Any | None = None

    async def __aenter__(self) -> "MeridianConnectorCursor":
        self._cursor = await self._raw_connection.cursor()
        return self

    async def __aexit__(self, _exc_type, _exc, _tb) -> None:
        if self._cursor is not None:
            await self._cursor.close()
            self._cursor = None

    async def execute(self, sql: str, params: tuple | list | None = None) -> None:
        if self._cursor is None:
            raise RuntimeError("MERIDIAN cursor is not active")
        await self._cursor.execute(sql, params)

    async def fetchone(self):
        if self._cursor is None:
            raise RuntimeError("MERIDIAN cursor is not active")
        return await self._cursor.fetchone()

    async def fetchall(self):
        if self._cursor is None:
            raise RuntimeError("MERIDIAN cursor is not active")
        return await self._cursor.fetchall()


class MeridianConnectorConnection:
    def __init__(self, raw_connection: Any):
        self._raw_connection = raw_connection

    def cursor(self) -> MeridianConnectorCursor:
        return MeridianConnectorCursor(self._raw_connection)


class MeridianPoolAcquire:
    def __init__(self, pool: "MeridianConnectorPool"):
        self._pool = pool
        self._raw_connection: Any | None = None

    async def __aenter__(self) -> MeridianConnectorConnection:
        self._raw_connection = await self._pool._acquire()
        return MeridianConnectorConnection(self._raw_connection)

    async def __aexit__(self, _exc_type, _exc, _tb) -> None:
        if self._raw_connection is not None:
            await self._pool._release(self._raw_connection)
            self._raw_connection = None


class MeridianConnectorPool:
    def __init__(self, raw_connections: list[Any]):
        self._raw_connections = raw_connections
        self._available: asyncio.Queue[Any] = asyncio.Queue()
        self._closed = False
        for raw_connection in raw_connections:
            self._available.put_nowait(raw_connection)

    def acquire(self) -> MeridianPoolAcquire:
        return MeridianPoolAcquire(self)

    async def _acquire(self):
        if self._closed:
            raise RuntimeError("MERIDIAN DB pool is closed")
        raw_connection = await self._available.get()
        await _assert_readonly_session(raw_connection)
        return raw_connection

    async def _release(self, raw_connection: Any) -> None:
        if self._closed:
            await _close_raw_connection(raw_connection)
            return
        self._available.put_nowait(raw_connection)

    def close(self) -> None:
        self._closed = True

    async def wait_closed(self) -> None:
        while not self._available.empty():
            self._available.get_nowait()
        for raw_connection in self._raw_connections:
            await _close_raw_connection(raw_connection)
        self._raw_connections = []


async def create_pool(profile: ConnectionProfile) -> MeridianConnectorPool:
    config = _connection_config(profile)
    connections: list[Any] = []
    try:
        for _ in range(5):
            connections.append(await connect(**config))
        pool = MeridianConnectorPool(connections)
        await verify_readonly_grants(pool)
        return pool
    except Exception:
        for raw_connection in connections:
            await _close_raw_connection(raw_connection)
        raise


def _connection_config(profile: ConnectionProfile) -> dict[str, Any]:
    config: dict[str, Any] = {
        "host": profile.host,
        "port": profile.port,
        "user": profile.username,
        "password": profile.password,
        "database": profile.database,
        "autocommit": True,
        # Kill any query running longer than 10 seconds — protects PROD slave
        # from runaway calc_expressions or accidental full-table scans.
        # Force the DB session itself into read-only mode so write-capable
        # operator grants cannot accidentally execute DML through MERIDIAN.
        # SET SESSION is allowed for any user regardless of privilege level.
        "init_command": _READONLY_INIT_COMMAND,
        "connection_timeout": 10,
    }
    if profile.auth_plugin:
        config["auth_plugin"] = profile.auth_plugin
    if profile.krb_service_principal:
        config["krb_service_principal"] = profile.krb_service_principal
    if profile.ssl_ca:
        config["ssl_ca"] = profile.ssl_ca
        config["ssl_verify_cert"] = True
        config["ssl_verify_identity"] = profile.ssl_verify_identity
    return config


async def _close_raw_connection(raw_connection: Any) -> None:
    try:
        await raw_connection.close()
    except Exception:
        # Best-effort cleanup; preserve the original connection failure path.
        pass


async def _assert_readonly_session(raw_connection: Any) -> None:
    async with await raw_connection.cursor() as cur:
        await cur.execute("SELECT @@session.transaction_read_only")
        readonly_row = await cur.fetchone()
    session_readonly = str(readonly_row[0]) in {"1", "ON", "on", "True", "true"} if readonly_row else False
    if not session_readonly:
        raise PermissionError("MERIDIAN DB session is not read-only; transaction_read_only is OFF")


_MUTATING_OR_CONTROL_GRANTS = {
    "ALL PRIVILEGES",
    "ALTER",
    "CREATE",
    "CREATE ROUTINE",
    "CREATE TEMPORARY TABLES",
    "CREATE USER",
    "CREATE VIEW",
    "DELETE",
    "DROP",
    "EVENT",
    "EXECUTE",
    "FILE",
    "GRANT OPTION",
    "INDEX",
    "INSERT",
    "LOCK TABLES",
    "REFERENCES",
    "RELOAD",
    "REPLACE",
    "SHUTDOWN",
    "SUPER",
    "TRIGGER",
    "UPDATE",
}


def _grant_privileges(grant: str) -> set[str]:
    upper = grant.upper()
    privileges = set()
    if "WITH GRANT OPTION" in upper:
        privileges.add("GRANT OPTION")
    match = re.search(r"\bGRANT\s+(.+?)\s+ON\b", upper)
    if not match:
        return privileges
    privileges.update(
        privilege
        for privilege in (
            _normalize_grant_privilege(part)
            for part in _split_grant_privileges(match.group(1))
        )
        if privilege
    )
    if "ALL PRIVILEGES" in privileges or "ALL" in privileges:
        privileges.add("ALL PRIVILEGES")
    return privileges


def _split_grant_privileges(privilege_list: str) -> list[str]:
    privileges: list[str] = []
    current: list[str] = []
    paren_depth = 0

    for char in privilege_list:
        if char == "(":
            paren_depth += 1
            current.append(char)
            continue
        if char == ")":
            paren_depth = max(0, paren_depth - 1)
            current.append(char)
            continue
        if char == "," and paren_depth == 0:
            privileges.append("".join(current))
            current = []
            continue
        current.append(char)

    if "".join(current).strip():
        privileges.append("".join(current))
    return privileges


def _normalize_grant_privilege(privilege: str) -> str | None:
    normalized = re.sub(r"\s+", " ", privilege.strip())
    if not normalized:
        return None
    base_privilege = re.sub(r"\s*\([^)]*\)\s*$", "", normalized).strip()
    return base_privilege or None


async def verify_readonly_grants(pool: MeridianConnectorPool) -> dict:
    """Fail closed when the active DB user has mutation/control privileges.

    MERIDIAN only needs SELECT-style metadata/reference lookups. Activation
    verifies the DB account and session in every mode before generation can run.
    MySQL PROCESS is intentionally allowed because some approved read-only
    diagnostic accounts include it; transaction_read_only still blocks DML.
    """
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT CURRENT_USER()")
            current_user_row = await cur.fetchone()
            current_user = str(current_user_row[0]) if current_user_row else "unknown"
            await cur.execute("SELECT @@session.transaction_read_only")
            readonly_row = await cur.fetchone()
            session_readonly = str(readonly_row[0]) in {"1", "ON", "on", "True", "true"}
            await cur.execute("SHOW GRANTS FOR CURRENT_USER()")
            grant_rows = await cur.fetchall()

    if not session_readonly:
        raise PermissionError(
            f"MERIDIAN DB session for {current_user} is not read-only; transaction_read_only is OFF"
        )

    grants = [str(row[0]) for row in grant_rows]
    denied = sorted({
        privilege
        for grant in grants
        for privilege in _grant_privileges(grant)
        if privilege in _MUTATING_OR_CONTROL_GRANTS
    })
    if denied:
        raise PermissionError(
            f"MERIDIAN DB user {current_user} is not read-only; denied privilege(s): {', '.join(denied)}"
        )
    return {
        "current_user": current_user,
        "grant_count": len(grants),
        "readonly_verified": True,
        "session_readonly": True,
    }
