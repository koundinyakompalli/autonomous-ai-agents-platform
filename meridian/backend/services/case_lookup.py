from __future__ import annotations

import os
from db.connection import MeridianConnectorPool

from services.module_detector import get_config
from services.field_mapper import FieldMapper


def _load_phi_columns() -> frozenset[str]:
    """Load PHI column names from config/phi_columns.yaml.
    Returns a flat frozenset of lowercase column names (table-agnostic) so any
    column with that name — on any table — is masked.
    Falls back to empty set if file is missing or unreadable.
    """
    config_path = os.path.join(os.path.dirname(__file__), "..", "config", "phi_columns.yaml")
    try:
        import yaml
        with open(os.path.normpath(config_path), encoding="utf-8") as f:
            data = yaml.safe_load(f)
        cols: set[str] = set()
        for table_cols in data.values():
            if isinstance(table_cols, list):
                cols.update(c.lower() for c in table_cols if c)
        return frozenset(cols)
    except Exception as e:
        print(f"Warning: could not load phi_columns.yaml: {e}")
        return frozenset()


# PHI column names loaded from config/phi_columns.yaml.
# get_current_value() masks these to '<PHI>' — they never appear in SQL output.
# generate.py blocks SET clauses targeting these columns.
# To add/remove PHI fields edit config/phi_columns.yaml — no code change needed.
PHI_COLUMNS: frozenset[str] = _load_phi_columns()


async def find_record_id(pool: MeridianConnectorPool, module: str, case_id: str, revision: int | None) -> int | None:
    """Return the PK of the case record.

    H-prefix ambiguity:
    - With revision  → auth_review.review_number + revision
    - Without revision:
        1. Try authorizations.auth_number first
        2. Fall back to auth_review.review_number (latest revision)
    """
    cfg = get_config(module)
    if not cfg:
        return None
    table = cfg["table"]
    id_col = cfg.get("id_col")
    pk = cfg["pk"]

    if not id_col:
        return None

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if module == "auth_review":
                if revision is not None:
                    # Try auth_review.review_number + revision first
                    await cur.execute(
                        f"SELECT `{pk}` FROM `{table}` WHERE `{id_col}` = %s AND `revision` = %s LIMIT 1",
                        (case_id, revision),
                    )
                    row = await cur.fetchone()
                    if row:
                        return row[0]
                    # review_number not found — case_id may be authorizations.auth_number
                    # Look up authorization_id then find auth_review by authorization_id + revision
                    await cur.execute(
                        "SELECT `id` FROM `authorizations` WHERE `auth_number` = %s LIMIT 1",
                        (case_id,),
                    )
                    row = await cur.fetchone()
                    if row:
                        auth_id = row[0]
                        await cur.execute(
                            f"SELECT `{pk}` FROM `{table}` WHERE `authorization_id` = %s AND `revision` = %s LIMIT 1",
                            (auth_id, revision),
                        )
                else:
                    # No revision given — try authorizations.auth_number first
                    await cur.execute(
                        "SELECT `id` FROM `authorizations` WHERE `auth_number` = %s LIMIT 1",
                        (case_id,),
                    )
                    row = await cur.fetchone()
                    if row:
                        # Found in authorizations — caller should use "authorizations" module
                        # Return negative sentinel to signal this
                        return -row[0]
                    # Fall back to auth_review (latest revision)
                    await cur.execute(
                        f"SELECT `{pk}` FROM `{table}` WHERE `{id_col}` = %s ORDER BY revision DESC LIMIT 1",
                        (case_id,),
                    )
            else:
                # Try the configured id_col first; fall back to known client schema
                # variations (e.g. appeals_no vs appeal_no differs across clients)
                id_col_alternatives = {
                    "appeals_no": ["appeals_no", "appeal_no"],
                    "appeal_no":  ["appeal_no", "appeals_no"],
                }.get(id_col, [id_col])
                for col_try in id_col_alternatives:
                    try:
                        await cur.execute(
                            f"SELECT `{pk}` FROM `{table}` WHERE `{col_try}` = %s LIMIT 1",
                            (case_id,),
                        )
                        row = await cur.fetchone()
                        if row:
                            return row[0]
                    except Exception:
                        continue
                return None
            row = await cur.fetchone()
            return row[0] if row else None


