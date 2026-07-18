from __future__ import annotations

from collections import defaultdict

from models.schemas import ChangeRow, SqlBlock
from services.module_detector import get_config


def _escape(val: str) -> str:
    return val.replace("'", "''") if val else ""


def _sql_literal(val: str) -> str:
    """Return val as a SQL literal — unquoted for integers, quoted+escaped for strings."""
    if val is None:
        return "NULL"
    if val.lstrip("-").isdigit():
        return val
    return f"'{_escape(val)}'"


def _display_val(change: ChangeRow) -> str:
    """Return human-readable new value for audit log (display, not ID)."""
    return change.new_value_display or change.new_value or "NULL"


def _format_id_list(ids: list[int], per_line: int = 10) -> str:
    chunks = [ids[i:i + per_line] for i in range(0, len(ids), per_line)]
    return ",\n    ".join(", ".join(str(i) for i in chunk) for chunk in chunks)


def _quote_identifier(identifier: str) -> str:
    return "`" + str(identifier).replace("`", "``") + "`"


def _quote_table(table_name: str) -> str:
    return ".".join(_quote_identifier(part) for part in str(table_name).split("."))


def _append_single_terminate_workflow(
    lines: list[str],
    *,
    pid: str,
    module_upper: str,
    tw_cfg,
) -> None:
    cleanup = tw_cfg.workflow_cleanup
    pf = cleanup.process_flow
    history = cleanup.history

    pf_table = _quote_table(pf.table)
    pf_pid = _quote_identifier(pf.pid_col)
    pf_active = _quote_identifier(pf.active_col)
    pf_end = _quote_identifier(pf.end_datetime_col)
    hist_table = _quote_table(history.table)
    hist_execution = _quote_identifier(history.execution_col)
    hist_activity = _quote_identifier(history.activity_name_col)
    hist_start = _quote_identifier(history.start_col)
    hist_end = _quote_identifier(history.end_col)
    hist_duration = _quote_identifier(history.duration_col)

    pid_escaped = _escape(pid or "UNKNOWN")

    lines.append("/* Backup active workflow row before cleanup */")
    lines.append(f"SELECT pf.{pf_pid}, pf.{pf_active}, pf.{pf_end}")
    lines.append(f"FROM {pf_table} pf")
    lines.append(f"WHERE pf.{pf_pid} = '{pid_escaped}' AND pf.{pf_active} = 1;\n")

    lines.append("/* Backup open JBPM history rows before cleanup */")
    lines.append(f"SELECT hai.{hist_execution}, hai.{hist_activity}, hai.{hist_start}, hai.{hist_end}, hai.{hist_duration}")
    lines.append(f"FROM {hist_table} hai")
    lines.append(f"WHERE hai.{hist_execution} = '{pid_escaped}' AND hai.{hist_end} IS NULL;\n")

    lines.append("/* STEP 1: DBA marks active process_flow row ended */")
    lines.append(f"UPDATE {pf_table} pf")
    lines.append(f"SET pf.{pf_active} = 0,")
    lines.append(f"    pf.{pf_end} = CURRENT_TIMESTAMP")
    lines.append(f"WHERE pf.{pf_pid} = '{pid_escaped}' AND pf.{pf_active} = 1;\n")

    lines.append("/* STEP 2: DBA ends open JBPM history rows */")
    lines.append(f"UPDATE {hist_table} hai")
    lines.append(f"JOIN {pf_table} pf ON pf.{pf_pid} = hai.{hist_execution}")
    lines.append(f"SET hai.{hist_end} = COALESCE(pf.{pf_end}, CURRENT_TIMESTAMP),")
    lines.append(f"    hai.{hist_duration} = TIMESTAMPDIFF(SECOND, hai.{hist_start}, COALESCE(pf.{pf_end}, CURRENT_TIMESTAMP)) * 1000")
    lines.append(f"WHERE hai.{hist_execution} = '{pid_escaped}' AND hai.{hist_end} IS NULL;\n")

    lines.append("/* Validate process_flow cleanup */")
    lines.append(f"SELECT pf.{pf_pid}, pf.{pf_active}, pf.{pf_end}")
    lines.append(f"FROM {pf_table} pf")
    lines.append(f"WHERE pf.{pf_pid} = '{pid_escaped}';\n")

    lines.append("/* Validate JBPM history cleanup */")
    lines.append(f"SELECT hai.{hist_execution}, hai.{hist_activity}, hai.{hist_start}, hai.{hist_end}, hai.{hist_duration}")
    lines.append(f"FROM {hist_table} hai")
    lines.append(f"WHERE hai.{hist_execution} = '{pid_escaped}';\n")

    lines.append(
        f"/* OPS INSTRUCTION — run after DBA cleanup/validation\n"
        f"   Action : Terminate workflow for 1 {module_upper} case\n"
        f"   PID    : {pid_escaped}\n"
        f"   Run:\n"
        f"        su - {tw_cfg.ops_user}\n"
        f"        cd {tw_cfg.ops_path}\n"
        f"        ./{tw_cfg.ops_script} {pid_escaped}\n"
        f"*/"
    )
    lines.append("")


