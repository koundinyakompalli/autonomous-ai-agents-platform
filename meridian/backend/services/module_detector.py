from __future__ import annotations

import os
import re

import yaml


def _load_modules_yaml() -> tuple[dict[str, dict], dict[str, str]]:
    config_path = os.path.join(os.path.dirname(__file__), "..", "config", "modules.yaml")
    with open(os.path.normpath(config_path), encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    aliases = data.pop("_aliases", {})
    modules = {}
    for key, cfg in data.items():
        if isinstance(cfg, dict) and "table" in cfg:
            # Convert YAML null to Python None for downstream SQL-generation checks.
            for field in ("id_col", "audit_fk", "audit_fk_join", "revision_col"):
                if cfg.get(field) in (None, "null", "None"):
                    cfg[field] = None
            modules[key] = cfg
    return modules, aliases


MODULE_CONFIG, _ALIASES = _load_modules_yaml()


def detect_module(name: str) -> str | None:
    """Resolve a free-form module name to a MODULE_CONFIG key."""
    n = name.lower().strip()
    if n in MODULE_CONFIG:
        return n
    if n in _ALIASES:
        return _ALIASES[n]
    for alias in sorted(_ALIASES, key=len, reverse=True):
        if re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", n):
            return _ALIASES[alias]
    return None


def candidate_modules_for_case_id(case_id: str) -> list[str]:
    """Return configured module candidates for a case identifier.

    Multiple modules may intentionally match the same case pattern. For example,
    H-prefixed identifiers can be authorizations.auth_number or
    auth_review.review_number; downstream code must use field/context signals
    or DB lookup to disambiguate.
    """
    normalized = str(case_id or "").strip().upper()
    if not normalized:
        return []

    candidates: list[str] = []
    for module, cfg in MODULE_CONFIG.items():
        for pattern in cfg.get("case_id_patterns") or []:
            if re.match(str(pattern), normalized, re.IGNORECASE):
                candidates.append(module)
                break
    return candidates


def detect_module_from_case_id(case_id: str) -> str | None:
    """Return a module only when the configured case pattern is unambiguous."""
    candidates = candidate_modules_for_case_id(case_id)
    return candidates[0] if len(candidates) == 1 else None


def get_config(module: str) -> dict | None:
    """Resolve a free-form module name to a MODULE_CONFIG config dict."""
    n = name_to_key(module)
    return MODULE_CONFIG.get(n)


def name_to_key(module: str) -> str:
    """Normalize module name to config key."""
    n = module.lower().strip()
    if n in MODULE_CONFIG:
        return n
    return detect_module(module) or n


def list_modules() -> list[dict]:
    return [{"key": k, "display": v["display"]} for k, v in MODULE_CONFIG.items()]


# Backward-compatible alias
all_modules = list_modules