async def get_current_value(
    pool: MeridianConnectorPool,
    module: str,
    record_id: int,
    column: str,
    ref_table: str | None = None,
    ref_id_col: str | None = None,
    ref_desc_col: str | None = None,
    table_name: str | None = None,
) -> tuple[str | None, str | None]:
    """Returns (raw_value, display_value).
    PHI columns are masked to '<PHI>' and never returned as real values.

    table_name overrides the module's default table — used when the field lives
    on a child table (e.g. der_child) with its own PK already in record_id.
    """
    cfg = get_config(module)

    # PHI column — never read the real value. Return a SQL subquery token that
    # the sql_generator will embed directly in the audit log CONCAT so the DB
    # resolves the old value at INSERT time without the tool ever seeing it.
    if column.lower() in PHI_COLUMNS:
        if cfg:
            phi_subquery = (
                f"__PHI_SUBQUERY__:(SELECT COALESCE(CAST(`{column}` AS CHAR), 'NULL') "
                f"FROM `{cfg['table']}` WHERE `{cfg['pk']}` = {record_id})"
            )
        else:
            phi_subquery = "__PHI_SUBQUERY__:(SELECT 'N/A')"
        return phi_subquery, phi_subquery

    if not cfg:
        return None, None

    # Use overridden table_name when the field is on a child/related table.
    # In that case record_id is already the child row PK so we use 'id' as PK.
    if table_name and table_name != cfg["table"]:
        table = table_name
        pk = "id"
    else:
        table = cfg["table"]
        pk = cfg["pk"]

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(f"SELECT `{column}` FROM `{table}` WHERE `{pk}` = %s", (record_id,))
            row = await cur.fetchone()
            if not row:
                return None, None
            raw = row[0]
            raw_str = str(raw) if raw is not None else None

            # Resolve display value from reference table
            if raw is not None and ref_table and ref_id_col and ref_desc_col:
                try:
                    await cur.execute(
                        f"SELECT `{ref_desc_col}` FROM `{ref_table}` WHERE `{ref_id_col}` = %s",
                        (raw,),
                    )
                    ref_row = await cur.fetchone()
                    display = ref_row[0] if ref_row else raw_str
                    return raw_str, str(display) if display else raw_str
                except Exception:
                    pass
            return raw_str, raw_str


async def resolve_with_parent(
    pool,
    mapping,
    new_value: str,
    batch_values: dict[str, str] | None = None,
    case_id: str | None = None,
) -> str | None:
    """Resolve a cascading field using parent_columns from cascading.csv.

    batch_values keys are column_names (not ui_names).
    Builds nested subqueries for each parent level:
      SELECT id FROM der_status_reason
      WHERE description = 'Medical Necessity'
        AND der_status_id = (SELECT id FROM der_status WHERE description = 'Approved')
    FK column convention: ref_table with last segment stripped + '_id'
      e.g. der_status_reason → FK col = der_status_id → parent table = der_status
    """
    if not mapping.ref_table or not mapping.ref_id_col or not mapping.ref_desc_col:
        return None
    if not mapping.parent_columns:
        return None

    bv = {k.lower(): v for k, v in (batch_values or {}).items()}

    # Only use the first (closest) parent for the WHERE clause
    # Multi-level parents are resolved transitively via the parent's own query
    parent_col = mapping.parent_columns[0]
    parent_value = bv.get(parent_col)
    if not parent_value:
        return None

    # Derive FK column and parent table from ref_table naming convention
    # der_status_reason → fk_col=der_status_id, parent_table=der_status
    parts = mapping.ref_table.rsplit("_", 1)
    fk_col = parts[0] + "_id" if len(parts) == 2 else mapping.ref_table + "_id"
    parent_table = fk_col[:-3]  # strip _id

    sql = f"""
        SELECT `{mapping.ref_id_col}` FROM `{mapping.ref_table}`
        WHERE `{mapping.ref_desc_col}` = %s
          AND `{fk_col}` = (SELECT `{mapping.ref_id_col}` FROM `{parent_table}`
                            WHERE `{mapping.ref_desc_col}` = %s LIMIT 1)
        LIMIT 1
    """
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, (new_value, parent_value))
                row = await cur.fetchone()
                return str(row[0]) if row and row[0] is not None else None
    except Exception:
        return None