def generate_blocks_for_case(changes: list[ChangeRow]) -> SqlBlock:
    """
    Generate one consolidated Backup/Update/Audit/Validate block
    for all field changes on the same case.
    """
    if not changes:
        return SqlBlock(row_num=0, module="", case_id="", field_name="", sql="")

    # Use first change for case metadata
    first = changes[0]
    cfg = get_config(first.module)
    table = first.table_name or (cfg["table"] if cfg else "unknown")
    pk = cfg["pk"] if cfg else "id"
    update_dt = cfg.get("update_datetime_col", "update_datetime") if cfg else "update_datetime"
    has_update_dt = all(getattr(c, "has_update_datetime", True) for c in changes)
    audit_fk = cfg.get("audit_fk") if cfg else None
    record_id = first.record_id
    # For child table fields (e.g. der_child), audit_log needs the parent PK (der.id),
    # not the child PK. parent_record_id is set in generate.py when record_id is overwritten.
    audit_record_id = first.parent_record_id or first.record_id
    case_id = first.case_id
    rev_info = f", Rev: {first.revision}" if first.revision is not None else ""
    module_upper = first.module.upper()

    # Split into: delete actions, terminate workflow, actual updates, errors/already-done
    deletes = [c for c in changes if not c.already_done and not c.error and c.is_delete_action]
    terminates = [c for c in changes if not c.already_done and not c.error and c.is_terminate_workflow]
    updates = [c for c in changes if not c.already_done and not c.error and c.column_name and c.record_id
               and not c.is_delete_action and not c.is_terminate_workflow
               and not (c.column_name or "").startswith("#")]
    _update_cols = {c.column_name for c in updates}
    # Don't report a field as already-done if a synthesized change covers the same column
    # (e.g. RequestReason marked done but cdtype_id updated via _apply_context_deps cascade)
    already_done = [c for c in changes if c.already_done and c.column_name not in _update_cols]
    errors = [c for c in changes if c.error and not c.already_done]

    def _trunc(s: str, n: int = 80) -> str:
        s = str(s).replace("\n", " ").replace("\r", "").strip()
        return s if len(s) <= n else s[:n] + "..."

    # Build header as a single /* */ block comment — avoids MySQL printing
    # "Query OK, 0 rows affected" for every -- line in the output.
    header_parts = [
        f"{module_upper} {case_id}{rev_info} | {table}.id={record_id}"
        + f" | {len(updates)} field(s) to update"
        + (f", {len(deletes)} row(s) to delete" if deletes else "")
        + (f", {len(terminates)} workflow termination(s)" if terminates else "")
    ]
    all_actions = updates + deletes + terminates
    for c in all_actions:
        if c.is_delete_action:
            header_parts.append(
                f"  {c.field_name}: DELETE {c.delete_child_table}.id={c.delete_child_row_id}"
                f" (old={_trunc(c.old_value or 'NULL', 40)})"
            )
        elif c.is_terminate_workflow:
            header_parts.append(f"  Terminate Workflow: pid={c.terminate_workflow_pid}")
        else:
            col = c.column_name or "?"
            new_id = _trunc(c.new_value or "NULL", 80)
            new_disp = _trunc(c.new_value_display or c.new_value or "NULL", 60)
            old_disp = _trunc(c.current_db_value or c.old_value or "NULL", 40)
            header_parts.append(f"  {c.field_name}: {col}={new_id} ({new_disp}) | old: {old_disp}")
    if already_done:
        header_parts.append("ALREADY DONE: " + ", ".join(c.field_name for c in already_done))
    if errors:
        for e in errors:
            header_parts.append(f"SKIPPED: {e.field_name} — {e.error}")
    # Surface column length warnings from debug_entries
    for c in updates:
        for entry in (c.debug_entries or []):
            if "COLUMN LENGTH WARNING" in entry:
                header_parts.append(f"WARNING: {c.field_name} — value truncated to fit column length")

    lines = []
    lines.append("/* " + " | ".join(header_parts[:1]))
    for part in header_parts[1:]:
        lines.append(f"   {part}")
    lines.append("*/\n")

    if not updates and not deletes and not terminates:
        # Nothing to do for this case
        return SqlBlock(
            row_num=first.row_num,
            module=first.module,
            case_id=case_id,
            field_name="(all skipped)",
            already_done=len(already_done) == len(changes),
            already_done_reason="All fields already at target values" if len(already_done) == len(changes) else None,
            sql="\n".join(lines),
        )

    # ── DELETE blocks (child row deletions) ──────────────────────────────────
    for d in deletes:
        child_id = d.delete_child_row_id
        child_table = d.delete_child_table
        audit_fk = d.delete_audit_fk or audit_fk
        audit_content = _escape(
            f"<b>{d.field_name}</b> "
            f"<b>Old Value : </b>{d.old_value or 'NULL'} "
            f"<b>New Value : </b>NULL (row removed)"
        )
        lines.append(f"/* Backup: {d.field_name} old={d.old_value} */")
        lines.append(f"SELECT * FROM `{child_table}` WHERE `id` = {child_id};\n")
        lines.append(f"/* Delete: {d.field_name} from `{child_table}` (Expected: 1 row affected) */")
        lines.append(f"DELETE FROM `{child_table}` WHERE `id` = {child_id};\n")
        if audit_fk:
            lines.append(f"/* Audit Log (Expected: 1 row affected) */")
            lines.append(f"INSERT INTO `audit_log` (`{audit_fk}`, `content`, `audit_datetime`, `users_id`)")
            lines.append(f"SELECT {audit_record_id}, '{audit_content}', NOW(), (SELECT `id` FROM `users` WHERE `user_id` = 'system');\n")
        lines.append(f"/* Validate: Expected 0 rows */")
        lines.append(f"SELECT `id` FROM `{child_table}` WHERE `id` = {child_id};\n")

    if not updates:
        if terminates:
            try:
                from services.terminate_workflow_registry import get_terminate_workflow_config
                tw_cfg = get_terminate_workflow_config()
                for t in terminates:
                    _append_single_terminate_workflow(
                        lines,
                        pid=t.terminate_workflow_pid or "UNKNOWN",
                        module_upper=module_upper,
                        tw_cfg=tw_cfg,
                    )
            except Exception:
                pass
        return SqlBlock(
            row_num=first.row_num,
            module=first.module,
            case_id=case_id,
            field_name=f"{len(deletes)} row(s) deleted" if deletes else f"{len(terminates)} workflow termination(s)",
            sql="\n".join(lines),
        )

    # BACKUP — select all columns being changed
    col_list = ", ".join(f"`{c.column_name}`" for c in updates)
    backup_cols = f"`{pk}`, {col_list}" + (f", `{update_dt}`" if has_update_dt else "")
    _PHI_TOKEN = "__PHI_SUBQUERY__:"

    def _old_val(c):
        v = c.current_db_value
        if v and str(v).startswith(_PHI_TOKEN):
            return "<PHI>"
        return "Unknown" if v and "lookup error" in str(v) else (v or "NULL")

    # Build field summary for the UPDATE comment (single /* */ block)
    field_summary = " | ".join(
        f"{c.field_name}: {str(_old_val(c)).replace(chr(10),' ')[:40]} -> {str(_display_val(c)).replace(chr(10),' ')[:40]}"
        for c in updates
    )
    lines.append(f"/* Backup (Expected: 1 row fetched) */")
    lines.append(f"SELECT {backup_cols}")
    lines.append(f"FROM `{table}` WHERE `{pk}` = {record_id};\n")

    lines.append(f"/* Update (Expected: 1 row affected) | {field_summary[:200]} */")
    set_parts = [
        f"`{u.column_name}` = NULL" if not u.new_value
        else f"`{u.column_name}` = {_sql_literal(u.new_value)}"
        for u in updates
    ]
    if has_update_dt:
        set_parts.append(f"`{update_dt}` = NOW()")
    lines.append(f"UPDATE `{table}` SET")
    lines.append(",\n    ".join(f"    {s}" for s in set_parts))
    lines.append(f"WHERE `{pk}` = {record_id};\n")

    # AUDIT LOG — one entry with all field changes, using display values.
    # PHI old values are never embedded as string literals — they use a DB subquery
    # so the real value is resolved at INSERT time without the tool ever reading it.
    _PHI_PREFIX = _PHI_TOKEN

    def _build_audit_content(changes_list):
        """Return (has_phi, content_sql) where content_sql is either a quoted string
        or a CONCAT(...) expression when any field has a PHI old value."""
        parts_sql = []   # each element: SQL expression fragment for CONCAT
        has_phi = False
        sep = ""
        for c in changes_list:
            old_raw = c.current_db_value or "NULL"
            if old_raw and "lookup error" in str(old_raw):
                old_raw = "Unknown"
            new_disp = _display_val(c)

            if str(old_raw).startswith(_PHI_PREFIX):
                has_phi = True
                subquery = str(old_raw)[len(_PHI_PREFIX):]
                # Build CONCAT fragment: literal prefix + subquery + literal suffix
                prefix = _escape(
                    f"{sep}<b>{c.field_name}</b> <b>Old Value : </b>"
                )
                suffix = _escape(f" <b>New Value : </b>{new_disp}")
                parts_sql.append(f"'{prefix}', {subquery}, '{suffix}'")
            else:
                safe = _escape(
                    f"{sep}<b>{c.field_name}</b> "
                    f"<b>Old Value : </b>{old_raw} "
                    f"<b>New Value : </b>{new_disp}"
                )
                parts_sql.append(f"'{safe}'")
            sep = "<br/>"

        if has_phi:
            return True, f"CONCAT({', '.join(parts_sql)})"
        else:
            # All literal — join into single quoted string (original behaviour)
            combined = _escape("<br/>".join(
                f"<b>{c.field_name}</b> "
                f"<b>Old Value : </b>{c.current_db_value or 'NULL'} "
                f"<b>New Value : </b>{_display_val(c)}"
                for c in changes_list
            ))
            return False, f"'{combined}'"

    has_phi_audit, content_expr = _build_audit_content(updates)

    lines.append(f"/* Audit Log (Expected: 1 row affected) */")
    if audit_fk:
        lines.append(f"INSERT INTO `audit_log` (`{audit_fk}`, `content`, `audit_datetime`, `users_id`)")
        lines.append(f"SELECT {audit_record_id}, {content_expr}, NOW(), (SELECT `id` FROM `users` WHERE `user_id` = 'system');\n")
    else:
        lines.append("INSERT INTO `audit_log` (`content`, `audit_datetime`, `users_id`)")
        lines.append(f"SELECT {content_expr}, NOW(), (SELECT `id` FROM `users` WHERE `user_id` = 'system');\n")

    # VALIDATE — check all updated columns
    def _clean_comment(s: str) -> str:
        return str(s).replace("\n", " ").replace("\r", "").replace("  ", " ").strip()

    expected = ", ".join(
        f"{c.column_name}={_sql_literal(_clean_comment(c.new_value or ''))} ({_clean_comment(_display_val(c))})"
        for c in updates
    )
    lines.append(f"/* Validate (Expected: 1 row fetched) | {expected[:200]} */")
    lines.append(f"SELECT {backup_cols}")
    lines.append(f"FROM `{table}` WHERE `{pk}` = {record_id};\n")

    # ── TERMINATE WORKFLOW — always AFTER field updates/audit/validate ────────
    # Mirrors becu-loader-service SqlDataProcessor.terminateWorkflow:
    #   1. Verify open tasks exist in jbpm4_task
    #   2. Update process_flow: active=0, end_datetime=NOW()
    #   3. Insert audit log
    #   4. Validate
    if terminates:
        try:
            from services.terminate_workflow_registry import get_terminate_workflow_config
            tw_cfg = get_terminate_workflow_config()
            for t in terminates:
                _append_single_terminate_workflow(
                    lines,
                    pid=t.terminate_workflow_pid or "UNKNOWN",
                    module_upper=module_upper,
                    tw_cfg=tw_cfg,
                )
        except Exception:
            pass

    return SqlBlock(
        row_num=first.row_num,
        module=first.module,
        case_id=case_id,
        field_name=f"{len(updates)} fields",
        sql="\n".join(lines),
    )


