from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ConnectionProfile(BaseModel):
    name: str
    host: str = "localhost"
    port: int = 8013
    username: str
    password: str
    database: str
    credential_mode: Literal["stored", "operator_runtime"] = "stored"
    auth_plugin: str | None = None
    krb_service_principal: str | None = None
    ssl_ca: str | None = None
    ssl_verify_identity: bool = True


class ConnectionProfilePublic(BaseModel):
    """Profile without password for API responses."""
    name: str
    host: str
    port: int
    username: str
    database: str
    active: bool = False


class ActivateRequest(BaseModel):
    name: str


class LookupRequest(BaseModel):
    module: str                        # e.g. "der", "auth_review", "grievance_mgmt"
    case_id: str                       # e.g. "26063562493", "H26034774917"
    revision: int | None = None        # for auth_review


class FieldValue(BaseModel):
    field_name: str                    # UI field name
    column_name: str | None = None     # DB column (resolved from mapping)
    current_value: str | None = None   # current DB value
    current_display: str | None = None # human-readable (for FK lookups)


class LookupResponse(BaseModel):
    module: str
    case_id: str
    record_id: int | None = None
    table_name: str
    fields: list[FieldValue] = []
    found: bool = False
    error: str | None = None


class ChangeRow(BaseModel):
    row_num: int = 0
    module: str
    case_id: str
    revision: int | None = None
    field_name: str
    old_value: str | None = None
    new_value: str | None = None
    new_value_display: str | None = None   # original display value before ID resolution
    reason: str | None = None
    # Resolved after lookup
    record_id: int | None = None
    table_name: str | None = None
    column_name: str | None = None
    current_db_value: str | None = None
    already_done: bool = False
    already_done_reason: str | None = None
    error: str | None = None
    # Non-executable DBA discovery SQL for unsupported high-risk actions.
    manual_review_sql: str | None = None
    has_update_datetime: bool = True  # False for tables like der_child that lack the column
    is_phi: bool = False              # True when column_name is in PHI_COLUMNS — old value fetched via subquery at DB execution time
    is_terminate_workflow: bool = False  # True when field = Terminate Workflow + Y — emits workflow termination SQL
    terminate_workflow_pid: str | None = None  # resolved process_flow.pid value
    is_delete_action: bool = False    # True when field matches a delete_actions.yaml entry — emits DELETE not UPDATE
    delete_child_table: str | None = None   # child table to delete from
    delete_child_fk_col: str | None = None  # FK col linking child to parent
    delete_child_match_col: str | None = None  # col whose value = old_value in spreadsheet
    delete_child_row_id: int | None = None  # resolved PK of the child row to delete
    delete_audit_fk: str | None = None
    debug_entries: list[str] = []   # timing + query trace entries collected during _auto_resolve
    ref_table: str | None = None        # reference table for FK columns (used in bulk audit CONCAT)
    ref_id_col: str | None = None
    ref_desc_col: str | None = None
    audit_label: str | None = None      # override display name in audit log (e.g. "Case Notes" instead of "Dispute Request Reason")
    parent_record_id: int | None = None  # parent table PK when record_id is a child table PK (e.g. der.id when updating der_child)
    semantic_context: dict[str, str] | None = None


class GenerateRequest(BaseModel):
    changes: list[ChangeRow]
    debug: bool = False             # when True, append MERIDIAN Resolution Log to end of SQL output
    source_file: str | None = None  # original spreadsheet filename, included in SQL header


class SqlBlock(BaseModel):
    row_num: int
    module: str
    case_id: str
    field_name: str
    already_done: bool = False
    already_done_reason: str | None = None
    sql: str = ""


class GenerateResponse(BaseModel):
    blocks: list[SqlBlock]
    total: int
    updates: int
    skipped: int
    errors: int


class SpreadsheetRow(BaseModel):
    row_num: int
    module: str | None = None
    case_id: str
    field_name: str
    old_value: str | None = None
    new_value: str | None = None
    reason: str | None = None
    revision: int | None = None
    assessment_name: str | None = None
    created_at: str | None = None
    semantic_context: dict[str, str] | None = None


class TicketConnectionRequest(BaseModel):
    """Routing info sent by Cockpit — no credentials. Meridian supplies those from its own env.
    When ssh_host is provided Meridian opens its own SSH tunnel; no pre-existing tunnel needed."""
    client: str
    environment: str
    host: str
    port: int = 3306
    database: str = "medhok"
    ssh_host: str | None = None
    ssh_port: int = 22
    ssh_user: str | None = None
