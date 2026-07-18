from __future__ import annotations

from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import PlainTextResponse

from models.schemas import ChangeRow, GenerateRequest, GenerateResponse, SqlBlock
from services.sql_generator import generate_blocks, generate_block, generate_file_header
from services.module_detector import all_modules
from services.case_lookup import find_record_id, get_current_value, resolve_new_value_id, resolve_via_calc_expression, resolve_with_parent, table_has_update_datetime, PHI_COLUMNS, bulk_find_record_ids, bulk_get_current_values, get_column_max_length, truncate_to_column_length
from services.field_mapper import FieldMapper
from services.module_detector import get_config
from services.delete_action_registry import get_delete_action_registry
from services.semantic_resolver import resolve_semantic_fallback
from services.terminate_workflow_registry import get_terminate_workflow_config, is_terminate_workflow

router = APIRouter(tags=["generate"])


def _redact_debug_text(value: str) -> str:
    """Redact raw request/resolution values before adding debug traces."""
    import re
    text = str(value)
    patterns = (
        (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "<redacted_ssn>"),
        (re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE), "<redacted_email>"),
        (re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b"), "<redacted_phone>"),
        (re.compile(r"'[^']{1,240}'"), "'<redacted_value>'"),
    )
    for pattern, replacement in patterns:
        text = pattern.sub(replacement, text)
    return text


def _dbg(change: ChangeRow, debug: bool, label: str, elapsed_ms: float, result: str) -> None:
    """Append a timed query trace entry to change.debug_entries when debug=True."""
    if debug:
        change.debug_entries.append(
            f"[{change.case_id}] {label} ({elapsed_ms:.0f}ms): {_redact_debug_text(result)}"
        )


def _block_phi_target_update(change: ChangeRow) -> bool:
    """Fail closed for configured PHI target columns instead of generating SQL."""
    if change.column_name and change.column_name.lower() in PHI_COLUMNS:
        change.is_phi = True
        change.error = (
            f"PHI-protected column '{change.column_name}' is not eligible for "
            "MERIDIAN SQL generation. Use a governed manual workflow."
        )
        return True
    return False