def _is_uniform(changes: list[ChangeRow]) -> bool:
    """Return True when every case has identical (field_name → new_value) assignments.
    Requires: all changes resolved (record_id set, no errors), same module/table.
    """
    if not changes:
        return False
    modules = {c.module for c in changes}
    tables  = {c.table_name for c in changes}
    if len(modules) > 1 or len(tables) > 1:
        return False
    # Group by case, build per-case (field→value) dict
    case_maps: dict[str, dict] = defaultdict(dict)
    for c in changes:
        if c.error:
            return False
        case_maps[c.case_id][c.field_name] = c.new_value
    maps = list(case_maps.values())
    if len(maps) < 2:
        return False
    first = maps[0]
    return all(m == first for m in maps[1:])


def generate_bulk_block(changes: list[ChangeRow]) -> SqlBlock:
    """Generate a single bulk SQL block when all cases share identical field values.

    Emits:
      BACKUP  — SELECT ... WHERE id IN (...)
      UPDATE  — one UPDATE ... WHERE id IN (...)
      AUDIT   — INSERT ... SELECT FROM case table WHERE id IN (...)
      VALIDATE — SELECT ... WHERE id IN (...)
      OPS     — plain-English instruction + bulk process_flow UPDATE for TW
    """
    # Partition into updates vs TW vs already-done/errors
    regular = [c for c in changes if not c.already_done and not c.error
               and not c.is_terminate_workflow and not c.is_delete_action
               and c.column_name and not (c.column_name or "").startswith("#")]
    tw_changes = [c for c in changes if c.is_terminate_workflow and not c.error]
    already_done = [c for c in changes if c.already_done]
    errors = [c for c in changes if c.error and not c.already_done]

    # Deduplicate to one representative change per field (values are uniform)
    field_changes: list[ChangeRow] = []
    seen_cols: set[str] = set()
    for c in regular:
        if c.column_name not in seen_cols:
            seen_cols.add(c.column_name)
            field_changes.append(c)

    # All record_ids
    record_ids = sorted({c.record_id for c in changes if c.record_id and not c.error})
    tw_record_ids = sorted({c.record_id for c in tw_changes})

    sample = next((c for c in changes if c.record_id), changes[0])
    cfg = get_config(sample.module)
    table = sample.table_name or (cfg["table"] if cfg else sample.module)
    pk = cfg["pk"] if cfg else "id"
    audit_fk = cfg.get("audit_fk") if cfg else None
    update_dt = cfg.get("update_datetime_col", "update_datetime") if cfg else "update_datetime"
    module_upper = sample.module.upper()
    n_cases = len(record_ids)
    n_tw = len(tw_record_ids)

    ids_block = _format_id_list(record_ids)
    lines = []

    # ── Header comment ────────────────────────────────────────────────────────
    def _summary_val(c):
        v = c.new_value_display or c.new_value or 'NULL'
        return str(v)[:50] + "..." if len(str(v)) > 50 else str(v)

    field_lines = "\n   ".join(
        f"{c.audit_label or c.field_name} = {_summary_val(c)}"
        for c in field_changes
    )
    if tw_changes:
        field_lines += "\n   Terminate Workflow = Y"
    lines.append(
        f"/* BULK {module_upper} | {n_cases} cases | {len(field_changes)} field(s) to update"
        + (f", {n_tw} workflow termination(s)" if n_tw else "")
        + f"\n   {field_lines}"
    )
    if already_done:
        done_fields = ", ".join(sorted({c.field_name for c in already_done}))
        lines.append(f"   ALREADY DONE ({len({c.case_id for c in already_done})} cases): {done_fields}")
    if errors:
        for e in errors[:5]:
            lines.append(f"   SKIPPED: {e.case_id} — {e.error}")
        if len(errors) > 5:
            lines.append(f"   ... and {len(errors)-5} more errors")
    lines.append("*/\n")

    if not field_changes and not tw_changes:
        return SqlBlock(
            row_num=0, module=sample.module, case_id="(bulk)",
            field_name="(all skipped)", already_done=bool(already_done),
            sql="\n".join(lines),
        )

    if field_changes:
        col_list = ", ".join(f"`{c.column_name}`" for c in field_changes)
        backup_cols = f"`{pk}`, {col_list}, `{update_dt}`"

        # BACKUP
        lines.append(f"/* Backup (Expected: {n_cases} rows fetched) */")
        lines.append(f"SELECT {backup_cols}")
        lines.append(f"FROM `{table}`")
        lines.append(f"WHERE `{pk}` IN (\n    {ids_block}\n);\n")

        # UPDATE
        set_parts = [
            f"`{c.column_name}` = NULL" if not c.new_value
            else f"`{c.column_name}` = {_sql_literal(c.new_value)}"
            for c in field_changes
        ]
        set_parts.append(f"`{update_dt}` = NOW()")
        field_desc = " | ".join(
            f"{c.field_name}: {c.current_db_value or 'NULL'} -> {c.new_value_display or c.new_value}"
            for c in field_changes
        )
        lines.append(f"/* Update (Expected: {n_cases} rows affected) | {field_desc[:200]} */")
        lines.append(f"UPDATE `{table}` SET")
        lines.append(",\n    ".join(f"    {s}" for s in set_parts))
        lines.append(f"WHERE `{pk}` IN (\n    {ids_block}\n);\n")

        # AUDIT — CONCAT subquery resolves old values from DB at execution time.
        # No pre-fetch needed — same pattern as PHI columns.
        if audit_fk:
            concat_parts = []
            sep = ""
            for c in field_changes:
                new_disp = _escape(c.new_value_display or c.new_value or 'NULL')
                field_label = _escape(c.audit_label or c.field_name)
                if c.ref_table and c.ref_id_col and c.ref_desc_col:
                    # FK column — resolve old display value via subquery
                    old_subq = (f"COALESCE((SELECT `{c.ref_desc_col}` FROM `{c.ref_table}` "
                                f"WHERE `{c.ref_id_col}` = t.`{c.column_name}`), 'NULL')")
                    concat_parts.append(
                        f"'{_escape(sep)}<b>{field_label}</b> <b>Old Value : </b>', "
                        f"{old_subq}, "
                        f"' <b>New Value : </b>{new_disp}'"
                    )
                else:
                    # Plain column — embed old value directly
                    old_subq = f"COALESCE(CAST(t.`{c.column_name}` AS CHAR), 'NULL')"
                    concat_parts.append(
                        f"'{_escape(sep)}<b>{field_label}</b> <b>Old Value : </b>', "
                        f"{old_subq}, "
                        f"' <b>New Value : </b>{new_disp}'"
                    )
                sep = "<br/>"
            _sep = ",\n        "
            concat_expr = f"CONCAT(\n        {_sep.join(concat_parts)}\n    )"
            lines.append(f"/* Audit Log (Expected: {n_cases} rows affected) */")
            lines.append(f"INSERT INTO `audit_log` (`{audit_fk}`, `content`, `audit_datetime`, `users_id`)")
            lines.append(
                f"SELECT t.`{pk}`,\n    {concat_expr},\n    NOW(),\n"
                f"    (SELECT `id` FROM `users` WHERE `user_id` = 'system')"
            )
            lines.append(f"FROM `{table}` t WHERE t.`{pk}` IN (\n    {ids_block}\n);\n")

        # VALIDATE
        lines.append(f"/* Validate (Expected: {n_cases} rows fetched) */")
        lines.append(f"SELECT {backup_cols}")
        lines.append(f"FROM `{table}`")
        lines.append(f"WHERE `{pk}` IN (\n    {ids_block}\n);\n")

    # ── OPS — Terminate Workflow ──────────────────────────────────────────────
    if tw_changes:
        tw_ids_block = _format_id_list(tw_record_ids)
        fk_col = ""
        tw_cfg = None
        try:
            from services.terminate_workflow_registry import get_terminate_workflow_config
            tw_cfg = get_terminate_workflow_config()
            fk_col = tw_cfg.module_fk.get(sample.module, "")
        except Exception:
            fk_col = ""

        if not tw_cfg or not fk_col:
            lines.append(
                "/* SKIPPED: Terminate Workflow cleanup could not be generated because "
                f"module '{sample.module}' is missing workflow cleanup configuration. */\n"
            )
            return SqlBlock(
                row_num=0, module=sample.module, case_id="(bulk)",
                field_name=f"{len(field_changes)} fields",
                sql="\n".join(lines),
            )

        cleanup = tw_cfg.workflow_cleanup
        pf = cleanup.process_flow
        task = cleanup.task
        history = cleanup.history
        stage = cleanup.bulk_stage

        pf_table = _quote_table(pf.table)
        pf_pid = _quote_identifier(pf.pid_col)
        pf_active = _quote_identifier(pf.active_col)
        pf_end = _quote_identifier(pf.end_datetime_col)
        task_table = _quote_table(task.table)
        task_execution = _quote_identifier(task.execution_col)
        task_name = _quote_identifier(task.name_col)
        task_state = _quote_identifier(task.state_col)
        hist_table = _quote_table(history.table)
        hist_execution = _quote_identifier(history.execution_col)
        hist_activity = _quote_identifier(history.activity_name_col)
        hist_start = _quote_identifier(history.start_col)
        hist_end = _quote_identifier(history.end_col)
        hist_duration = _quote_identifier(history.duration_col)
        stage_table = _quote_table(stage.table)
        stage_pid = _quote_identifier(stage.pid_col)
        fk_col_sql = _quote_identifier(fk_col)

        lines.append("/* STEP 1: backup active workflow rows and identify PIDs before cleanup */")
        lines.append(f"SELECT pf.{fk_col_sql}, pf.{pf_pid}, jt.{task_name}, jt.{task_state}")
        lines.append(f"FROM {pf_table} pf")
        lines.append(f"INNER JOIN {task_table} jt ON pf.{pf_pid} = jt.{task_execution}")
        lines.append(f"WHERE pf.{fk_col_sql} IN (\n    {tw_ids_block}\n) AND pf.{pf_active} = 1;\n")

        lines.append(f"/* STEP 2: stage active PIDs for OPS {stage.script} before DBA cleanup */")
        if stage.truncate_before_insert:
            lines.append(f"TRUNCATE TABLE {stage_table};")
            lines.append("")
        lines.append(f"INSERT INTO {stage_table} ({stage_pid})")
        lines.append(f"SELECT DISTINCT pf.{pf_pid}")
        lines.append(f"FROM {pf_table} pf")
        lines.append(f"INNER JOIN {task_table} jt ON pf.{pf_pid} = jt.{task_execution}")
        lines.append(f"WHERE pf.{fk_col_sql} IN (\n    {tw_ids_block}\n) AND pf.{pf_active} = 1;\n")

        lines.append("/* STEP 3: DBA marks staged process_flow rows ended */")
        lines.append(f"UPDATE {pf_table} pf")
        lines.append(f"SET pf.{pf_active} = 0,")
        lines.append(f"    pf.{pf_end} = CURRENT_TIMESTAMP")
        lines.append(f"WHERE pf.{pf_pid} IN (")
        lines.append(f"    SELECT sp.{stage_pid}")
        lines.append(f"    FROM {stage_table} sp")
        lines.append(f") AND pf.{pf_active} = 1;\n")

        lines.append("/* STEP 4: DBA ends open JBPM history rows using process_flow end time */")
        lines.append(f"UPDATE {hist_table} hai")
        lines.append(f"JOIN {pf_table} pf ON pf.{pf_pid} = hai.{hist_execution}")
        lines.append(f"SET hai.{hist_end} = COALESCE(pf.{pf_end}, CURRENT_TIMESTAMP),")
        lines.append(f"    hai.{hist_duration} = TIMESTAMPDIFF(SECOND, hai.{hist_start}, COALESCE(pf.{pf_end}, CURRENT_TIMESTAMP)) * 1000")
        lines.append(f"WHERE hai.{hist_execution} IN (")
        lines.append(f"    SELECT sp.{stage_pid}")
        lines.append(f"    FROM {stage_table} sp")
        lines.append(f") AND hai.{hist_end} IS NULL;\n")

        lines.append("/* Validate process_flow cleanup */")
        lines.append(f"SELECT pf.{fk_col_sql}, pf.{pf_pid}, pf.{pf_active}, pf.{pf_end}")
        lines.append(f"FROM {pf_table} pf")
        lines.append(f"WHERE pf.{pf_pid} IN (")
        lines.append(f"    SELECT sp.{stage_pid}")
        lines.append(f"    FROM {stage_table} sp")
        lines.append(");\n")

        lines.append("/* Validate JBPM history cleanup */")
        lines.append(f"SELECT hai.{hist_execution}, hai.{hist_activity}, hai.{hist_start}, hai.{hist_end}, hai.{hist_duration}")
        lines.append(f"FROM {hist_table} hai")
        lines.append(f"WHERE hai.{hist_execution} IN (")
        lines.append(f"    SELECT sp.{stage_pid}")
        lines.append(f"    FROM {stage_table} sp")
        lines.append(");\n")

        lines.append(
            f"/* ═══════════════════════════════════════════════════════════════\n"
            f"   OPS INSTRUCTION — run after DBA cleanup/validation\n"
            f"   ═══════════════════════════════════════════════════════════════\n"
            f"   Action : Terminate workflow for active {module_upper} PIDs\n"
            f"   Module : {module_upper}\n"
            f"\n"
            f"   After STEP 2 stages the active PIDs, run:\n"
            f"        su - {tw_cfg.ops_user}\n"
            f"        cd {tw_cfg.ops_path}\n"
            f"        ./{stage.script}\n"
            f"*/"
        )
        lines.append("")

    return SqlBlock(
        row_num=0, module=sample.module, case_id="(bulk)",
        field_name=f"{len(field_changes)} fields",
        sql="\n".join(lines),
    )


