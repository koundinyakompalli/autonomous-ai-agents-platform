from __future__ import annotations

from models.schemas import ChangeRow
from services.sql_generator import generate_blocks
import services.terminate_workflow_registry as registry


def _custom_config() -> registry.TerminateWorkflowConfig:
    return registry.TerminateWorkflowConfig(
        ops_path="/custom/KillPID",
        ops_user="customuser",
        ops_script="RunSingleWorkflow.sh",
        workflow_cleanup=registry.WorkflowCleanupConfig(
            process_flow=registry.ProcessFlowCleanupConfig(
                table="custom_process_flow",
                pid_col="workflow_pid",
                active_col="is_active",
                end_datetime_col="closed_at",
            ),
            task=registry.WorkflowTaskConfig(
                table="custom_task",
                execution_col="execution_id",
                name_col="task_name",
                state_col="task_state",
            ),
            history=registry.WorkflowHistoryConfig(
                table="custom_history",
                execution_col="hist_execution",
                activity_name_col="hist_activity",
                start_col="hist_start",
                end_col="hist_end",
                duration_col="hist_duration",
            ),
            bulk_stage=registry.BulkStageConfig(
                table="custom_stage.workflow_pid",
                pid_col="workflow_pid",
                truncate_before_insert=True,
                script="RunBulkWorkflow.sh",
            ),
        ),
        module_fk={"provider_appeals_mgmt": "provider_fk"},
    )


def _terminate_change(row_num: int, record_id: int, pid: str = "pid-1") -> ChangeRow:
    return ChangeRow(
        row_num=row_num,
        module="provider_appeals_mgmt",
        case_id=f"D{row_num}",
        record_id=record_id,
        field_name="Terminate Workflow",
        new_value="Y",
        column_name="#action:terminate_workflow",
        table_name="provider_appeals_mgmt",
        is_terminate_workflow=True,
        terminate_workflow_pid=pid,
    )


def test_bulk_terminate_workflow_sql_uses_configured_cleanup(monkeypatch):
    monkeypatch.setattr(registry, "_config", _custom_config())

    sql = generate_blocks([
        _terminate_change(1, 101, "pid-1"),
        _terminate_change(2, 102, "pid-2"),
    ])[0].sql

    assert "`custom_process_flow`" in sql
    assert "`custom_task`" in sql
    assert "`custom_history`" in sql
    assert "`custom_stage`.`workflow_pid`" in sql
    assert "`provider_fk`" in sql
    assert "`workflow_pid`" in sql
    assert "`is_active`" in sql
    assert "`closed_at`" in sql
    assert "./RunBulkWorkflow.sh" in sql
    assert "./RunAppQuery.sh" not in sql
    assert sql.index("UPDATE `custom_process_flow`") < sql.index("OPS INSTRUCTION")


def test_single_terminate_workflow_sql_uses_configured_cleanup(monkeypatch):
    monkeypatch.setattr(registry, "_config", _custom_config())

    sql = generate_blocks([_terminate_change(1, 101, "pid-1")])[0].sql

    assert "`custom_process_flow`" in sql
    assert "`custom_history`" in sql
    assert "`custom_stage`.`workflow_pid`" not in sql
    assert "./RunSingleWorkflow.sh pid-1" in sql
    assert "UPDATE `provider_appeals_mgmt` SET" not in sql
    assert sql.index("UPDATE `custom_process_flow`") < sql.index("OPS INSTRUCTION")
