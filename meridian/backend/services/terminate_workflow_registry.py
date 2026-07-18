from __future__ import annotations

import os
from dataclasses import dataclass

import yaml

_CONFIG_PATH = os.path.join(
    os.path.dirname(__file__), "..", "config", "terminate_workflow_modules.yaml"
)

# Field name variants that mean "terminate this case's workflow"
_TERMINATE_FIELD_NAMES: frozenset[str] = frozenset({
    "terminate workflow",
    "terminate_workflow",
    "#action:terminate_workflow",
})

# New value variants that confirm the action (Y / yes / true / checked)
_TERMINATE_TRIGGER_VALUES: frozenset[str] = frozenset({
    "y", "yes", "true", "1", "checked", "x",
})


@dataclass
class ProcessFlowCleanupConfig:
    table: str
    pid_col: str
    active_col: str
    end_datetime_col: str


@dataclass
class WorkflowTaskConfig:
    table: str
    execution_col: str
    name_col: str
    state_col: str


@dataclass
class WorkflowHistoryConfig:
    table: str
    execution_col: str
    activity_name_col: str
    start_col: str
    end_col: str
    duration_col: str


@dataclass
class BulkStageConfig:
    table: str
    pid_col: str
    truncate_before_insert: bool
    script: str


@dataclass
class WorkflowCleanupConfig:
    process_flow: ProcessFlowCleanupConfig
    task: WorkflowTaskConfig
    history: WorkflowHistoryConfig
    bulk_stage: BulkStageConfig


@dataclass
class TerminateWorkflowConfig:
    ops_path: str
    ops_user: str
    ops_script: str
    workflow_cleanup: WorkflowCleanupConfig
    module_fk: dict[str, str]   # module → process_flow FK column


_config: TerminateWorkflowConfig | None = None


def _load_workflow_cleanup(data: dict) -> WorkflowCleanupConfig:
    cleanup = data.get("workflow_cleanup") or {}
    process_flow = cleanup.get("process_flow") or {}
    task = cleanup.get("task") or {}
    history = cleanup.get("history") or {}
    bulk_stage = cleanup.get("bulk_stage") or {}

    return WorkflowCleanupConfig(
        process_flow=ProcessFlowCleanupConfig(
            table=process_flow.get("table", "process_flow"),
            pid_col=process_flow.get("pid_col", "pid"),
            active_col=process_flow.get("active_col", "active"),
            end_datetime_col=process_flow.get("end_datetime_col", "end_datetime"),
        ),
        task=WorkflowTaskConfig(
            table=task.get("table", "jbpm4_task"),
            execution_col=task.get("execution_col", "EXECUTION_ID_"),
            name_col=task.get("name_col", "NAME_"),
            state_col=task.get("state_col", "STATE_"),
        ),
        history=WorkflowHistoryConfig(
            table=history.get("table", "jbpm4_hist_actinst"),
            execution_col=history.get("execution_col", "EXECUTION_"),
            activity_name_col=history.get("activity_name_col", "ACTIVITY_NAME_"),
            start_col=history.get("start_col", "START_"),
            end_col=history.get("end_col", "END_"),
            duration_col=history.get("duration_col", "DURATION_"),
        ),
        bulk_stage=BulkStageConfig(
            table=bulk_stage.get("table", "stage.pid"),
            pid_col=bulk_stage.get("pid_col", "pid"),
            truncate_before_insert=bool(bulk_stage.get("truncate_before_insert", True)),
            script=bulk_stage.get("script", "RunAppQuery.sh"),
        ),
    )


def get_terminate_workflow_config() -> TerminateWorkflowConfig:
    global _config
    if _config is None:
        try:
            with open(os.path.normpath(_CONFIG_PATH), encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            _config = TerminateWorkflowConfig(
                ops_path=data.get("ops_path", "/opt/software/medhok/KillPID"),
                ops_user=data.get("ops_user", "appuser"),
                ops_script=data.get("ops_script", "RunAppPID.sh"),
                workflow_cleanup=_load_workflow_cleanup(data),
                module_fk=data.get("module_fk", {}),
            )
        except Exception as e:
            print(f"Warning: could not load terminate_workflow_modules.yaml: {e}")
            fallback: dict = {}
            _config = TerminateWorkflowConfig(
                ops_path="/opt/software/medhok/KillPID",
                ops_user="appuser",
                ops_script="RunAppPID.sh",
                workflow_cleanup=_load_workflow_cleanup(fallback),
                module_fk={},
            )
    return _config


def is_terminate_workflow(field_name: str, new_value: str | None) -> bool:
    """Return True when this field+value combination means terminate workflow."""
    fn = (field_name or "").strip().lower()
    nv = (new_value or "").strip().lower()
    return fn in _TERMINATE_FIELD_NAMES and nv in _TERMINATE_TRIGGER_VALUES