def generate_blocks(changes: list[ChangeRow]) -> list[SqlBlock]:
    """Group changes by case and table, generating one block per (case, table) combination.

    When all cases share identical field values (uniform bulk update), a single
    bulk block is generated instead of one block per case.

    Fields on the parent table (e.g. der), child table (e.g. der_child), and
    multiple target rows in the same table are grouped separately so each block
    targets one record_id.
    """
    seen_keys: list[tuple] = []
    groups: dict[tuple, list[ChangeRow]] = defaultdict(list)

    for c in changes:
        key = (c.module, c.case_id, c.revision, c.table_name or "", c.record_id)
        if key not in groups:
            seen_keys.append(key)
        groups[key].append(c)

    # Detect uniform bulk update — same module/table, all resolved, same values
    resolved = [c for c in changes if c.record_id and not c.error]
    if (len(resolved) > 1
            and len({c.module for c in resolved}) == 1
            and len({c.table_name for c in resolved}) == 1
            and _is_uniform(resolved)):
        return [generate_bulk_block(changes)]

    # Non-uniform batches can still share the same workflow termination action.
    # Keep each case's data updates separate, then append one bulk workflow block
    # so OPS can run the configured stage-table script once.
    bulk_tw_keys: set[tuple[str, str, int]] = set()
    bulk_tw_blocks: list[SqlBlock] = []
    tw_groups: dict[tuple[str, str], list[ChangeRow]] = defaultdict(list)
    for c in changes:
        if c.record_id and not c.error and c.is_terminate_workflow:
            tw_groups[(c.module, c.table_name or "")].append(c)

    for tw_group in tw_groups.values():
        if len({c.record_id for c in tw_group if c.record_id}) <= 1:
            continue
        for c in tw_group:
            bulk_tw_keys.add((c.module, c.case_id, c.record_id or 0))
        bulk_tw_blocks.append(generate_bulk_block(tw_group))

    if not bulk_tw_blocks:
        return [generate_blocks_for_case(groups[k]) for k in seen_keys]

    split_seen_keys: list[tuple] = []
    split_groups: dict[tuple, list[ChangeRow]] = defaultdict(list)
    for c in changes:
        if (
            c.is_terminate_workflow
            and c.record_id
            and (c.module, c.case_id, c.record_id) in bulk_tw_keys
        ):
            continue
        key = (c.module, c.case_id, c.revision, c.table_name or "", c.record_id)
        if key not in split_groups:
            split_seen_keys.append(key)
        split_groups[key].append(c)

    case_blocks = [generate_blocks_for_case(split_groups[k]) for k in split_seen_keys]
    return case_blocks + bulk_tw_blocks


# Keep backward-compat single-change function used by existing routes
def generate_block(change: ChangeRow) -> SqlBlock:
    return generate_blocks_for_case([change])


def generate_file_header(
    total_cases: int,
    updates: int,
    skipped: int,
    blocks: "list[SqlBlock] | None" = None,
    source_file: str | None = None,
) -> str:
    # File header as a single /* */ block — avoids MySQL "Query OK, 0 rows affected" noise
    header = (
        f"/* MERIDIAN — Managed Evaluation & Resolution Intelligence"
        + (f" | Source: {source_file}" if source_file else "")
        + f" | Total cases: {total_cases} | Fields updated: {updates} | Skipped: {skipped}"
        f" | Format: Backup -> Update -> Audit -> Validate"
    )

    # Attention section
    if blocks:
        attention = []
        for b in blocks:
            block_lines = b.sql.splitlines()
            for l in block_lines:
                ls = l.strip()
                if ls.startswith("SKIPPED:") or ls.startswith("ALREADY DONE"):
                    attention.append(f"  {b.case_id}: {ls}")
        if attention:
            header += "\n\n  !! ATTENTION — Cases requiring manual review or action !!"
            for a in attention:
                header += f"\n{a}"

    header += " */\n\n"
    return header