async def resolve_via_calc_expression(
    pool,
    calc_expression: str,
    new_value: str,
    field_name: str,
    case_id: str,
    batch_values: dict[str, str] | None = None,
    record_id: int | None = None,
) -> str | None:
    """
    Execute a data_loader_config calc_expression to resolve a display value → ID.

    Placeholder substitution:
      #FieldName#  → new_value for that field (this field or another in the same batch)
      #DER No#, #Grievance No#, etc. → case_id
    """
    import re

    # Strip carriage-return artifacts (_x000D_) that appear when calc_expressions
    # are exported from Excel to CSV and re-imported — they break placeholder substitution
    calc_expression = calc_expression.replace("_x000D_", "").replace("\r", "")

    # Build substitution maps. Exact keys must win so #status# (numeric column)
    # and #Status# (display field) do not collide.
    subs_exact: dict[str, str] = {}
    subs_lower: dict[str, str] = {}
    if batch_values:
        for k, v in batch_values.items():
            subs_exact[str(k)] = str(v)
            subs_lower.setdefault(str(k).lower(), str(v))
    subs_exact[field_name] = str(new_value)
    subs_lower[field_name.lower()] = str(new_value)

    def _replace(m: re.Match) -> str:
        raw_key = m.group(1).strip()
        key = raw_key.lower()
        if raw_key in subs_exact:
            return subs_exact[raw_key].replace("'", "''")
        if key in subs_lower:
            return subs_lower[key].replace("'", "''")
        # Case ID placeholders: "der no", "grievance no", "appeal no", etc.
        if key in ("der no", "grievance no", "appeal no", "case no", "auth reference",
                   "review number", "auth number", "ire no", "ctm no", "referral number",
                   "provider appeal no", "provider appeals no"):
            return case_id.replace("'", "''")
        return m.group(0)  # leave unknown placeholders as-is

    sql = re.sub(r'#([^#]+)#', _replace, calc_expression)

    # Replace d.der_no = 'case_id' with d.id = record_id wherever it appears —
    # avoids full table scan on unindexed der_no column.
    if record_id:
        sql = re.sub(
            r"(\w+)\.der_no\s*=\s*'" + re.escape(str(case_id)) + r"'",
            lambda m: f"{m.group(1)}.id = {record_id}",
            sql, flags=re.IGNORECASE
        )

    # Replace d.status_reason with the resolved new value when status_reason is changing
    # in the same batch — so letter template calc uses the new status_reason, not current DB value.
    if batch_values:
        new_sr = (batch_values.get("status_reason") or batch_values.get("Status Reason"))
        if new_sr and str(new_sr).lstrip("-").isdigit():
            sql = re.sub(
                r'\b(\w+)\.status_reason\b',
                new_sr,
                sql, flags=re.IGNORECASE
            )

    # Some calcs use a direct DB subquery for request_type instead of a placeholder,
    # e.g. (select d.request_type from der d where d.der_no = '...')
    # When batch_values has the new request_type ID, substitute that subquery so the
    # calc resolves against the new value rather than the current DB value.
    if batch_values:
        new_rt = (batch_values.get("request_type") or
                  batch_values.get("Request Type") or
                  batch_values.get("requesttype"))
        # Only substitute if it's a resolved numeric ID — display strings like
        # "Redetermination" are invalid SQL and will break the calc query.
        if new_rt and not str(new_rt).lstrip("-").isdigit():
            new_rt = None
        if new_rt:
            # Replace subquery with der_no form (original)
            sql = re.sub(
                r"\(\s*select\s+\w+\.request_type\s+from\s+der\s+\w+\s+where\s+\w+\.der_no\s*=\s*'[^']*'\s*\)",
                new_rt,
                sql, flags=re.IGNORECASE
            )
            # Also replace after der_no→der.id substitution: (select d.request_type from der d where d.id = 12345)
            if record_id:
                sql = re.sub(
                    r"\(\s*select\s+\w+\.request_type\s+from\s+der\s+\w+\s+where\s+\w+\.id\s*=\s*" + str(record_id) + r"\s*\)",
                    new_rt,
                    sql, flags=re.IGNORECASE
                )
            # Also replace cd.request_type_id = d.request_type patterns in WHERE clause
            # This handles: AND cd.request_type_id = d.request_type (from INNER JOIN der d)
            if record_id:
                sql = re.sub(
                    r'(cd\.request_type_id\s*=\s*)(\w+)\.request_type\b',
                    lambda m: f"{m.group(1)}{new_rt}",
                    sql, flags=re.IGNORECASE
                )
        # When #RequestReason# is missing from batch_values (field unchanged old=new),
        # substitute it with the current DB cdtype_id's rt=new_request_type equivalent
        # so Classification resolves against the correct (new) request_type.
        # The calc uses: cd.id=(SELECT COALESCE((SELECT id FROM cdtype WHERE description='#RequestReason#' ...
        # If #RequestReason# was not substituted (still a placeholder), leave it — the
        # COALESCE fallback in the calc will use the current DB cdtype_id.

    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql)
                rows = await cur.fetchall()
                if not rows:
                    return None
                if len(rows) == 1:
                    return str(rows[0][0]) if rows[0][0] is not None else None
                if record_id and "note_type_context" in sql.lower():
                    escaped_new_value = str(new_value).replace("'", "''")
                    scoped_sql = f"""
                        SELECT note_candidate.ID,
                               note_candidate.description,
                               note_candidate.note_type_context_id,
                               note_candidate.specificity
                        FROM (
                            SELECT DISTINCT
                                   nt.ID,
                                   nt.description,
                                   `ntc`.`ID` AS note_type_context_id,
                                   CASE
                                       WHEN `ntc`.`der_request_type_id` = d.request_type THEN 4
                                       WHEN `ntc`.`der_request_type_id` IS NULL
                                            OR `ntc`.`der_request_type_id` = 0 THEN 0
                                       ELSE -1
                                   END AS specificity
                            FROM note_types nt
                            INNER JOIN note_type_context ntc ON ntc.note_type_id = nt.ID
                            INNER JOIN der d ON d.id = {int(record_id)}
                            WHERE LOWER(TRIM(nt.description)) = LOWER(TRIM('{escaped_new_value}'))
                        ) note_candidate
                        WHERE note_candidate.specificity >= 0
                        ORDER BY note_candidate.specificity DESC, note_candidate.ID
                        LIMIT 10
                    """
                    await cur.execute(scoped_sql)
                    scoped_rows = await cur.fetchall()
                    if scoped_rows:
                        best_specificity = max(int(r[3] or 0) for r in scoped_rows)
                        best_rows = [r for r in scoped_rows if int(r[3] or 0) == best_specificity]
                        if best_specificity > 0 and len(best_rows) == 1 and best_rows[0][0] is not None:
                            return str(best_rows[0][0])
                # Multiple rows — return sentinel with all candidates so the caller
                # can emit them as comments instead of a broken UPDATE statement.
                candidates = "; ".join(
                    f"id={r[0]} ({', '.join(str(v) for v in r[1:] if v is not None)})"
                    for r in rows
                )
                return f"__AMBIGUOUS__:{candidates}"
    except Exception:
        return None


