from __future__ import annotations

import asyncio

import pytest

from db import connection
from db.connection import verify_readonly_grants


class _FakeCursor:
    def __init__(self, grants: list[str], readonly: str = "1"):
        self._grants = grants
        self._readonly = readonly
        self._sql = ""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def execute(self, sql: str, _params=None) -> None:
        self._sql = sql

    async def fetchone(self):
        if "CURRENT_USER()" in self._sql:
            return ("DBData3@%",)
        if "@@session.transaction_read_only" in self._sql:
            return (self._readonly,)
        return None

    async def fetchall(self):
        if "SHOW GRANTS" in self._sql:
            return [(grant,) for grant in self._grants]
        return []


class _FakeConnection:
    def __init__(self, grants: list[str], readonly: str = "1"):
        self._grants = grants
        self._readonly = readonly

    def cursor(self):
        return _FakeCursor(self._grants, self._readonly)


class _FakeAcquire:
    def __init__(self, grants: list[str], readonly: str = "1"):
        self._grants = grants
        self._readonly = readonly

    async def __aenter__(self):
        return _FakeConnection(self._grants, self._readonly)

    async def __aexit__(self, *_args):
        return False


class _FakePool:
    def __init__(self, grants: list[str], readonly: str = "1"):
        self._grants = grants
        self._readonly = readonly

    def acquire(self):
        return _FakeAcquire(self._grants, self._readonly)


def test_verify_readonly_grants_allows_process_for_readonly_diagnostics() -> None:
    result = asyncio.run(
        verify_readonly_grants(
            _FakePool(["GRANT SELECT, PROCESS ON *.* TO `DBData3`@`%`"])
        )
    )

    assert result["readonly_verified"] is True
    assert result["current_user"] == "DBData3@%"


def test_verify_readonly_grants_rejects_mutating_privileges() -> None:
    with pytest.raises(PermissionError, match="denied privilege\\(s\\): UPDATE"):
        asyncio.run(
            verify_readonly_grants(
                _FakePool(["GRANT SELECT, UPDATE ON `medhok`.* TO `DBData3`@`%`"])
            )
        )


def test_verify_readonly_grants_rejects_non_readonly_session() -> None:
    with pytest.raises(PermissionError, match="transaction_read_only is OFF"):
        asyncio.run(
            verify_readonly_grants(
                _FakePool(["GRANT SELECT, PROCESS ON *.* TO `DBData3`@`%`"], readonly="0")
            )
        )


def test_start_ssh_tunnel_accepts_successful_mux_exit_after_port_ready(monkeypatch) -> None:
    wait_calls: list[int] = []

    class _FakeStderr:
        async def read(self):
            return b""

    class _FakeProcess:
        returncode = 0
        stderr = _FakeStderr()

        async def wait(self):
            return 0

    async def fake_create_subprocess_exec(*_args, **_kwargs):
        return _FakeProcess()

    async def fake_wait_for_port(port: int, _timeout_s: float = 10.0) -> None:
        wait_calls.append(port)

    monkeypatch.setattr(connection, "_get_free_port", lambda: 15432)
    monkeypatch.setattr(connection, "_wait_for_port", fake_wait_for_port)
    monkeypatch.setattr(connection.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    tunnel = asyncio.run(
        connection.start_ssh_tunnel(
            ssh_host="login.example.test",
            remote_host="medhokdb",
            remote_port=3306,
            ssh_user="operator",
            control_path="/tmp/cockpit.sock",
        )
    )

    assert tunnel.local_port == 15432
    assert wait_calls == [15432]
    assert tunnel.process.returncode == 0