def _load_field_context_deps() -> dict:
    """Load field_context_deps.yaml — cascading batch_values injection rules."""
    import os, yaml
    config_path = os.path.join(os.path.dirname(__file__), "..", "config", "field_context_deps.yaml")
    try:
        with open(os.path.normpath(config_path), encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


def _load_calc_expression_overrides() -> dict:
    """Load context-specific calc_expression overrides."""
    import os, yaml
    config_path = os.path.join(os.path.dirname(__file__), "..", "config", "calc_expression_overrides.yaml")
    try:
        with open(os.path.normpath(config_path), encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


def _select_calc_expression(
    default_calc: str | None,
    change: ChangeRow,
    batch_values: dict[str, str] | None,
    overrides: dict | None = None,
) -> str | None:
    """Choose a calc_expression override when the current row has required context."""
    module_rules = (overrides or {}).get(change.module) or {}
    candidates: list[str] = []
    if change.column_name:
        candidates.append(change.column_name)
    if change.field_name:
        candidates.append(change.field_name)

    normalized_rules = {str(k).strip().lower(): v for k, v in module_rules.items()}
    normalized_batch = {
        str(k).strip().lower(): v for k, v in (batch_values or {}).items()
    }

    for key in candidates:
        rules = normalized_rules.get(str(key).strip().lower())
        if not rules:
            continue
        rule_list = rules if isinstance(rules, list) else [rules]
        for rule in rule_list:
            if not isinstance(rule, dict):
                continue
            required = rule.get("required_batch_values") or []
            if all(
                str(req).strip().lower() in normalized_batch
                and str(normalized_batch[str(req).strip().lower()]).strip() != ""
                for req in required
            ):
                return rule.get("calc_expression") or default_calc

    return default_calc


def _assign_current_db_value(change: ChangeRow, raw, display) -> None:
    """Preserve SQL NULL distinctly from empty strings and display values."""
    if raw is None and display is None:
        change.current_db_value = "NULL"
        if change.new_value is None or str(change.new_value).strip().lower() in {"", "blank", "null", "n/a", "na", "none"}:
            change.already_done = True
            change.already_done_reason = "Already set to NULL"
        return
    change.current_db_value = str(display if display is not None else raw)


def _requires_value_resolution(mapping) -> bool:
    """Return True when a mapping's display value must resolve to an ID before comparison."""
    return bool(
        getattr(mapping, "calc_expression", None)
        or getattr(mapping, "lov_expression", None)
        or getattr(mapping, "parent_columns", None)
        or (
            getattr(mapping, "ref_table", None)
            and getattr(mapping, "ref_id_col", None)
            and getattr(mapping, "ref_desc_col", None)
        )
    )


def _load_resolution_policies() -> dict:
    """Load field-specific FK resolution safeguards."""
    import os, yaml
    config_path = os.path.join(os.path.dirname(__file__), "..", "config", "resolution_policies.yaml")
    try:
        with open(os.path.normpath(config_path), encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


def _resolution_policy_for(change: ChangeRow, policies: dict | None) -> dict:
    module_rules = (policies or {}).get(change.module) or {}
    normalized_rules = {str(k).strip().lower(): v for k, v in module_rules.items()}
    candidates = []
    if change.column_name:
        candidates.append(change.column_name)
    if change.field_name:
        candidates.append(change.field_name)
    for key in candidates:
        policy = normalized_rules.get(str(key).strip().lower())
        if isinstance(policy, dict):
            return policy
    return {}


def _ref_table_fallback_disabled(change: ChangeRow, policies: dict | None) -> bool:
    return bool(_resolution_policy_for(change, policies).get("disable_ref_table_fallback"))


def _resolution_policy_error(change: ChangeRow, policies: dict | None) -> str:
    policy = _resolution_policy_for(change, policies)
    message = policy.get("error")
    if isinstance(message, str) and message.strip():
        return message.strip()
    return f"Could not resolve '{change.new_value_display or change.new_value}' for '{change.field_name}'"


def _load_linked_case_fields() -> dict:
    """Load linked_case_fields.yaml for case-number columns that also update FK links."""
    import os, yaml
    config_path = os.path.join(os.path.dirname(__file__), "..", "config", "linked_case_fields.yaml")
    try:
        with open(os.path.normpath(config_path), encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


_LINKED_CASE_FIELDS: dict = _load_linked_case_fields()


async def _resolve_linked_case_fk(change: "ChangeRow", pool) -> "list[ChangeRow]":
    """Resolve and synthesize the matching parent FK update for linked case numbers."""
    from models.schemas import ChangeRow as _ChangeRow

    if not pool or not change.record_id or not change.column_name:
        return []

    module_cfg = _LINKED_CASE_FIELDS.get(change.module)
    if not module_cfg:
        return []

    field_cfg = module_cfg.get(change.column_name)
    if not field_cfg:
        return []

    new_case_no = (change.new_value or "").strip()
    if not new_case_no:
        return []

    candidates = field_cfg.get("candidates", [])
    matches: list[tuple[dict, int]] = []
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                for candidate in candidates:
                    parent_table = candidate["parent_table"]
                    key_col = candidate["key_col"]
                    parent_pk = candidate.get("parent_pk", "id")
                    try:
                        await cur.execute(
                            f"SELECT `{parent_pk}` FROM `{parent_table}` "
                            f"WHERE `{key_col}` = %s LIMIT 2",
                            (new_case_no,),
                        )
                        rows = await cur.fetchall()
                    except Exception:
                        continue
                    if len(rows) == 1:
                        matches.append((candidate, int(rows[0][0])))
    except Exception:
        return []

    on_no_match = field_cfg.get("on_no_match", "skip_and_flag")
    if not matches:
        if on_no_match == "skip_and_flag":
            change.error = (
                f"Original case '{new_case_no}' not found in any linked case table "
                f"({', '.join(c['parent_table'] for c in candidates)}) - cannot set FK link. "
                f"Skipped: neither '{change.column_name}' nor its FK column updated. Manual review needed."
            )
        return []

    if len(matches) > 1:
        hits = ", ".join(f"{candidate['parent_table']}.id={parent_id}" for candidate, parent_id in matches)
        change.error = (
            f"Original case '{new_case_no}' matches multiple linked case tables ({hits}) - "
            f"ambiguous FK link. Manual selection required."
        )
        return []

    candidate, parent_id = matches[0]
    fk_col = candidate["fk_col"]
    parent_table = candidate["parent_table"]
    parent_pk = candidate.get("parent_pk", "id")
    key_col = candidate["key_col"]

    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"SELECT `{fk_col}` FROM `{change.table_name}` WHERE `id` = %s LIMIT 1",
                    (change.record_id,),
                )
                current_row = await cur.fetchone()
    except Exception:
        current_row = None

    current_fk = str(current_row[0]) if current_row and current_row[0] is not None else None
    if current_fk == str(parent_id):
        return []

    return [_ChangeRow(
        row_num=change.row_num,
        module=change.module,
        case_id=change.case_id,
        revision=change.revision,
        field_name=f"{change.field_name} link ({fk_col})",
        column_name=fk_col,
        table_name=change.table_name,
        record_id=change.record_id,
        new_value=str(parent_id),
        new_value_display=new_case_no,
        old_value=current_fk,
        current_db_value=current_fk,
        ref_table=parent_table,
        ref_id_col=parent_pk,
        ref_desc_col=key_col,
        has_update_datetime=change.has_update_datetime,
    )]


def _load_child_table_configs() -> dict:
    """Load child-table status update configs from ref_table_filters.yaml."""
    import os, yaml
    config_path = os.path.join(os.path.dirname(__file__), "..", "config", "ref_table_filters.yaml")
    try:
        with open(os.path.normpath(config_path), encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return {
            k: v for k, v in data.items()
            if isinstance(v, dict) and "status_id_col" in v and "module_fk" in v
        }
    except Exception:
        return {}


def _build_child_table_field_aliases() -> dict[str, str]:
    """Build field-name -> child-table-key mapping from YAML config."""
    configs = _load_child_table_configs()
    aliases: dict[str, str] = {}
    for key, cfg in configs.items():
        for alias in cfg.get("field_aliases", []):
            aliases[alias.strip().lower()] = key
    return aliases


_CHILD_TABLE_FIELD_ALIASES: dict[str, str] = _build_child_table_field_aliases()


async def _resolve_child_table_status(change: "ChangeRow", pool, cfg: dict) -> bool | None:
    """Handle child-table status updates driven by YAML config.

    Returns True when handled, or None when the field should continue through
    normal mapping resolution.
    """
    field_lower = (change.field_name or "").strip().lower()
    child_table_key = _CHILD_TABLE_FIELD_ALIASES.get(field_lower)
    if not child_table_key:
        return None

    if not pool:
        change.error = "No active DB connection"
        return True

    configs = _load_child_table_configs()
    ct_cfg = configs.get(child_table_key)
    if not ct_cfg:
        change.error = f"Child table '{child_table_key}' not configured in ref_table_filters.yaml"
        return True

    fk_col = ct_cfg.get("module_fk", {}).get(change.module)
    if not fk_col:
        change.error = f"Module '{change.module}' not configured for child table '{child_table_key}'"
        return True

    status_id_col = ct_cfg["status_id_col"]
    status_table = ct_cfg.get("status_table", f"{child_table_key}_status")
    status_desc_col = ct_cfg.get("status_desc_col", "description")
    match_col = ct_cfg.get("match_col", "fcontext_display")

    parent_id = change.record_id
    if not parent_id:
        parent_id = await find_record_id(pool, change.module, change.case_id, change.revision)
        if not parent_id:
            change.error = f"Case {change.case_id} not found in DB"
            return True
        if parent_id < 0:
            parent_id = -parent_id

    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"SELECT `id`, `{status_id_col}`, `{match_col}` "
                    f"FROM `{child_table_key}` "
                    f"WHERE `{fk_col}` = %s AND `{status_id_col}` = 1 "
                    f"ORDER BY `id`",
                    (parent_id,),
                )
                open_rows = await cur.fetchall()
    except Exception as e:
        change.error = f"Child table lookup failed: {e}"
        return True

    if not open_rows:
        change.error = f"No open rows in '{child_table_key}' for {change.module} id={parent_id}"
        return True

    target = None
    if len(open_rows) == 1:
        target = open_rows[0]
    elif change.old_value:
        for row in open_rows:
            if change.old_value.strip().lower() in str(row[2] or "").strip().lower():
                target = row
                break
    if not target:
        names = ", ".join(str(r[2]) for r in open_rows)
        change.error = (
            f"{len(open_rows)} open rows in '{child_table_key}' - "
            f"specify which one via old_value. Found: {names}"
        )
        return True

    new_status_desc = (change.new_value or "Cancelled").strip()
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"SELECT `id`, `{status_desc_col}` FROM `{status_table}` "
                    f"WHERE `{status_desc_col}` = %s LIMIT 1",
                    (new_status_desc,),
                )
                status_row = await cur.fetchone()
    except Exception:
        status_row = None

    if not status_row:
        change.error = f"'{new_status_desc}' not found in '{status_table}'"
        return True

    if target[1] == status_row[0]:
        change.already_done = True
        change.already_done_reason = f"Already {new_status_desc}"
        return True

    change.table_name = child_table_key
    change.parent_record_id = parent_id
    change.record_id = target[0]
    change.column_name = status_id_col
    change.new_value = str(status_row[0])
    change.new_value_display = new_status_desc
    change.current_db_value = "Open"
    change.has_update_datetime = True
    return True


async def _apply_context_deps(
    pool,
    module: str,
    record_id: int,
    column_name: str,
    resolved_id: str,
    batch_values: dict,
    deps: dict,
    source_change: "ChangeRow | None" = None,
    _seen: "set | None" = None,
) -> "list[ChangeRow]":
    """After a field resolves, inject dependent context into batch_values.

    Recursively processes the cascade — when a dep provides a new column_name,
    it immediately fires that column's deps too (unlimited depth).

    Returns list of synthesized ChangeRows for columns whose DB value differs
    from the injected value and are not already in the caller's changes list.
    """
    from models.schemas import ChangeRow as _ChangeRow
    if _seen is None:
        _seen = set()
    loop_key = (module, column_name, resolved_id)
    if loop_key in _seen:
        return []
    _seen.add(loop_key)

    synthesized: list[_ChangeRow] = []
    rules = deps.get(module, [])
    for rule in rules:
        if rule.get("resolves") != column_name:
            continue
        for provide in rule.get("provides", []):
            fetch_sql = (provide.get("fetch_sql") or "").strip()
            if not fetch_sql:
                continue
            sql = (fetch_sql
                   .replace("{record_id}", str(record_id))
                   .replace("{resolved_id}", str(resolved_id))
                   )
            try:
                async with pool.acquire() as _conn:
                    async with _conn.cursor() as _cur:
                        await _cur.execute(sql)
                        row = await _cur.fetchone()
                        if not row:
                            continue
                        display, id_val = str(row[0]), str(row[1])
                        if provide.get("field_name"):
                            batch_values[provide["field_name"]] = display
                        dep_col = provide.get("column_name")
                        if dep_col:
                            batch_values[dep_col] = id_val

                        # Check if current DB value differs — synthesize a change if so
                        if dep_col and source_change:
                            cfg = get_config(source_change.module)
                            tbl = source_change.table_name or (cfg["table"] if cfg else None)
                            pk = cfg["pk"] if cfg else "id"
                            if tbl:
                                await _cur.execute(
                                    f"SELECT `{dep_col}` FROM `{tbl}` WHERE `{pk}` = %s LIMIT 1",
                                    (record_id,),
                                )
                                cur_row = await _cur.fetchone()
                                if cur_row and str(cur_row[0]) != id_val:
                                    synthesized.append(_ChangeRow(
                                        row_num=source_change.row_num,
                                        module=source_change.module,
                                        case_id=source_change.case_id,
                                        revision=source_change.revision,
                                        field_name=provide.get("field_name") or dep_col,
                                        column_name=dep_col,
                                        table_name=tbl,
                                        record_id=record_id,
                                        new_value=id_val,
                                        new_value_display=display,
                                        old_value=str(cur_row[0]) if cur_row[0] is not None else None,
                                        has_update_datetime=source_change.has_update_datetime,
                                    ))

                        # Recurse: fire deps for the newly resolved dep_col (cascade Level N+1)
                        if dep_col:
                            deeper = await _apply_context_deps(
                                pool, module, record_id, dep_col, id_val,
                                batch_values, deps, source_change, _seen,
                            )
                            synthesized.extend(deeper)
            except Exception:
                pass
    return synthesized


async def _bulk_preload(changes: list[ChangeRow], pool, mapper: "FieldMapper", fast_mode: bool = False) -> None:
    """Pre-populate record_id and current_db_value for all changes using bulk IN queries.

    Groups changes by (module, table) to issue one SELECT ... IN (...) per group
    rather than one query per row. Skips auth_review (multi-revision logic) and
    any change that already has record_id set.

    After this runs, _auto_resolve skips find_record_id and get_current_value
    for any change that has both record_id and current_db_value already filled.
    """
    if not pool:
        return

    from collections import defaultdict
    from services.module_detector import get_config as _get_config

    # --- Step 1: bulk record_id lookup per (module) group -----------------------
    # Skip auth_review — its lookup logic is too complex for a simple bulk IN query
    module_groups: dict[str, list[ChangeRow]] = defaultdict(list)
    for c in changes:
        if c.record_id or c.error:
            continue
        if c.module in ("auth_review",):
            continue
        module_groups[c.module].append(c)

    # {(module, case_id): record_id}
    record_id_cache: dict[tuple[str, str], int] = {}

    for module, group in module_groups.items():
        case_ids = list({c.case_id for c in group})
        id_map = await bulk_find_record_ids(pool, module, case_ids)
        for case_id, rid in id_map.items():
            record_id_cache[(module, case_id)] = rid

    cfg_cache: dict[str, dict] = {}
    for c in changes:
        if c.record_id or c.error:
            continue
        key = (c.module, c.case_id)
        if key in record_id_cache:
            rid = record_id_cache[key]
            c.record_id = rid
            cfg = cfg_cache.get(c.module) or _get_config(c.module)
            if cfg:
                cfg_cache[c.module] = cfg
                c.table_name = c.table_name or cfg["table"]

    # --- Step 2: bulk current_value fetch (skipped in fast_mode) ----------------
    if fast_mode:
        # Mark all TW changes directly without PID lookup — bulk UPDATE handles them
        from services.terminate_workflow_registry import get_terminate_workflow_config as _tw_cfg_fn, is_terminate_workflow as _is_tw
        _tw_cfg = _tw_cfg_fn()
        for c in changes:
            if c.record_id and not c.error and _is_tw(c.field_name, c.new_value):
                c.is_terminate_workflow = True
                c.terminate_workflow_pid = "bulk"
                c.column_name = "#action:terminate_workflow"
                _cfg_m = _get_config(c.module)
                c.table_name = _cfg_m["table"] if _cfg_m else c.table_name
        return  # skip current values, PID lookup, already-done check

    # --- Step 2: bulk current_value fetch per (module, table) group -------------
    # Group by (module, table) — need column list per group
    TableGroup = tuple[str, str, str]  # (module, table, pk_col)
    tbl_changes: dict[TableGroup, list[ChangeRow]] = defaultdict(list)

    for c in changes:
        if c.error:
            continue
        if not c.record_id or c.current_db_value:
            continue
        if c.module in ("auth_review",):
            continue
        cfg = cfg_cache.get(c.module) or _get_config(c.module)
        if not cfg:
            continue
        cfg_cache[c.module] = cfg
        table = c.table_name or cfg["table"]
        pk_col = "id" if (table != cfg["table"]) else cfg["pk"]
        tbl_changes[(c.module, table, pk_col)].append(c)

    for (module, table, pk_col), grp in tbl_changes.items():
        # Collect unique (column, ref_table, ref_id_col, ref_desc_col) across this group
        col_info_map: dict[str, tuple] = {}  # col_name → (col, rt, ri, rd)
        for c in grp:
            if c.column_name and not c.column_name.startswith("#"):
                if c.column_name not in col_info_map:
                    m = mapper.find_for_module(c.module, c.field_name)
                    col_info_map[c.column_name] = (
                        c.column_name,
                        m.ref_table if m else None,
                        m.ref_id_col if m else None,
                        m.ref_desc_col if m else None,
                    )
        if not col_info_map:
            continue

        record_ids = list({c.record_id for c in grp})
        columns = list(col_info_map.values())
        bulk = await bulk_get_current_values(pool, table, pk_col, record_ids, columns)

        for c in grp:
            if c.record_id and c.column_name and (c.record_id, c.column_name) in bulk:
                raw, display = bulk[(c.record_id, c.column_name)]
                _assign_current_db_value(c, raw, display)

    # --- Step 3: bulk Terminate Workflow pid lookup ------------------------------
    # process_flow lookup per case is normally serial — bulk it here instead.
    from services.terminate_workflow_registry import get_terminate_workflow_config, is_terminate_workflow
    tw_cfg = get_terminate_workflow_config()
    tw_cases: dict[str, list[ChangeRow]] = defaultdict(list)  # module → changes needing TW
    for c in changes:
        if c.error:
            continue
        if c.record_id and is_terminate_workflow(c.field_name, c.new_value):
            fk_col = tw_cfg.module_fk.get(c.module)
            if fk_col:
                tw_cases[c.module].append(c)

    for module, tw_group in tw_cases.items():
        fk_col = tw_cfg.module_fk.get(module)
        if not fk_col:
            continue
        record_ids = list({c.record_id for c in tw_group})
        if not record_ids:
            continue
        try:
            placeholders = ",".join(["%s"] * len(record_ids))
            async with pool.acquire() as _conn:
                async with _conn.cursor() as _cur:
                    await _cur.execute(
                        f"SELECT DISTINCT pf.`{fk_col}`, pf.`pid` FROM `process_flow` pf "
                        f"INNER JOIN `jbpm4_task` jt ON pf.`pid` = jt.`EXECUTION_ID_` "
                        f"WHERE pf.`{fk_col}` IN ({placeholders}) "
                        f"ORDER BY pf.`{fk_col}`, pf.`pid` LIMIT {len(record_ids) * 5}",
                        record_ids,
                    )
                    pid_rows = await _cur.fetchall()
            pid_map: dict[int, str] = {int(r[0]): str(r[1]) for r in pid_rows}
            for c in tw_group:
                if c.record_id in pid_map:
                    c.is_terminate_workflow = True
                    c.terminate_workflow_pid = pid_map[c.record_id]
                    c.column_name = "#action:terminate_workflow"
                    cfg_m = _get_config(c.module)
                    c.table_name = cfg_m["table"] if cfg_m else c.table_name
                else:
                    c.error = (
                        f"Terminate Workflow: no active process_flow row found "
                        f"for {c.module} id={c.record_id}"
                    )
        except Exception as _e:
            for c in tw_group:
                c.error = f"Terminate Workflow bulk lookup failed: {_e}"

    # --- Step 4: bulk FK value resolution cache ---------------------------------
    # For changes where current_db_value == new_value (display), mark already_done now.
    # This avoids firing calc_expression queries for rows that don't need updating.
    fk_resolve_cache: dict[tuple[str, str, str], str | None] = {}  # (module, field, value) → resolved_id

    for c in changes:
        if c.current_db_value is None or c.new_value is None:
            continue
        if c.already_done or c.error:
            continue
        # Quick display-level already-done check — only safe for plain (non-FK) fields.
        # FK fields with calc_expression can have the same display value but different IDs
        # under different contexts (e.g. RequestReason "Prior Authorization" has a different
        # cdtype_id under request_type=1 vs request_type=4). These must always go through
        # full FK resolution — never skip them here.
        m = mapper.find_for_module(c.module, c.field_name)
        if m and _requires_value_resolution(m):
            continue  # let _auto_resolve do raw ID comparison after full resolution
        if str(c.current_db_value).strip().lower() == str(c.new_value).strip().lower():
            c.already_done = True
            c.already_done_reason = f"Already set to '{c.current_db_value}'"


async def _auto_resolve(changes: list[ChangeRow], request: Request, debug: bool = False, fast_mode: bool = False) -> list[ChangeRow]:
    """Auto-resolve record_id and column_name if not already set."""
    import time
    from collections import defaultdict
    pool = getattr(request.app.state, "active_pool", None)
    mapper: FieldMapper = request.app.state.field_mapper
    _ctx_deps = _load_field_context_deps()
    _calc_overrides = _load_calc_expression_overrides()
    _resolution_policies = _load_resolution_policies()

    _NULL_TOKENS = {"blank", "null", "n/a", "na", "none", ""}
    for c in changes:
        if c.new_value and c.new_value.strip().lower() in _NULL_TOKENS:
            c.new_value = ""

    if pool:
        for c in changes:
            if c.record_id or c.error:
                continue
            if await resolve_semantic_fallback(c, pool):
                if c.table_name:
                    c.has_update_datetime = await table_has_update_datetime(pool, c.table_name)

    # ── Bulk preload: resolve record_id + current_db_value for all changes
    #    using IN queries, then mark already-done at display level.
    #    This avoids N individual DB round-trips for large spreadsheets.
    #    Column names must be resolved first (via mapper) before current values
    #    can be fetched in bulk — so we do a fast mapper-only pass first.
    if len(changes) > 10 and pool:
        for c in changes:
            if not c.column_name and not c.record_id:
                m = mapper.find_for_module(c.module, c.field_name)
                if m:
                    cfg = get_config(c.module)
                    # Skip pre-setting column_name for fields on a different table.
                    # Child/related-table mappings need _auto_resolve to switch
                    # table_name and record_id safely before current-value preload.
                    is_different_table = (cfg and m.table_name and m.table_name != cfg["table"])
                    if not is_different_table:
                        c.column_name = m.column_name
                        if cfg:
                            c.table_name = c.table_name or cfg["table"]
        await _bulk_preload(changes, pool, mapper, fast_mode=fast_mode)

    # FK resolution cache: (module, field_name, new_value) → resolved_id
    # Prevents re-querying the same (field, value) pair that repeats across cases.
    _fk_cache: dict[tuple[str, str, str], str | None] = {}

    # Build per-case batch_values keyed by BOTH ui_name and column_name
    # column_name used by resolve_with_parent (cascading.csv uses column names)
    # ui_name used by resolve_via_calc_expression (#FieldName# placeholders)
    batch_values_map: dict[tuple, dict[str, str]] = defaultdict(dict)
    _synthesized_changes: list[ChangeRow] = []  # implicit changes from field_context_deps
    _synthesized_keys: set[tuple] = set()       # (case_id, column_name) dedup set

    # Pre-resolve Request Type IDs so RequestReason/Classification calcs see the new
    # request_type as a numeric ID in batch_values — not the display string.
    # Original Request Type is also pre-resolved because rd_original_cd_type can
    # depend on a pending original_request_type update in the same spreadsheet row.
    # Original case number is pre-resolved for the same reason: rd_original_cd_type
    # should use the original case's request_type, not the current case request_type.
    if pool:
        _rt_cache: dict[str, str] = {}  # display → id
        _original_der_cache: dict[str, str] = {}  # der_no → der.id
        for c in changes:
            field_key = (c.field_name or "").strip().lower()
            is_request_type_context = field_key in (
                "request type", "request_type",
                "original request type", "original_request_type",
            )
            if is_request_type_context and c.new_value:
                if c.new_value not in _rt_cache:
                    try:
                        async with pool.acquire() as _rc:
                            async with _rc.cursor() as _rcur:
                                await _rcur.execute(
                                    "SELECT `id` FROM `der_request_types` WHERE `name` = %s LIMIT 1",
                                    (c.new_value,)
                                )
                                _rt_row = await _rcur.fetchone()
                                if _rt_row:
                                    _rt_cache[c.new_value] = str(_rt_row[0])
                    except Exception:
                        pass
                if c.new_value in _rt_cache:
                    key = (c.module, c.case_id, c.revision)
                    if field_key in ("original request type", "original_request_type"):
                        batch_values_map[key]["original_request_type"] = _rt_cache[c.new_value]
                        batch_values_map[key]["Original Request Type"] = _rt_cache[c.new_value]
                    else:
                        batch_values_map[key]["request_type"] = _rt_cache[c.new_value]
                        batch_values_map[key]["Request Type"] = _rt_cache[c.new_value]
            is_original_case_context = field_key in (
                "original case number", "original case no", "original case #",
                "original_case_number", "rd_original_der_no",
            )
            if is_original_case_context and c.new_value:
                if c.new_value not in _original_der_cache:
                    try:
                        async with pool.acquire() as _oc:
                            async with _oc.cursor() as _ocur:
                                await _ocur.execute(
                                    "SELECT `id` FROM `der` WHERE `der_no` = %s LIMIT 1",
                                    (c.new_value,)
                                )
                                _oc_row = await _ocur.fetchone()
                                if _oc_row:
                                    _original_der_cache[c.new_value] = str(_oc_row[0])
                    except Exception:
                        pass
                if c.new_value in _original_der_cache:
                    key = (c.module, c.case_id, c.revision)
                    batch_values_map[key]["rd_original_der_no"] = _original_der_cache[c.new_value]
                    batch_values_map[key]["Original case number"] = c.new_value
                    batch_values_map[key]["Original Case Number"] = c.new_value

    for c in changes:
        if c.new_value:
            key = (c.module, c.case_id, c.revision)
            # Don't overwrite a pre-resolved numeric ID with a display string
            existing = batch_values_map[key].get(c.field_name, "")
            if not (existing and str(existing).lstrip("-").isdigit()):
                batch_values_map[key][c.field_name] = c.new_value
            if c.column_name:
                existing_col = batch_values_map[key].get(c.column_name, "")
                if not (existing_col and str(existing_col).lstrip("-").isdigit()):
                    batch_values_map[key][c.column_name] = c.new_value

    for change in changes:
        if change.error:
            continue
        if change.record_id and change.column_name:
            if _block_phi_target_update(change):
                continue
            # Already resolved — but still need current DB value + PHI flag if not set
            if not change.current_db_value and pool:
                mapping = mapper.find_for_module(change.module, change.field_name)
                try:
                    raw, display = await get_current_value(
                        pool, change.module, change.record_id, change.column_name,
                        mapping.ref_table if mapping else None,
                        mapping.ref_id_col if mapping else None,
                        mapping.ref_desc_col if mapping else None,
                        table_name=change.table_name,
                    )
                    _assign_current_db_value(change, raw, display)
                except Exception:
                    pass
            # Skip further resolution only when already done, errored, or special actions
            # that don't need FK lookup (TW/delete already handled in bulk preload).
            if change.already_done or change.error or change.is_terminate_workflow or change.is_delete_action:
                continue
            # If new_value still needs FK resolution (it's a display string, not an ID),
            # fall through to the resolution block below — do NOT skip with continue.

        cfg = get_config(change.module)
        if not cfg:
            change.error = f"Unknown module: {change.module}"
            continue

        # ── Delete action check ───────────────────────────────────────────────
        # Must happen before record_id resolution so we can look up the child row.
        delete_action = get_delete_action_registry().match(
            change.module, change.field_name, change.new_value
        )
        if delete_action and pool:
            # Resolve parent record_id first if needed
            if not change.record_id:
                record_id = await find_record_id(pool, change.module, change.case_id, change.revision)
                if not record_id:
                    change.error = f"Case {change.case_id} not found in DB"
                    continue
                if record_id < 0:
                    record_id = -record_id
                change.record_id = record_id

            # Find the child row by matching old_value against child_match_col
            try:
                async with pool.acquire() as _conn:
                    async with _conn.cursor() as _cur:
                        await _cur.execute(
                            f"SELECT `id` FROM `{delete_action.child_table}` "
                            f"WHERE `{delete_action.child_fk_col}` = %s "
                            f"AND `{delete_action.child_match_col}` = %s LIMIT 1",
                            (change.record_id, change.old_value),
                        )
                        child_row = await _cur.fetchone()
            except Exception as _e:
                change.error = f"Could not look up child row for delete action: {_e}"
                continue

            if not child_row:
                change.error = (
                    f"Delete action: no row found in `{delete_action.child_table}` "
                    f"WHERE {delete_action.child_match_col} = '{change.old_value}'"
                )
                continue

            change.is_delete_action = True
            change.delete_child_table = delete_action.child_table
            change.delete_child_fk_col = delete_action.child_fk_col
            change.delete_child_match_col = delete_action.child_match_col
            change.delete_child_row_id = child_row[0]
            change.delete_audit_fk = delete_action.audit_fk
            change.column_name = f"#delete:{delete_action.child_table}"  # sentinel
            change.table_name = cfg["table"]
            continue  # skip normal field resolution

        # ── Child Table Status Update (config-driven from ref_table_filters.yaml) ──
        # Handles fields like "Sub Task Status" that update a child table's status column.
        _child_table_match = await _resolve_child_table_status(change, pool, cfg)
        if _child_table_match is True:
            continue

        # ── Terminate Workflow check ──────────────────────────────────────────
        # Skip if already resolved by _bulk_preload (has pid or error set)
        if is_terminate_workflow(change.field_name, change.new_value) and pool:
            if change.is_terminate_workflow or change.error:
                continue  # already handled in bulk preload
            tw_cfg = get_terminate_workflow_config()
            fk_col = tw_cfg.module_fk.get(change.module)
            if not fk_col:
                change.error = (
                    f"Terminate Workflow: module '{change.module}' not in "
                    f"terminate_workflow_modules.yaml"
                )
                continue

            # Resolve parent record_id first if needed
            if not change.record_id:
                record_id = await find_record_id(pool, change.module, change.case_id, change.revision)
                if not record_id:
                    change.error = f"Case {change.case_id} not found in DB"
                    continue
                if record_id < 0:
                    record_id = -record_id
                change.record_id = record_id

            # Look up process_flow.pid — join jbpm4_task to confirm open tasks exist
            # (mirrors becu-loader-service ProcessFlowDAO.findPidsByRefTableId)
            try:
                async with pool.acquire() as _conn:
                    async with _conn.cursor() as _cur:
                        await _cur.execute(
                            f"SELECT DISTINCT pf.`pid` FROM `process_flow` pf "
                            f"INNER JOIN `jbpm4_task` jt ON pf.`pid` = jt.`EXECUTION_ID_` "
                            f"WHERE pf.`{fk_col}` = %s "
                            f"ORDER BY pf.`pid` LIMIT 1",
                            (change.record_id,),
                        )
                        pf_row = await _cur.fetchone()
            except Exception as _e:
                change.error = f"Terminate Workflow: could not look up process_flow: {_e}"
                continue

            if not pf_row:
                change.error = (
                    f"Terminate Workflow: no active process_flow row found "
                    f"for {change.module} id={change.record_id}"
                )
                continue

            change.is_terminate_workflow = True
            change.terminate_workflow_pid = pf_row[0]
            change.column_name = "#action:terminate_workflow"  # sentinel
            change.table_name = cfg["table"]
            continue  # skip normal field resolution

        # Find record ID
        if not change.record_id:
            if not pool:
                change.error = "No active DB connection — activate a profile and use Verify first"
                continue
            _t0 = time.perf_counter()
            record_id = await find_record_id(pool, change.module, change.case_id, change.revision)
            _ms = (time.perf_counter() - _t0) * 1000
            if not record_id:
                _dbg(change, debug, "find_record_id", _ms, f"NOT FOUND in {change.module}")
                change.error = f"Case {change.case_id} not found in DB"
                continue
            # Handle H-prefix ambiguity sentinel
            if record_id < 0:
                record_id = -record_id
                change.module = "authorizations"
                cfg = get_config("authorizations") or cfg
            change.record_id = record_id
            change.table_name = cfg["table"]
            change.has_update_datetime = await table_has_update_datetime(pool, cfg["table"])
            _dbg(change, debug, "find_record_id", _ms, f"→ {record_id}")

        # Resolve column name from field mapping
        _resolve_failed: str | None = None
        if not change.column_name:
            mapping = mapper.find_for_module(change.module, change.field_name)
            if not mapping:
                # Not in mapping — generate a comment-only block, don't hard error
                _dbg(change, debug, f"field_mapper '{change.field_name}'", 0,
                     f"NOT FOUND in {change.module} — SKIPPED")
                change.error = f"Field '{change.field_name}' not in field mapping for {change.module} — manual review needed"
                continue
            tier = ("Tier 3 message_constant" if mapping.table_name else
                    "Tier 2 mapping xlsx" if not mapping.calc_expression else "Tier 1 calc")
            _dbg(change, debug, f"field_mapper '{change.field_name}'", 0,
                 f"{tier} → {mapping.table_name}.{mapping.column_name}")
            if mapping.table_name and mapping.table_name != (cfg["table"] if cfg else ""):
                # Field lives in a child/related table — update table_name and re-check update_datetime
                change.table_name = mapping.table_name
                if pool:
                    change.has_update_datetime = await table_has_update_datetime(pool, mapping.table_name)

                # Child table: derive the FK column and resolve the child row's PK.
                # Convention: {parent_table}_child has FK column {parent_table}_id.
                # e.g. der_child.der_id links to der.id
                parent_table = cfg["table"] if cfg else None
                if (pool and parent_table and
                        mapping.table_name == f"{parent_table}_child"):
                    fk_col = f"{parent_table}_id"
                    try:
                        async with pool.acquire() as _conn:
                            async with _conn.cursor() as _cur:
                                await _cur.execute(
                                    f"SELECT `id` FROM `{mapping.table_name}` "
                                    f"WHERE `{fk_col}` = %s LIMIT 1",
                                    (change.record_id,),
                                )
                                _row = await _cur.fetchone()
                                if _row and _row[0]:
                                    change.parent_record_id = change.record_id  # preserve parent (e.g. der.id) for audit log
                                    change.record_id = _row[0]  # now child PK (e.g. der_child.id)
                    except Exception:
                        pass

                # Special case: auth_review module but field is on authorizations parent table.
                # record_id is currently the auth_review.id — resolve the authorizations.id instead.
                elif change.module == "auth_review" and mapping.table_name == "authorizations" and pool:
                    try:
                        async with pool.acquire() as _conn:
                            async with _conn.cursor() as _cur:
                                await _cur.execute(
                                    "SELECT authorization_id FROM auth_review WHERE id = %s LIMIT 1",
                                    (change.record_id,),
                                )
                                _row = await _cur.fetchone()
                                if _row and _row[0]:
                                    change.record_id = _row[0]
                                    change.module = "authorizations"
                                    cfg = get_config("authorizations") or cfg
                    except Exception:
                        pass
            change.column_name = mapping.column_name

            if _block_phi_target_update(change):
                continue

            # Store ref table info for bulk audit CONCAT subquery in generate_bulk_block
            if mapping.ref_table and mapping.ref_id_col and mapping.ref_desc_col:
                change.ref_table = mapping.ref_table
                change.ref_id_col = mapping.ref_id_col
                change.ref_desc_col = mapping.ref_desc_col

            # Resolve new_value to ID — prefer calc_expression, then lov_expression, then ref_table
            needs_resolution = change.new_value and pool and (
                mapping.calc_expression or mapping.lov_expression or
                (mapping.ref_table and mapping.ref_id_col and mapping.ref_desc_col)
            )
            if needs_resolution:
                disable_ref_table_fallback = _ref_table_fallback_disabled(change, _resolution_policies)
                change.new_value_display = change.new_value  # preserve original for audit log
                try:
                    resolved_id: str | None = None
                    batch_values = batch_values_map.get((change.module, change.case_id, change.revision), {})
                    selected_calc = _select_calc_expression(
                        mapping.calc_expression, change, batch_values, _calc_overrides
                    )

                    # Check FK cache — calc_expressions are case-specific so skip cache for those
                    _cache_key = (change.module, change.field_name, change.new_value)
                    if not selected_calc and _cache_key in _fk_cache:
                        resolved_id = _fk_cache[_cache_key]
                        _dbg(change, debug, f"fk_cache '{change.field_name}'", 0,
                             f"'{change.new_value}' → {resolved_id!r} (cached)")

                    if selected_calc:
                        _t0 = time.perf_counter()
                        resolved_id = await resolve_via_calc_expression(
                            pool, selected_calc, change.new_value,
                            change.field_name, change.case_id, batch_values,
                            record_id=change.record_id,
                        )
                        _ms = (time.perf_counter() - _t0) * 1000
                        _dbg(change, debug, f"calc_expression '{change.field_name}'", _ms,
                             f"'{change.new_value}' → {resolved_id!r}")
                    if not resolved_id and mapping.parent_columns:
                        _t0 = time.perf_counter()
                        resolved_id = await resolve_with_parent(
                            pool, mapping, change.new_value, batch_values, change.case_id,
                        )
                        _ms = (time.perf_counter() - _t0) * 1000
                        _dbg(change, debug, f"resolve_with_parent '{change.field_name}'", _ms,
                             f"'{change.new_value}' → {resolved_id!r}")
                    if not resolved_id and mapping.ref_table and mapping.ref_id_col and mapping.ref_desc_col:
                        if disable_ref_table_fallback:
                            _resolve_failed = _resolution_policy_error(change, _resolution_policies)
                            _dbg(change, debug, f"resolve_new_value_id '{change.field_name}'", 0,
                                 "SKIPPED generic ref-table fallback by resolution policy")
                        else:
                            _t0 = time.perf_counter()
                            resolved_id = await resolve_new_value_id(
                                pool, mapping.ref_table, mapping.ref_id_col, mapping.ref_desc_col,
                                change.new_value, case_id=change.case_id,
                                lov_expression=mapping.lov_expression,
                                module=change.module,
                            )
                            _ms = (time.perf_counter() - _t0) * 1000
                            _dbg(change, debug, f"resolve_new_value_id '{change.field_name}'", _ms,
                                 f"'{change.new_value}' in {mapping.ref_table} → {resolved_id!r}")
                    if resolved_id and resolved_id.startswith("__AMBIGUOUS__:"):
                        # Calc returned multiple rows — try ref_table_filters scoping before giving up
                        candidates = resolved_id[len("__AMBIGUOUS__:"):]
                        if disable_ref_table_fallback:
                            _dbg(change, debug, f"resolve '{change.field_name}'", 0,
                                 f"AMBIGUOUS — {candidates}")
                            _resolve_failed = _resolution_policy_error(change, _resolution_policies)
                        elif mapping.ref_table and mapping.ref_id_col and mapping.ref_desc_col:
                            _t0 = time.perf_counter()
                            scoped_id = await resolve_new_value_id(
                                pool, mapping.ref_table, mapping.ref_id_col, mapping.ref_desc_col,
                                change.new_value, case_id=change.case_id,
                                lov_expression=mapping.lov_expression,
                                module=change.module,
                            )
                            _ms = (time.perf_counter() - _t0) * 1000
                            if scoped_id:
                                _dbg(change, debug, f"ref_table_filter '{change.field_name}'", _ms,
                                     f"'{change.new_value}' → {scoped_id} (scoped via ref_table_filters.yaml)")
                                resolved_id = scoped_id
                                change.new_value = resolved_id
                                _bv_key = (change.module, change.case_id, change.revision)
                                batch_values_map[_bv_key][change.field_name] = change.new_value_display or resolved_id
                                if change.column_name:
                                    batch_values_map[_bv_key][change.column_name] = resolved_id
                                if pool and change.record_id and change.column_name:
                                    _syn = await _apply_context_deps(
                                        pool, change.module, change.record_id,
                                        change.column_name, resolved_id,
                                        batch_values_map[_bv_key], _ctx_deps,
                                        source_change=change,
                                    )
                                    _existing_cols = {(c.case_id, c.column_name) for c in changes}
                                    for s in _syn:
                                        k = (s.case_id, s.column_name)
                                        if k not in _existing_cols and k not in _synthesized_keys:
                                            _synthesized_keys.add(k)
                                            _synthesized_changes.append(s)
                            else:
                                _dbg(change, debug, f"resolve '{change.field_name}'", 0,
                                     f"AMBIGUOUS — {candidates}")
                                _resolve_failed = (
                                    f"Multiple eligibility records match '{change.new_value_display}' "
                                    f"for field '{change.field_name}' — manual selection required.\n"
                                    f"-- Candidates: {candidates}"
                                )
                        else:
                            _dbg(change, debug, f"resolve '{change.field_name}'", 0,
                                 f"AMBIGUOUS — {candidates}")
                            _resolve_failed = (
                                f"Multiple eligibility records match '{change.new_value_display}' "
                                f"for field '{change.field_name}' — manual selection required.\n"
                                f"-- Candidates: {candidates}"
                            )
                    elif resolved_id:
                        change.new_value = resolved_id
                        # Cache for subsequent rows with the same (module, field, value)
                        # Only cache non-calc results — calc is case-specific
                        if not selected_calc:
                            _fk_cache[_cache_key] = resolved_id
                        # Update batch_values_map after resolution:
                        # - field_name key → display value (for #FieldName# placeholder substitution)
                        # - column_name key → resolved ID (for context-aware lookups)
                        _bv_key = (change.module, change.case_id, change.revision)
                        batch_values_map[_bv_key][change.field_name] = change.new_value_display or resolved_id
                        if change.column_name:
                            batch_values_map[_bv_key][change.column_name] = resolved_id
                        # Apply cascading context deps from field_context_deps.yaml
                        if pool and change.record_id and change.column_name:
                            _syn = await _apply_context_deps(
                                pool, change.module, change.record_id,
                                change.column_name, resolved_id,
                                batch_values_map[_bv_key], _ctx_deps,
                                source_change=change,
                            )
                            _existing_keys = {(c.case_id, c.column_name) for c in changes} | _synthesized_keys
                            for s in _syn:
                                k = (s.case_id, s.column_name)
                                if k not in _existing_keys:
                                    _synthesized_keys.add(k)
                                    _synthesized_changes.append(s)
                    else:
                        # Distinguish ambiguous (multiple matches) from not-found
                        if _resolve_failed:
                            pass
                        elif mapping.ref_table and mapping.ref_id_col and mapping.ref_desc_col:
                            _dbg(change, debug, f"resolve '{change.field_name}'", 0,
                                 f"AMBIGUOUS/NOT FOUND '{change.new_value_display}' in {mapping.ref_table}")
                            _resolve_failed = (
                                f"Ambiguous or not found: '{change.new_value_display}' matches multiple rows "
                                f"in `{mapping.ref_table}` for field '{change.field_name}' — "
                                f"calc_expression required to scope correctly"
                            )
                        else:
                            _resolve_failed = f"Could not resolve '{change.new_value_display}' for field '{change.field_name}'"
                except Exception:
                    _resolve_failed = f"Lookup failed for '{change.new_value_display}' in field '{change.field_name}'"

        # Store ref info for bulk audit (pre-mapped path)
        if change.record_id and change.column_name and not change.ref_table:
            _m = mapper.find_for_module(change.module, change.field_name)
            if _m and _m.ref_table and _m.ref_id_col and _m.ref_desc_col:
                change.ref_table = _m.ref_table
                change.ref_id_col = _m.ref_id_col
                change.ref_desc_col = _m.ref_desc_col

        # ── FK resolution for pre-mapped changes (bulk preload set column_name) ──
        # When bulk preload already set column_name, the `if not change.column_name:`
        # block above was skipped entirely, so new_value is still a display string.
        # Run FK resolution now for any change that still has an unresolved new_value.
        if (change.record_id and change.column_name
                and not change.already_done and not change.error
                and not change.is_terminate_workflow and not change.is_delete_action
                and change.new_value and not change.new_value_display):
            mapping = mapper.find_for_module(change.module, change.field_name)
            if mapping:
                needs_resolution = pool and (
                    mapping.calc_expression or mapping.lov_expression or
                    (mapping.ref_table and mapping.ref_id_col and mapping.ref_desc_col)
                )
                if needs_resolution:
                    if not change.new_value_display:
                        change.new_value_display = change.new_value
                    _resolve_failed = None
                    try:
                        resolved_id = None
                        batch_values = batch_values_map.get((change.module, change.case_id, change.revision), {})
                        selected_calc = _select_calc_expression(
                            mapping.calc_expression, change, batch_values, _calc_overrides
                        )
                        disable_ref_table_fallback = _ref_table_fallback_disabled(change, _resolution_policies)
                        _cache_key = (change.module, change.field_name, change.new_value)
                        if not selected_calc and _cache_key in _fk_cache:
                            resolved_id = _fk_cache[_cache_key]
                        else:
                            if selected_calc:
                                resolved_id = await resolve_via_calc_expression(
                                    pool, selected_calc, change.new_value,
                                    change.field_name, change.case_id, batch_values,
                                    record_id=change.record_id,
                                )
                            if not resolved_id and mapping.parent_columns:
                                resolved_id = await resolve_with_parent(
                                    pool, mapping, change.new_value, batch_values, change.case_id,
                                )
                            if not resolved_id and mapping.ref_table and mapping.ref_id_col and mapping.ref_desc_col:
                                if disable_ref_table_fallback:
                                    change.error = _resolution_policy_error(change, _resolution_policies)
                                else:
                                    resolved_id = await resolve_new_value_id(
                                        pool, mapping.ref_table, mapping.ref_id_col, mapping.ref_desc_col,
                                        change.new_value, case_id=change.case_id,
                                        lov_expression=mapping.lov_expression, module=change.module,
                                    )
                            if not selected_calc:
                                _fk_cache[_cache_key] = resolved_id
                        if resolved_id and not str(resolved_id).startswith("__AMBIGUOUS__"):
                            change.new_value = resolved_id
                            # Update batch_values_map so cascading fields (e.g. RequestReason after
                            # Request Type, Classification after RequestReason) use the resolved ID
                            _bv_key = (change.module, change.case_id, change.revision)
                            batch_values_map[_bv_key][change.field_name] = change.new_value_display or resolved_id
                            if change.column_name:
                                batch_values_map[_bv_key][change.column_name] = resolved_id
                        elif resolved_id and str(resolved_id).startswith("__AMBIGUOUS__"):
                            change.error = (
                                _resolution_policy_error(change, _resolution_policies)
                                if disable_ref_table_fallback
                                else f"Ambiguous lookup for '{change.new_value_display}' in field '{change.field_name}'"
                            )
                        elif not resolved_id:
                            if not change.error:
                                change.error = f"Could not resolve '{change.new_value_display}' for '{change.field_name}'"
                    except Exception:
                        change.error = f"Lookup failed for '{change.new_value_display}' in field '{change.field_name}'"

        # Get current DB value if not set; also fetch raw ID for already-done check
        _raw_db_value = None
        # If current_db_value was set by bulk preload (display value), we still need the
        # raw FK ID for the already-done comparison — fetch it from a second get_current_value call.
        if change.current_db_value and pool and change.record_id and change.column_name and not change.already_done:
            mapping_for_raw = mapper.find_for_module(change.module, change.field_name)
            if mapping_for_raw and (mapping_for_raw.ref_table or mapping_for_raw.calc_expression):
                try:
                    raw, _ = await get_current_value(
                        pool, change.module, change.record_id, change.column_name,
                        None, None, None,  # no ref table — just get raw numeric value
                        table_name=change.table_name,
                    )
                    _raw_db_value = raw
                except Exception:
                    pass
        if not change.current_db_value and pool and change.record_id and change.column_name:
            mapping = mapper.find_for_module(change.module, change.field_name)
            try:
                raw, display = await get_current_value(
                    pool, change.module, change.record_id, change.column_name,
                    mapping.ref_table if mapping else None,
                    mapping.ref_id_col if mapping else None,
                    mapping.ref_desc_col if mapping else None,
                    table_name=change.table_name,
                )
                _assign_current_db_value(change, raw, display)
                _raw_db_value = raw  # stash raw ID for already-done comparison below
            except Exception as e:
                _raw_db_value = None
                # Column might not exist or mapping is wrong — continue without current value
                change.current_db_value = f"(lookup error: {str(e)[:60]})"

        # ── Column length validation ──────────────────────────────────────────
        # Check varchar/char column limits. If value exceeds limit, mark as error
        # with a suggested word-boundary truncation — DBA must confirm before execution.
        if (pool and change.new_value and change.column_name and change.table_name
                and not change.error and not change.already_done
                and not (change.new_value or "").lstrip("-").isdigit()):
            max_len = await get_column_max_length(pool, change.table_name, change.column_name)
            if max_len and len(change.new_value) > max_len:
                suggested = change.new_value[:max_len].rsplit(' ', 1)[0]
                change.error = (
                    f"Value is {len(change.new_value)} chars but column '{change.column_name}' "
                    f"max is {max_len}. Suggested ({len(suggested)} chars): '{suggested}'"
                )

        # Already-done check — when new_value was resolved to a numeric ID, compare
        # raw IDs (not display values) so two different IDs with the same description
        # (e.g. der_status_reason 151 vs 285, both "Fax Back") are not treated as equal.
        # This runs unconditionally so bulk-preloaded fields also get already-done detection.
        if not change.already_done and not change.error and change.current_db_value:
            compare_new = change.new_value_display or change.new_value
            resolved_to_id = bool(change.new_value and change.new_value_display and change.new_value != change.new_value_display)
            if resolved_to_id:
                # new_value is a resolved numeric ID — compare raw IDs only.
                # Skip display comparison: two different IDs can share the same description
                # (e.g. der_status_reason 151 vs 285 both show as "Fax Back").
                if _raw_db_value and str(_raw_db_value) == str(change.new_value):
                    change.already_done = True
                    change.already_done_reason = f"Already set to '{change.current_db_value}'"
                # Push resolved ID into batch_values even when already_done so dependent
                # fields (e.g. Classification after RequestReason) get the correct context.
                _bv_key = (change.module, change.case_id, change.revision)
                batch_values_map[_bv_key][change.field_name] = change.new_value_display or change.new_value
                if change.column_name:
                    batch_values_map[_bv_key][change.column_name] = change.new_value
                if pool and change.record_id and change.column_name:
                    _syn = await _apply_context_deps(
                        pool, change.module, change.record_id,
                        change.column_name, change.new_value,
                        batch_values_map[_bv_key], _ctx_deps,
                        source_change=change,
                    )
                    _existing_keys = {(c.case_id, c.column_name) for c in changes} | _synthesized_keys
                    for s in _syn:
                        k = (s.case_id, s.column_name)
                        if k not in _existing_keys:
                            _synthesized_keys.add(k)
                            _synthesized_changes.append(s)
            else:
                if compare_new and change.current_db_value and "lookup error" not in str(change.current_db_value):
                    if str(change.current_db_value).strip().lower() == str(compare_new).strip().lower():
                        change.already_done = True
                        change.already_done_reason = f"Already set to '{change.current_db_value}'"

            # If ID resolution failed and not already done, mark as error (can't SET FK col to display string)
            if _resolve_failed and not change.already_done:
                change.error = _resolve_failed

        # Linked-case FK resolution runs even when the varchar field is already_done:
        # the visible case number and hidden FK link can drift independently.
        if (change.record_id and change.column_name
                and not change.error and not change.is_terminate_workflow
                and not change.is_delete_action
                and change.module in _LINKED_CASE_FIELDS
                and change.column_name in _LINKED_CASE_FIELDS.get(change.module, {})):
            _fk_syn = await _resolve_linked_case_fk(change, pool)
            _existing_keys = {(c.case_id, c.column_name) for c in changes} | _synthesized_keys
            for s in _fk_syn:
                k = (s.case_id, s.column_name)
                if k not in _existing_keys:
                    _synthesized_keys.add(k)
                    _synthesized_changes.append(s)

    # Append synthesized changes from context deps and linked-case FK resolution.
    # Re-check after the full pass because an explicit spreadsheet field may have
    # resolved after an earlier synthesized candidate was queued.
    explicit_keys = {(c.case_id, c.column_name) for c in changes if c.column_name}
    appended_keys = set()
    for synthesized in _synthesized_changes:
        key = (synthesized.case_id, synthesized.column_name)
        if key in explicit_keys or key in appended_keys:
            continue
        appended_keys.add(key)
        changes.append(synthesized)
    return changes


def _build_debug_log(changes: list[ChangeRow], elapsed_ms: float) -> str:
    """Build the debug log section appended at the end of the SQL file."""
    all_entries = []
    for c in changes:
        all_entries.extend(c.debug_entries)

    if not all_entries:
        return ""

    log_body = "\n  ".join(all_entries)
    return f"\n\n/* MERIDIAN Resolution Log (total: {elapsed_ms:.0f}ms)\n  {log_body}\n*/\n"


def _distinct_case_count(changes: list[ChangeRow]) -> int:
    return len({c.case_id for c in changes if c.case_id and c.case_id != "__template__"})


def _field_update_count(changes: list[ChangeRow]) -> int:
    return sum(
        1
        for c in changes
        if not c.error
        and not c.already_done
        and c.record_id
        and c.column_name
        and not c.is_delete_action
        and not c.is_terminate_workflow
        and not (c.column_name or "").startswith("#")
    )


@router.post("/generate", response_model=GenerateResponse)
async def generate_sql(body: GenerateRequest, request: Request):
    import time as _time
    t_start = _time.perf_counter()
    changes = await _auto_resolve(body.changes, request, debug=body.debug)
    blocks = generate_blocks(changes)
    elapsed_ms = (_time.perf_counter() - t_start) * 1000

    updates = sum(1 for b in blocks if "UPDATE" in b.sql)
    skipped = sum(1 for b in blocks if b.already_done)
    errors = sum(1 for b in blocks if "ERROR" in b.sql and not b.already_done)

    return GenerateResponse(
        blocks=blocks,
        total=len(blocks),
        updates=updates,
        skipped=skipped,
        errors=errors,
    )


@router.post("/generate/download")
async def download_sql(body: GenerateRequest, request: Request):
    import time as _time
    t_start = _time.perf_counter()
    changes = await _auto_resolve(body.changes, request, debug=body.debug)
    blocks = generate_blocks(changes)
    elapsed_ms = (_time.perf_counter() - t_start) * 1000

    updates = _field_update_count(changes)
    skipped = sum(1 for b in blocks if b.already_done)

    header = generate_file_header(_distinct_case_count(changes), updates, skipped, blocks=blocks, source_file=body.source_file)
    full_sql = header + "\n".join(b.sql for b in blocks)

    if body.debug:
        full_sql += _build_debug_log(changes, elapsed_ms)

    return PlainTextResponse(
        content=full_sql,
        media_type="text/plain",
        headers={"Content-Disposition": 'attachment; filename="meridian_updates.sql"'},
    )


async def _generate_case_list_sql_response(
    request: Request,
    *,
    case_ids: list[str],
    extras: list[dict],
    module: str,
    source_file: str | None,
) -> PlainTextResponse:
    """Generate bulk SQL for a case list plus uniform ticket-level fields."""
    import time as _time

    if not case_ids:
        return PlainTextResponse("/* No case IDs found in file */", media_type="text/plain")
    if not extras:
        return PlainTextResponse("/* extra_fields required */", media_type="text/plain")

    t_start = _time.perf_counter()
    pool = getattr(request.app.state, "active_pool", None)
    mapper: FieldMapper = request.app.state.field_mapper
    cfg = get_config(module)
    if not cfg:
        return PlainTextResponse(f"/* Unknown module: {module} */", media_type="text/plain")

    id_map = await bulk_find_record_ids(pool, module, case_ids) if pool else {}
    record_ids = [id_map[cid] for cid in case_ids if cid in id_map]

    from services.terminate_workflow_registry import is_terminate_workflow as _is_tw
    tw_fields = [ef for ef in extras if _is_tw(ef.get("field_name", ""), ef.get("new_value", ""))]
    reg_fields = [ef for ef in extras if not _is_tw(ef.get("field_name", ""), ef.get("new_value", ""))]

    # Resolve uniform field values once, in ticket order. batch_values carries
    # display values by UI field and resolved IDs by column so dependent calcs
    # such as Sub Category <- Category and Status Reason <- Status resolve fast.
    batch_values: dict[str, str] = {}
    first_case_id = case_ids[0] if case_ids else ""
    first_record_id = record_ids[0] if record_ids else None
    resolved_fields: list[ChangeRow] = []
    _calc_overrides = _load_calc_expression_overrides()
    for ef in reg_fields:
        field_name = str(ef.get("field_name") or "").strip()
        new_value_raw = ef.get("new_value")
        if not field_name or new_value_raw is None:
            continue
        new_value = str(new_value_raw)
        mapping = mapper.find_for_module(module, field_name)
        if not mapping:
            continue

        change = ChangeRow(
            row_num=0,
            module=module,
            case_id="__template__",
            field_name=field_name,
            new_value=new_value,
            column_name=mapping.column_name,
            table_name=cfg["table"],
            audit_label=ef.get("label"),
        )
        if mapping.ref_table and mapping.ref_id_col and mapping.ref_desc_col:
            change.ref_table = mapping.ref_table
            change.ref_id_col = mapping.ref_id_col
            change.ref_desc_col = mapping.ref_desc_col

        if pool and (mapping.calc_expression or mapping.ref_table):
            change.new_value_display = new_value
            resolved = None
            selected_calc = _select_calc_expression(
                mapping.calc_expression, change, batch_values, _calc_overrides
            )
            if selected_calc:
                resolved = await resolve_via_calc_expression(
                    pool,
                    selected_calc,
                    new_value,
                    field_name,
                    first_case_id,
                    batch_values,
                    record_id=first_record_id,
                ) if first_record_id else None
            if not resolved and mapping.ref_table and mapping.ref_id_col and mapping.ref_desc_col:
                resolved = await resolve_new_value_id(
                    pool,
                    mapping.ref_table,
                    mapping.ref_id_col,
                    mapping.ref_desc_col,
                    new_value,
                    lov_expression=mapping.lov_expression,
                    module=module,
                    case_id=first_case_id,
                )
            if resolved and not str(resolved).startswith("__AMBIGUOUS__"):
                change.new_value = str(resolved)
            elif not resolved and (mapping.calc_expression or mapping.ref_table):
                change.error = f"Could not resolve '{new_value}' for '{field_name}'"

        # Preserve display values for #FieldName# calc placeholders and resolved
        # IDs for downstream column-based substitutions.
        batch_values[field_name] = new_value
        if change.column_name:
            batch_values[change.column_name] = str(change.new_value or "")
        resolved_fields.append(change)

    from services.case_lookup import table_has_update_datetime as _has_update_datetime
    has_update_datetime = await _has_update_datetime(pool, cfg["table"]) if pool else True

    changes: list[ChangeRow] = []
    row_num = 1
    for cid in case_ids:
        record_id = id_map.get(cid)
        if not record_id:
            continue
        for template in resolved_fields:
            change = template.model_copy()
            change.row_num = row_num
            change.case_id = cid
            change.record_id = record_id
            change.has_update_datetime = has_update_datetime
            row_num += 1
            changes.append(change)
        if tw_fields:
            changes.append(ChangeRow(
                row_num=row_num,
                module=module,
                case_id=cid,
                record_id=record_id,
                field_name="Terminate Workflow",
                new_value="Y",
                column_name="#action:terminate_workflow",
                table_name=cfg["table"],
                is_terminate_workflow=True,
                terminate_workflow_pid="bulk",
                has_update_datetime=has_update_datetime,
            ))
            row_num += 1

    if not changes:
        return PlainTextResponse("/* No changes to generate */", media_type="text/plain")

    blocks = generate_blocks(changes)
    elapsed_ms = (_time.perf_counter() - t_start) * 1000
    updates = _field_update_count(changes)
    skipped = sum(1 for b in blocks if b.already_done)

    header = generate_file_header(_distinct_case_count(changes), updates, skipped, blocks=blocks, source_file=source_file)
    full_sql = header + "\n".join(b.sql for b in blocks)
    full_sql += f"\n/* MERIDIAN bulk case-list generation completed in {elapsed_ms:.0f} ms */\n"

    return PlainTextResponse(
        content=full_sql,
        media_type="text/plain",
        headers={"Content-Disposition": 'attachment; filename="meridian_updates.sql"'},
    )


@router.post("/generate/from-spreadsheet")
async def generate_from_spreadsheet(
    request: Request,
    file: UploadFile = File(...),
    extra_fields: str = Form(default=""),   # JSON: [{"field_name": "Status", "new_value": "Overturned"}, ...]
    ticket_text: str = Form(default=""),     # Jira text used to derive uniform fields for spreadsheet case lists
    module_override: str = Form(default=""),
):
    """Upload a spreadsheet and get SQL back in one shot — no JSON body size limit.

    extra_fields: optional JSON array of {field_name, new_value} to apply to every
                  case in the spreadsheet (uniform ticket-level overrides).
    ticket_text: optional Jira text. When no explicit extra_fields are supplied,
                 Meridian attempts to extract ticket-level fields and applies them
                 to every case in the spreadsheet.
    module_override: force a specific module key if auto-detection is wrong.
    """
    from services.spreadsheet_parser import extract_case_ids, infer_module_from_case_ids, parse_spreadsheet
    import time as _time
    import json as _json

    content = await file.read()
    mapper = request.app.state.field_mapper
    detected_module, rows = parse_spreadsheet(content, mapper=mapper, context_text=ticket_text)

    effective_module = module_override.strip() or detected_module

    # Collect unique case IDs from the spreadsheet (in order)
    from collections import OrderedDict as _OD
    case_ids = list(_OD.fromkeys(r.case_id for r in rows if r.case_id))
    if not case_ids and (ticket_text.strip() or extra_fields.strip()):
        case_ids = extract_case_ids(content)
    if not effective_module and case_ids:
        effective_module = infer_module_from_case_ids(case_ids, detected_module)

    # If the Jira text supplies uniform ticket-level updates, treat the
    # spreadsheet as a case list and ignore any parsed spreadsheet values.
    if not extra_fields.strip() and ticket_text.strip() and case_ids:
        try:
            from services.text_extra_fields import extract_ticket_extra_fields
            ticket_fields = extract_ticket_extra_fields(ticket_text, mapper, effective_module)
            if ticket_fields:
                extra_fields = _json.dumps([
                    {"field_name": f.field_name, "new_value": f.new_value}
                    for f in ticket_fields
                ])
        except Exception as _e:
            return PlainTextResponse(f"/* ticket_text parse error: {_e} */", media_type="text/plain")

    if not rows and not extra_fields.strip():
        return PlainTextResponse("/* No rows parsed from spreadsheet */", media_type="text/plain")

    # When extra_fields are provided, use ONLY those fields for all cases —
    # the spreadsheet is used solely as a source of case IDs.
    # When no extra_fields, use the parsed rows as-is (standard spreadsheet mode).
    if extra_fields.strip():
        if not case_ids:
            return PlainTextResponse("/* No case IDs parsed from spreadsheet */", media_type="text/plain")
        try:
            extras = _json.loads(extra_fields)
        except Exception as _e:
            return PlainTextResponse(f"/* extra_fields parse error: {_e} */", media_type="text/plain")
        return await _generate_case_list_sql_response(
            request,
            case_ids=case_ids,
            extras=extras,
            module=effective_module or "",
            source_file=file.filename,
        )
    else:
        changes: list[ChangeRow] = [
            ChangeRow(
                row_num=r.row_num,
                module=module_override.strip() or r.module or effective_module or "",
                case_id=r.case_id,
                field_name=r.field_name,
                old_value=r.old_value,
                new_value=r.new_value,
                reason=r.reason,
                revision=r.revision,
                semantic_context=r.semantic_context,
            )
            for r in rows
            if r.case_id and r.field_name
        ]

    if not changes:
        return PlainTextResponse("/* No changes to generate */", media_type="text/plain")

    t_start = _time.perf_counter()
    changes = await _auto_resolve(changes, request)
    blocks = generate_blocks(changes)
    elapsed_ms = (_time.perf_counter() - t_start) * 1000

    updates = _field_update_count(changes)
    skipped = sum(1 for b in blocks if b.already_done)

    header = generate_file_header(_distinct_case_count(changes), updates, skipped, blocks=blocks, source_file=file.filename)
    full_sql = header + "\n".join(b.sql for b in blocks)

    fname = file.filename.replace(".xlsx", ".sql").replace(".xls", ".sql") if file.filename else "meridian_updates.sql"
    return PlainTextResponse(
        content=full_sql,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.post("/generate/from-case-list")
async def generate_from_case_list(
    request: Request,
    file: UploadFile = File(...),        # plain text, one case ID per line
    extra_fields: str = Form(default=""), # JSON: [{"field_name":..., "new_value":...}, ...]
    module: str = Form(default=""),       # module key e.g. provider_appeals_mgmt
    skip_check: str = Form(default=""),   # "1" or "true" → skip current DB value lookup (faster)
):
    """Accept a plain-text case ID list (one per line) + uniform field overrides.
    Tiny payload — no spreadsheet size bottleneck.
    """
    import json as _json

    content = (await file.read()).decode("utf-8", errors="ignore")
    case_ids = [line.strip() for line in content.splitlines() if line.strip()]
    if not case_ids:
        return PlainTextResponse("/* No case IDs found in file */", media_type="text/plain")

    if not extra_fields.strip():
        return PlainTextResponse("/* extra_fields required */", media_type="text/plain")

    try:
        extras = _json.loads(extra_fields)
    except Exception as _e:
        return PlainTextResponse(f"/* extra_fields JSON parse error: {_e} */", media_type="text/plain")

    return await _generate_case_list_sql_response(
        request,
        case_ids=case_ids,
        extras=extras,
        module=module,
        source_file=file.filename,
    )


@router.get("/modules")
async def get_modules():
    return all_modules()