def _load_ref_table_filters() -> dict:
    """Load ref_table_filters.yaml — extra scoping rules for ambiguous ref lookups."""
    config_path = os.path.join(os.path.dirname(__file__), "..", "config", "ref_table_filters.yaml")
    try:
        import yaml
        with open(os.path.normpath(config_path), encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


_REF_TABLE_FILTERS: dict = {}  # populated lazily on first use


async def resolve_new_value_id(
    pool: MeridianConnectorPool,
    ref_table: str,
    ref_id_col: str,
    ref_desc_col: str,
    description: str,
    case_id: str | None = None,
    lov_expression: str | None = None,
    module: str | None = None,
) -> str | None:
    """Look up the ID for a display value in a reference table.

    When the plain lookup is ambiguous:
    1. Tries lov_expression as an IN-subquery scope (from data_loader_config_fields)
    2. Falls back to ref_table_filters.yaml rules (module-specific when available)
    3. Returns None when still ambiguous after all scoping attempts.
    """
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            try:
                await cur.execute(
                    f"SELECT `{ref_id_col}` FROM `{ref_table}` WHERE `{ref_desc_col}` = %s",
                    (description,),
                )
                rows = await cur.fetchall()

                # Some ref tables need case-context validation even when the
                # display value is unique. Example: der_status_reason values can
                # belong to a different der_status_id than the current DER case.
                if not _REF_TABLE_FILTERS:
                    _REF_TABLE_FILTERS.update(_load_ref_table_filters())
                _table_rule = _REF_TABLE_FILTERS.get(ref_table, {})
                _always_scope = _table_rule.get("always_scope", False)

                if len(rows) == 1 and not _always_scope:
                    return str(rows[0][0])

                if len(rows) > 1 and lov_expression:
                    # Ambiguous — lov_expression encodes the valid-row subquery for this field.
                    # Use it as an IN() scope: WHERE id IN (SELECT id FROM ... WHERE <lov conditions>)
                    # Strip _x000D_ artifacts and carriage returns from Excel-exported expressions.
                    lov_clean = lov_expression.replace("_x000D_", "").replace("\r", "").strip()
                    # Substitute case_id placeholder if present
                    if case_id:
                        import re as _re
                        lov_clean = _re.sub(r"#DER No#", case_id.replace("'", "''"), lov_clean, flags=_re.I)
                    lov_sql = (
                        f"SELECT `{ref_id_col}` FROM `{ref_table}` "
                        f"WHERE `{ref_desc_col}` = %s "
                        f"AND `{ref_id_col}` IN (SELECT `{ref_id_col}` FROM ({lov_clean}) _lov)"
                    )
                    try:
                        await cur.execute(lov_sql, (description,))
                        lov_rows = await cur.fetchall()
                        if len(lov_rows) == 1:
                            return str(lov_rows[0][0])
                    except Exception:
                        pass  # lov_expression may not be a standalone valid subquery — fall through

                if (len(rows) > 1 or _always_scope) and case_id:
                    # Ambiguous OR mandatory-scope table — try ref_table_filters.yaml scoping rule
                    if not _REF_TABLE_FILTERS:
                        _REF_TABLE_FILTERS.update(_load_ref_table_filters())
                    table_rule = _REF_TABLE_FILTERS.get(ref_table, {})
                    # Use module-specific rule if available, else flat rule
                    by_module = table_rule.get("_by_module", {})
                    rule = (by_module.get(module) or table_rule) if table_rule else None
                    if rule and "_by_module" in rule:
                        rule = None  # top-level entry is only a container, no flat rule
                    if rule:
                        safe_case_id = case_id.replace("'", "''")
                        context_sql = rule["context_sql"].replace("{case_id}", safe_case_id)
                        find_in_set_expr = (rule["find_in_set_expr"]
                                            .replace("{context_sql}", context_sql)
                                            .replace("{case_id}", safe_case_id))
                        null_expr = rule["null_expr"].replace("{case_id}", safe_case_id)
                        try:
                            # Priority 1: rows where applicable_request_types explicitly matches
                            scoped_sql = (
                                f"SELECT `{ref_id_col}` FROM `{ref_table}` "
                                f"WHERE `{ref_desc_col}` = %s AND {find_in_set_expr}"
                            )
                            await cur.execute(scoped_sql, (description,))
                            scoped_rows = await cur.fetchall()
                            if len(scoped_rows) == 1:
                                return str(scoped_rows[0][0])
                            # Priority 2: fallback to rows where applicable_request_types is NULL
                            # only when no explicit match was found
                            if len(scoped_rows) == 0:
                                null_sql = (
                                    f"SELECT `{ref_id_col}` FROM `{ref_table}` "
                                    f"WHERE `{ref_desc_col}` = %s AND {null_expr}"
                                )
                                await cur.execute(null_sql, (description,))
                                null_rows = await cur.fetchall()
                                if len(null_rows) == 1:
                                    return str(null_rows[0][0])
                                # Priority 3: broader fallback (e.g. ignore der_status_id for historical fields)
                                fallback_expr = rule.get("fallback_expr", "").replace("{context_sql}", context_sql).replace("{case_id}", safe_case_id)
                                if fallback_expr and len(null_rows) == 0:
                                    fallback_sql = (
                                        f"SELECT `{ref_id_col}` FROM `{ref_table}` "
                                        f"WHERE `{ref_desc_col}` = %s AND {fallback_expr}"
                                    )
                                    await cur.execute(fallback_sql, (description,))
                                    fallback_rows = await cur.fetchall()
                                    if len(fallback_rows) == 1:
                                        return str(fallback_rows[0][0])
                        except Exception:
                            pass

                if len(rows) > 1 or _always_scope:
                    return None

                # Exact match found nothing — try LIKE, but only if result is unique
                await cur.execute(
                    f"SELECT `{ref_id_col}` FROM `{ref_table}` WHERE `{ref_desc_col}` LIKE %s",
                    (f"%{description}%",),
                )
                rows = await cur.fetchall()
                if len(rows) == 1:
                    return str(rows[0][0])
                return None
            except Exception:
                return None


_update_datetime_cache: dict[str, bool] = {}

# Cache: (table, column) → max character length (None = no limit or not varchar)
_column_length_cache: dict[tuple[str, str], int | None] = {}


async def get_column_max_length(pool: MeridianConnectorPool, table_name: str, column_name: str) -> int | None:
    """Return max character length for a varchar/char column, or None if unlimited/not applicable."""
    key = (table_name, column_name)
    if key in _column_length_cache:
        return _column_length_cache[key]
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s "
                    "AND COLUMN_NAME = %s AND DATA_TYPE IN ('varchar','char')",
                    (table_name, column_name),
                )
                row = await cur.fetchone()
                result = int(row[0]) if row and row[0] else None
        _column_length_cache[key] = result
        return result
    except Exception:
        return None


