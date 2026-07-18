from __future__ import annotations

import os
from dataclasses import dataclass

import yaml


_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "config", "delete_actions.yaml")

_BLANK_SYNONYMS: frozenset[str] = frozenset({
    "blank", "blank remove the entire line", "remove", "delete", "null", "",
})


@dataclass
class DeleteAction:
    ui_name: str
    parent_module: str
    child_table: str
    child_fk_col: str
    child_match_col: str
    audit_fk: str
    trigger_values: frozenset[str]


class DeleteActionRegistry:
    """
    Loads delete_actions.yaml and answers two questions:
      1. Is this (module, field_name, new_value) a delete action?
      2. If so, what are the child table, FK, and match column?
    """

    def __init__(self) -> None:
        self._actions: list[DeleteAction] = []
        self._load()

    def _load(self) -> None:
        try:
            with open(os.path.normpath(_CONFIG_PATH), encoding="utf-8") as f:
                data = yaml.safe_load(f) or []
            for entry in data:
                triggers = frozenset(
                    str(v).lower().strip()
                    for v in (entry.get("trigger_values") or [])
                ) | _BLANK_SYNONYMS
                self._actions.append(DeleteAction(
                    ui_name=str(entry["ui_name"]).strip(),
                    parent_module=str(entry["parent_module"]).strip(),
                    child_table=str(entry["child_table"]).strip(),
                    child_fk_col=str(entry["child_fk_col"]).strip(),
                    child_match_col=str(entry["child_match_col"]).strip(),
                    audit_fk=str(entry["audit_fk"]).strip(),
                    trigger_values=triggers,
                ))
        except Exception as e:
            print(f"Warning: could not load delete_actions.yaml: {e}")

    def match(
        self, module: str, field_name: str, new_value: str | None
    ) -> DeleteAction | None:
        """
        Return the matching DeleteAction if (module, field_name, new_value) is
        a delete-action trigger, else None.
        """
        nv = (new_value or "").strip().lower()
        fn = field_name.strip().lower()
        for action in self._actions:
            if (
                action.parent_module == module
                and action.ui_name.lower() == fn
                and nv in action.trigger_values
            ):
                return action
        return None


# Module-level singleton — loaded once at startup
_registry: DeleteActionRegistry | None = None


def get_delete_action_registry() -> DeleteActionRegistry:
    global _registry
    if _registry is None:
        _registry = DeleteActionRegistry()
    return _registry
