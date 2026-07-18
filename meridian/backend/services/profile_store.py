from __future__ import annotations

import json
import os
from pathlib import Path

from cryptography.fernet import Fernet

from models.schemas import ConnectionProfile, ConnectionProfilePublic

PROFILES_DIR = Path(
    os.path.expanduser(
        os.environ.get(
            "MERIDIAN_PROFILES_DIR",
            os.environ.get("BECU_PROFILES_DIR", "~/.meridian"),
        )
    )
)
KEY_FILE = PROFILES_DIR / "key"
PROFILES_FILE = PROFILES_DIR / "profiles.json"


def _ensure_dir() -> None:
    PROFILES_DIR.mkdir(exist_ok=True)


def _get_key() -> bytes:
    _ensure_dir()
    if KEY_FILE.exists():
        return KEY_FILE.read_bytes()
    key = Fernet.generate_key()
    KEY_FILE.write_bytes(key)
    KEY_FILE.chmod(0o600)
    return key


def _fernet() -> Fernet:
    return Fernet(_get_key())


def load_profiles() -> list[ConnectionProfilePublic]:
    if not PROFILES_FILE.exists():
        return []
    try:
        encrypted = PROFILES_FILE.read_bytes()
        raw = _fernet().decrypt(encrypted)
        data = json.loads(raw)
        return [ConnectionProfilePublic(**p) for p in data]
    except Exception:
        return []


def _load_raw() -> list[dict]:
    if not PROFILES_FILE.exists():
        return []
    try:
        encrypted = PROFILES_FILE.read_bytes()
        raw = _fernet().decrypt(encrypted)
        return json.loads(raw)
    except Exception:
        return []


def _save_raw(profiles: list[dict]) -> None:
    _ensure_dir()
    raw = json.dumps(profiles).encode()
    encrypted = _fernet().encrypt(raw)
    PROFILES_FILE.write_bytes(encrypted)
    PROFILES_FILE.chmod(0o600)


def save_profile(profile: ConnectionProfile) -> None:
    profiles = _load_raw()
    # Replace if exists
    profiles = [p for p in profiles if p["name"] != profile.name]
    profiles.append(profile.model_dump())
    _save_raw(profiles)


def delete_profile(name: str) -> bool:
    profiles = _load_raw()
    new = [p for p in profiles if p["name"] != name]
    if len(new) == len(profiles):
        return False
    _save_raw(new)
    return True


def get_profile(name: str) -> ConnectionProfile | None:
    for p in _load_raw():
        if p["name"] == name:
            return ConnectionProfile(**p)
    return None
