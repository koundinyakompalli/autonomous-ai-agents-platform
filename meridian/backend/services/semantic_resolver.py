from __future__ import annotations

import os
from datetime import date, datetime
from typing import Any

import yaml

from models.schemas import ChangeRow


def _config_path() -> str:
    return os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "config", "semantic_resolution.yaml")
    )


def _load_config() -> dict[str, list[dict[str, Any]]]:
    try:
        with open(_config_path(), encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return {str(k): list(v or []) for k, v in data.items()}
    except Exception:
        return {}


def _norm(value: str | None) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _value_from(change: ChangeRow, key: str | None) -> str | None:
    if not key:
        return None
    if key in (change.semantic_context or {}):
        value = change.semantic_context[key]
        return str(value).strip() if value not in (None, "") else None
    if key.startswith("context."):
        value = (change.semantic_context or {}).get(key.split(".", 1)[1])
        return str(value).strip() if value not in (None, "") else None
    value = getattr(change, key, None)
    return str(value).strip() if value not in (None, "") else None


def _fmt_db_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d 00:00:00")
    return str(value)


def _sql_literal(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


async def _lookup_ref_value(
    pool,
    ref_cfg: dict[str, Any] | None,
    display_value: str | None,
) -> tuple[Any | None, str | None]:
    if not ref_cfg or not display_value:
        return display_value, None

    table = str(ref_cfg.get("table") or "").strip()
    id_col = str(ref_cfg.get("id_col") or "").strip()
    desc_col = str(ref_cfg.get("desc_col") or "").strip()
    if not table or not id_col or not desc_col:
        return None, "Semantic fallback reference lookup is misconfigured"

    rows = await _fetchall(
        pool,
        f"SELECT `{id_col}`, `{desc_col}` FROM `{table}` "
        f"WHERE LOWER(TRIM(`{desc_col}`)) = LOWER(TRIM(%s)) LIMIT 2",
        (display_value,),
    )
    if len(rows) != 1:
        return None, (
            f"Semantic fallback: expected one `{table}` row for '{display_value}', "
            f"found {len(rows)}"
        )
    return rows[0][0], None


async def _lookup_display_by_id(
    pool,
    lookup_cfg: dict[str, Any] | None,
    raw_id: Any,
) -> str | None:
    if not lookup_cfg or raw_id is None:
        return None
    table = str(lookup_cfg.get("table") or "").strip()
    id_col = str(lookup_cfg.get("id_col") or "").strip()
    desc_col = str(lookup_cfg.get("desc_col") or "").strip()
    if not table or not id_col or not desc_col:
        return None
    rows = await _fetchall(
        pool,
        f"SELECT `{desc_col}` FROM `{table}` WHERE `{id_col}` = %s LIMIT 1",
        (raw_id,),
    )
    if rows:
        return _fmt_db_value(rows[0][0])
    return None


async def _fetchall(pool, sql: str, params: tuple[Any, ...]) -> tuple[tuple[Any, ...], ...]:
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql, params)
            return tuple(await cur.fetchall())


def _find_rule(change: ChangeRow) -> dict[str, Any] | None:
    rules = _load_config().get(change.module) or []
    field = _norm(change.field_name)
    for rule in rules:
        aliases = {_norm(rule.get("semantic_field"))}
        aliases.update(_norm(a) for a in rule.get("field_aliases", []))
        if field in aliases:
            return rule
    return None


def _manual_sql(
    *,
    target_table: str,
    target_pk: str,
    target_column: str,
    match_col: str,
    match_value: str | None,
    parent_case: str | None,
    parent_cfg: dict[str, Any] | None,
) -> str:
    select_cols = []
    for col in (target_pk, match_col, target_column):
        if col and col not in select_cols:
            select_cols.append(col)
    select_expr = ", ".join(f"`{col}`" for col in select_cols)
    lines = [
        "/* Semantic fallback manual-review evidence */",
        f"SELECT {select_expr}",
        f"FROM `{target_table}`",
        f"WHERE `{match_col}` = {_sql_literal(match_value)};",
    ]
    for candidate in (parent_cfg or {}).get("candidates", []):
        table = candidate.get("table")
        pk = candidate.get("pk", "id")
        case_col = candidate.get("case_col")
        if table and case_col:
            lines.extend([
                "",
                f"SELECT `{pk}`, `{case_col}`",
                f"FROM `{table}`",
                f"WHERE `{case_col}` = {_sql_literal(parent_case)};",
            ])
    lines.append("")
    return "\n".join(lines)


async def resolve_semantic_fallback(change: ChangeRow, pool) -> bool:
    """Resolve configured semantic rows after deterministic field mapping misses.

    This is intentionally bounded: the rule supplies the only allowed target
    table/column and matching strategy. LLM or parser output may normalize row
    context, but this function performs deterministic DB checks before SQL is
    generated.
    """
    rule = _find_rule(change)
    if not rule:
        return False

    if not pool:
        change.error = "Semantic fallback requires an active DB connection"
        return True

    target_module = str(rule.get("target_module") or rule.get("target_table") or "").strip()
    target_table = str(rule.get("target_table") or "").strip()
    target_pk = str(rule.get("target_pk") or "id").strip()
    target_column = str(rule.get("target_column") or "").strip()
    match_cfg = rule.get("match") or {}
    match_col = str(match_cfg.get("column") or "").strip()
    match_value = _value_from(change, match_cfg.get("context_key") or match_cfg.get("value_from"))
    match_db_value = match_value
    parent_cfg = rule.get("parent") or {}
    parent_case = _value_from(change, parent_cfg.get("case_from") or "case_id")
    value_lookup_cfg = rule.get("value_lookup") or {}

    if not target_module or not target_table or not target_column or not match_col:
        change.error = f"Semantic fallback for '{change.field_name}' is misconfigured"
        return True
    if not match_value:
        context_key = match_cfg.get("context_key") or match_cfg.get("value_from")
        change.error = (
            f"Semantic fallback for '{change.field_name}' needs "
            f"'{context_key}' context"
        )
        return True

    if match_cfg.get("reference"):
        match_db_value, ref_error = await _lookup_ref_value(
            pool,
            match_cfg.get("reference"),
            match_value,
        )
        if ref_error:
            change.error = ref_error
            change.manual_review_sql = _manual_sql(
                target_table=target_table,
                target_pk=target_pk,
                target_column=target_column,
                match_col=match_col,
                match_value=match_value,
                parent_case=parent_case,
                parent_cfg=parent_cfg,
            )
            return True

    member_match_cfg = parent_cfg.get("member_match") or {}
    parent_member_col = str(member_match_cfg.get("parent_col") or "").strip()
    target_member_col = str(member_match_cfg.get("target_col") or "").strip()

    parent_matches: list[tuple[dict[str, Any], Any, dict[str, Any]]] = []
    for candidate in parent_cfg.get("candidates", []):
        table = candidate.get("table")
        pk = candidate.get("pk", "id")
        case_col = candidate.get("case_col")
        if not table or not case_col or not parent_case:
            continue
        select_cols = [str(pk)]
        if parent_member_col and parent_member_col not in select_cols:
            select_cols.append(parent_member_col)
        select_expr = ", ".join(f"`{col}`" for col in select_cols)
        rows = await _fetchall(
            pool,
            f"SELECT {select_expr} FROM `{table}` WHERE `{case_col}` = %s LIMIT 2",
            (parent_case,),
        )
        if len(rows) == 1:
            meta = {}
            if parent_member_col and len(rows[0]) > 1:
                meta[parent_member_col] = rows[0][1]
            parent_matches.append((candidate, rows[0][0], meta))
        elif len(rows) > 1:
            change.error = (
                f"Semantic fallback: parent case '{parent_case}' matches multiple "
                f"rows in `{table}`"
            )
            change.manual_review_sql = _manual_sql(
                target_table=target_table,
                target_pk=target_pk,
                target_column=target_column,
                match_col=match_col,
                match_value=match_value,
                parent_case=parent_case,
                parent_cfg=parent_cfg,
            )
            return True

    if parent_cfg and not parent_matches:
        change.error = f"Semantic fallback: parent case '{parent_case}' not found"
        change.manual_review_sql = _manual_sql(
            target_table=target_table,
            target_pk=target_pk,
            target_column=target_column,
            match_col=match_col,
            match_value=match_value,
            parent_case=parent_case,
            parent_cfg=parent_cfg,
        )
        return True
    if len(parent_matches) > 1:
        hits = ", ".join(f"{c['table']}.{c.get('pk', 'id')}={pk}" for c, pk, _ in parent_matches)
        change.error = f"Semantic fallback: parent case '{parent_case}' is ambiguous ({hits})"
        change.manual_review_sql = _manual_sql(
            target_table=target_table,
            target_pk=target_pk,
            target_column=target_column,
            match_col=match_col,
            match_value=match_value,
            parent_case=parent_case,
            parent_cfg=parent_cfg,
        )
        return True

    target_rows: tuple[tuple[Any, ...], ...]
    if parent_matches:
        parent_candidate, parent_id, parent_meta = parent_matches[0]
        fk_col = parent_candidate.get("target_fk_col")
        if not fk_col:
            change.error = f"Semantic fallback parent candidate for '{parent_case}' lacks target_fk_col"
            return True
        target_rows = await _fetchall(
            pool,
            f"SELECT `{target_pk}`, `{target_column}` FROM `{target_table}` "
            f"WHERE `{match_col}` = %s AND `{fk_col}` = %s LIMIT 2",
            (match_db_value, parent_id),
        )
        if not target_rows and parent_member_col and target_member_col and parent_meta.get(parent_member_col) is not None:
            target_rows = await _fetchall(
                pool,
                f"SELECT `{target_pk}`, `{target_column}` FROM `{target_table}` "
                f"WHERE `{match_col}` = %s AND `{target_member_col}` = %s LIMIT 2",
                (match_db_value, parent_meta[parent_member_col]),
            )
        if not target_rows:
            file_rows = await _fetchall(
                pool,
                f"SELECT `{target_pk}`, `{target_column}` FROM `{target_table}` "
                f"WHERE `{match_col}` = %s LIMIT 5",
                (match_db_value,),
            )
            if file_rows:
                change.error = (
                    f"Semantic fallback: `{target_table}` row for '{match_value}' "
                    f"does not belong to parent case '{parent_case}'"
                )
            else:
                change.error = f"Semantic fallback: no `{target_table}` row found for '{match_value}'"
            change.manual_review_sql = _manual_sql(
                target_table=target_table,
                target_pk=target_pk,
                target_column=target_column,
                match_col=match_col,
                match_value=match_value,
                parent_case=parent_case,
                parent_cfg=parent_cfg,
            )
            return True
    else:
        target_rows = await _fetchall(
            pool,
            f"SELECT `{target_pk}`, `{target_column}` FROM `{target_table}` "
            f"WHERE `{match_col}` = %s LIMIT 2",
            (match_db_value,),
        )

    if len(target_rows) != 1:
        change.error = (
            f"Semantic fallback: expected one `{target_table}` row for '{match_value}', "
            f"found {len(target_rows)}"
        )
        change.manual_review_sql = _manual_sql(
            target_table=target_table,
            target_pk=target_pk,
            target_column=target_column,
            match_col=match_col,
            match_value=match_value,
            parent_case=parent_case,
            parent_cfg=parent_cfg,
        )
        return True

    target_id, current_value = target_rows[0]
    if value_lookup_cfg:
        resolved_new_value, value_error = await _lookup_ref_value(
            pool,
            value_lookup_cfg,
            change.new_value,
        )
        if value_error:
            change.error = value_error
            change.manual_review_sql = _manual_sql(
                target_table=target_table,
                target_pk=target_pk,
                target_column=target_column,
                match_col=match_col,
                match_value=match_value,
                parent_case=parent_case,
                parent_cfg=parent_cfg,
            )
            return True
        change.new_value_display = change.new_value
        change.new_value = str(resolved_new_value)
        current_display = await _lookup_display_by_id(pool, value_lookup_cfg, current_value)
    else:
        current_display = None

    change.module = target_module
    change.table_name = target_table
    change.record_id = int(target_id)
    change.column_name = target_column
    change.current_db_value = current_display or _fmt_db_value(current_value)
    if not change.new_value_display:
        change.new_value_display = change.new_value
    change.audit_label = str(rule.get("audit_label") or change.field_name)
    change.has_update_datetime = True
    if value_lookup_cfg:
        change.ref_table = str(value_lookup_cfg.get("table") or "") or None
        change.ref_id_col = str(value_lookup_cfg.get("id_col") or "") or None
        change.ref_desc_col = str(value_lookup_cfg.get("desc_col") or "") or None
    return True
