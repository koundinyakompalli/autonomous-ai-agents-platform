from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MERIDIAN_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    backend_port: int = 8001
    profiles_dir: str = "~/.meridian"
    mappings_path: str = "mappings/CCIU_BECU_Mapping.xlsx"
    # Operator DB credentials — set in env, never passed over the wire from Cockpit.
    # Cockpit sends only routing info (host, port, database); Meridian supplies creds.
    db_username: str = ""
    db_password: str = ""


settings = Settings()