def truncate_to_column_length(value: str, max_length: int | None, column_name: str, field_name: str) -> tuple[str, str | None]:
    """Truncate value if it exceeds column max length. Returns (value, warning_msg)."""
    if not value or not max_length:
        return value, None
    if len(value) > max_length:
        truncated = value[:max_length]
        warning = (
            f"Value for '{field_name}' ({column_name}) truncated from {len(value)} to {max_length} chars "
            f"(column limit). Original: '{value[:40]}...'"
        )
        return truncated, warning
    return value, None


async def table_has_update_datetime(pool: MeridianConnectorPool, table_name: str) -> bool:
    """Return True if the table has an update_datetime column. Result is cached."""
    if table_name in _update_datetime_cache:
        return _update_datetime_cache[table_name]
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT COUNT(*) FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() "
                    "AND TABLE_NAME = %s AND COLUMN_NAME = 'update_datetime'",
                    (table_name,),
                )
                row = await cur.fetchone()
                result = bool(row and row[0] > 0)
        _update_datetime_cache[table_name] = result
        return result
    except Exception:
        return False


async def bulk_find_record_ids(
    pool: MeridianConnectorPool,
    module: str,
    case_ids: list[str],
) -> dict[str, int]:
    """Fetch PKs for multiple cases in a single IN query.
    Returns {case_id_str: pk_int}. Only for simple (non-auth_review) modules.
    """
    cfg = get_config(module)
    if not cfg:
        return {}
    table = cfg["table"]
    id_col = cfg.get("id_col")
    pk = cfg["pk"]
    if not id_col:
        return {}
    unique_ids = list({str(c) for c in case_ids})
    if not unique_ids:
        return {}
    id_col_alternatives = {
        "appeals_no": ["appeals_no", "appeal_no"],
        "appeal_no":  ["appeal_no", "appeals_no"],
    }.get(id_col, [id_col])
    for col_try in id_col_alternatives:
        try:
            placeholders = ",".join(["%s"] * len(unique_ids))
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        f"SELECT `{pk}`, `{col_try}` FROM `{table}` "
                        f"WHERE `{col_try}` IN ({placeholders})",
                        unique_ids,
                    )
                    rows = await cur.fetchall()
                    return {str(row[1]): int(row[0]) for row in rows}
        except Exception:
            continue
    return {}


async def bulk_get_current_values(
    pool: MeridianConnectorPool,
    table: str,
    pk_col: str,
    record_ids: list[int],
    columns: list[tuple],  # [(col_name, ref_table, ref_id_col, ref_desc_col), ...]
) -> dict[tuple, tuple]:
    """Fetch current values for multiple records and columns in bulk.
    Returns {(record_id, col_name): (raw_str, display_str)}.

    Step 1: SELECT pk, col1, col2, ... FROM table WHERE pk IN (...)
    Step 2: For each FK column, SELECT ref_id, ref_desc FROM ref_table WHERE ref_id IN (...)
    """
    if not record_ids or not columns:
        return {}
    safe_cols = [(col, rt, ri, rd) for col, rt, ri, rd in columns
                 if col.lower() not in PHI_COLUMNS and not col.startswith("#")]
    if not safe_cols:
        return {}
    unique_ids = list(set(record_ids))
    result: dict[tuple, tuple] = {}
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                col_names = [c[0] for c in safe_cols]
                cols_sql = ", ".join(f"`{c}`" for c in col_names)
                placeholders = ",".join(["%s"] * len(unique_ids))
                await cur.execute(
                    f"SELECT `{pk_col}`, {cols_sql} FROM `{table}` "
                    f"WHERE `{pk_col}` IN ({placeholders})",
                    unique_ids,
                )
                raw_map: dict[tuple, str | None] = {}
                for row in await cur.fetchall():
                    rec_id = row[0]
                    for i, col_info in enumerate(safe_cols):
                        val = row[i + 1]
                        raw_map[(rec_id, col_info[0])] = str(val) if val is not None else None

                for col_name, ref_table, ref_id_col, ref_desc_col in safe_cols:
                    if ref_table and ref_id_col and ref_desc_col:
                        raw_ids = list({raw_map[(rid, col_name)]
                                        for rid in unique_ids
                                        if (rid, col_name) in raw_map
                                        and raw_map[(rid, col_name)] is not None})
                        ref_map: dict[str, str | None] = {}
                        if raw_ids:
                            try:
                                rp = ",".join(["%s"] * len(raw_ids))
                                await cur.execute(
                                    f"SELECT `{ref_id_col}`, `{ref_desc_col}` FROM `{ref_table}` "
                                    f"WHERE `{ref_id_col}` IN ({rp})",
                                    raw_ids,
                                )
                                ref_map = {str(r[0]): (str(r[1]) if r[1] is not None else None)
                                           for r in await cur.fetchall()}
                            except Exception:
                                pass
                        for rid in unique_ids:
                            raw = raw_map.get((rid, col_name))
                            display = ref_map.get(raw) if raw else None
                            result[(rid, col_name)] = (raw, display or raw)
                    else:
                        for rid in unique_ids:
                            raw = raw_map.get((rid, col_name))
                            result[(rid, col_name)] = (raw, raw)
    except Exception:
        pass
    return result


async def get_audit_fk_value(pool: MeridianConnectorPool, module: str, record_id: int) -> int | None:
    """Get the audit_log FK column value (e.g. authorizations_id for auth_review)."""
    cfg = get_config(module)
    if not cfg:
        return None
    audit_fk_join = cfg.get("audit_fk_join")
    if not audit_fk_join:
        return record_id  # same as record ID for most modules

    # For auth_review: need authorization_id
    query = audit_fk_join.replace("{pk}", str(record_id))
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            try:
                await cur.execute(query)
                row = await cur.fetchone()
                return row[0] if row else record_id
            except Exception:
                return record_id
