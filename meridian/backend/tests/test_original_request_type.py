from __future__ import annotations

import asyncio
import io
from pathlib import Path

import openpyxl


def test_wide_parser_does_not_use_request_type_old_for_original_request_reason_context():
    from services.spreadsheet_parser import parse_spreadsheet

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Case #", "Request Type (OLD)", "Original Request Reason (NEW)"])
    ws.append(["26012345678", "Coverage Determination", "Medical Necessity"])

    buf = io.BytesIO()
    wb.save(buf)

    module, rows = parse_spreadsheet(buf.getvalue())

    assert module == "der"
    assert [(r.field_name, r.new_value, r.old_value) for r in rows] == [
        ("Original Request Reason", "Medical Necessity", None),
    ]


def test_wide_parser_does_not_detect_ire_from_medical_director_header():
    from services.spreadsheet_parser import parse_spreadsheet

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append([
        "Case #",
        "Request Type (OLD)",
        "Request Type (NEW)",
        "Medical Director (OLD)",
        "Medical Director (NEW)",
    ])
    ws.append(["26162457864", "Coverage Determination", "Redetermination", "BLANK", "Asmith"])

    buf = io.BytesIO()
    wb.save(buf)

    module, rows = parse_spreadsheet(buf.getvalue())

    assert module == "der"
    assert {row.module for row in rows} == {"der"}
    assert [(row.field_name, row.new_value) for row in rows] == [
        ("Request Type", "Redetermination"),
        ("Medical Director", "Asmith"),
    ]


def test_mapping_contains_original_request_type_and_contextual_reason_calc():
    from services.field_mapper import FieldMapper

    mappings_path = Path(__file__).resolve().parents[1] / "mappings" / "CCIU_BECU_Mapping.xlsx"
    mapper = FieldMapper()
    mapper.load(str(mappings_path))

    original_type = mapper.get("der", "Original Request Type")
    assert original_type is not None
    assert original_type.column_name == "original_request_type"
    assert original_type.ref_table == "der_request_types"
    assert original_type.ref_id_col == "id"
    assert original_type.ref_desc_col == "name"
    assert "der_request_types" in (original_type.calc_expression or "")

    reason = mapper.get("der", "Original Request Reason")
    assert reason is not None
    assert "COALESCE(original_request_type" in (reason.calc_expression or "")
    assert "rd_original_der_no" in (reason.calc_expression or "")


def test_mapping_contains_reopen_original_intake_datetime():
    from services.field_mapper import FieldMapper

    mappings_path = Path(__file__).resolve().parents[1] / "mappings" / "CCIU_BECU_Mapping.xlsx"
    mapper = FieldMapper()
    mapper.load(str(mappings_path))

    mapping = mapper.get("der_child", "Reopen Original Intake Datetime")
    assert mapping is not None
    assert mapping.column_name == "reopen_original_intake_datetime"
    assert mapping.ref_table is None
    assert mapping.calc_expression is None
    assert mapping.lov_expression is None


def test_calc_expression_override_uses_pending_request_type_placeholder():
    from models.schemas import ChangeRow
    from routers.generate import _select_calc_expression
    from services.case_lookup import resolve_via_calc_expression

    class Cursor:
        def __init__(self, pool):
            self.pool = pool

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def execute(self, sql):
            self.pool.sql = sql

        async def fetchall(self):
            return [(18,)]

    class Conn:
        def __init__(self, pool):
            self.pool = pool

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def cursor(self):
            return Cursor(self.pool)

    class Pool:
        sql = ""

        def acquire(self):
            return Conn(self)

    change = ChangeRow(
        module="der",
        case_id="26162457864",
        field_name="RequestReason",
        column_name="cdtype_id",
        new_value="Prior Authorization",
    )
    overrides = {
        "der": {
            "cdtype_id": {
                "required_batch_values": ["request_type"],
                "calc_expression": (
                    "SELECT id FROM cdtype WHERE description = '#RequestReason#' "
                    "AND request_type_id = #request_type#"
                ),
            }
        }
    }
    calc = _select_calc_expression(
        "SELECT id FROM cdtype WHERE description = '#RequestReason#'",
        change,
        {"request_type": "4"},
        overrides,
    )

    pool = Pool()
    result = asyncio.run(
        resolve_via_calc_expression(
            pool,
            calc,
            "Prior Authorization",
            "RequestReason",
            "26162457864",
            {"request_type": "4"},
        )
    )

    assert result == "18"
    assert "request_type_id = 4" in pool.sql
    assert "SELECT request_type FROM der" not in pool.sql


def test_original_request_reason_override_uses_original_case_request_type():
    from models.schemas import ChangeRow
    from routers.generate import _load_calc_expression_overrides, _select_calc_expression
    from services.case_lookup import resolve_via_calc_expression

    class Cursor:
        def __init__(self, pool):
            self.pool = pool

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def execute(self, sql):
            self.pool.sql = sql

        async def fetchall(self):
            return [(17,)]

    class Conn:
        def __init__(self, pool):
            self.pool = pool

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def cursor(self):
            return Cursor(self.pool)

    class Pool:
        sql = ""

        def acquire(self):
            return Conn(self)

    change = ChangeRow(
        module="der",
        case_id="26168783238",
        field_name="Original Request Reason",
        column_name="rd_original_cd_type",
        new_value="Non-Formulary",
    )
    default_calc = (
        "SELECT id FROM cdtype WHERE description = '#Original Request Reason#' "
        "AND request_type_id = (SELECT COALESCE(original_request_type, "
        "(SELECT request_type FROM der WHERE id = rd_original_der_no)) "
        "FROM der WHERE der_no = '#DER No#') LIMIT 1"
    )
    calc = _select_calc_expression(
        default_calc,
        change,
        {"request_type": "4", "rd_original_der_no": "28776678"},
        _load_calc_expression_overrides(),
    )

    pool = Pool()
    result = asyncio.run(
        resolve_via_calc_expression(
            pool,
            calc,
            "Non-Formulary",
            "Original Request Reason",
            "26168783238",
            {"request_type": "4", "rd_original_der_no": "28776678"},
        )
    )

    assert result == "17"
    assert "WHERE id = 28776678" in pool.sql
    assert "request_type_id = 4" not in pool.sql


def test_original_request_reason_does_not_fallback_to_current_request_type():
    from models.schemas import ChangeRow
    from routers.generate import _load_calc_expression_overrides, _select_calc_expression

    change = ChangeRow(
        module="der",
        case_id="26168783238",
        field_name="Original Request Reason",
        column_name="rd_original_cd_type",
        new_value="Non-Formulary",
    )
    default_calc = "DEFAULT_CALC"

    calc = _select_calc_expression(
        default_calc,
        change,
        {"request_type": "4"},
        _load_calc_expression_overrides(),
    )

    assert calc == default_calc


def test_auto_resolve_original_request_reason_refuses_generic_cdtype_fallback(monkeypatch):
    from types import SimpleNamespace

    from models.schemas import ChangeRow
    import routers.generate as generate

    class Pool:
        def acquire(self):
            raise AssertionError("No direct cursor calls expected")

    class Mapper:
        def find_for_module(self, module, field_name):
            if field_name == "Original Request Reason":
                return SimpleNamespace(
                    column_name="rd_original_cd_type",
                    table_name=None,
                    ref_table="cdtype",
                    ref_id_col="id",
                    ref_desc_col="description",
                    calc_expression=(
                        "SELECT id FROM cdtype WHERE description = '#Original Request Reason#' "
                        "AND request_type_id = (SELECT request_type FROM der WHERE id = #rd_original_der_no#) "
                        "LIMIT 1"
                    ),
                    lov_expression=None,
                    parent_columns=None,
                )
            return None

    generic_lookup_calls = []

    async def fake_bulk_preload(*args, **kwargs):
        return None

    async def fake_find_record_id(pool, module, case_id, revision=None):
        return 29858469

    async def fake_table_has_update_datetime(pool, table):
        return True

    async def fake_get_current_value(*args, **kwargs):
        return (None, None)

    async def fake_resolve_via_calc_expression(
        pool, calc_expression, new_value, field_name, case_id, batch_values, record_id=None
    ):
        return None

    async def fake_resolve_new_value_id(pool, ref_table, ref_id_col, ref_desc_col, description, **kwargs):
        generic_lookup_calls.append((ref_table, description, kwargs))
        return "999"

    monkeypatch.setattr(generate, "_bulk_preload", fake_bulk_preload)
    monkeypatch.setattr(generate, "find_record_id", fake_find_record_id)
    monkeypatch.setattr(generate, "table_has_update_datetime", fake_table_has_update_datetime)
    monkeypatch.setattr(generate, "get_current_value", fake_get_current_value)
    monkeypatch.setattr(generate, "resolve_via_calc_expression", fake_resolve_via_calc_expression)
    monkeypatch.setattr(generate, "resolve_new_value_id", fake_resolve_new_value_id)

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(active_pool=Pool(), field_mapper=Mapper())
        )
    )
    changes = [
        ChangeRow(
            module="der",
            case_id="26168783238",
            field_name="Original Request Reason",
            new_value="Non-Formulary",
        ),
    ]

    resolved = asyncio.run(generate._auto_resolve(changes, request))

    reason = resolved[0]
    assert reason.new_value == "Non-Formulary"
    assert reason.new_value_display == "Non-Formulary"
    assert "Original Request Reason could not be resolved" in (reason.error or "")
    assert generic_lookup_calls == []


def test_auto_resolve_preloads_original_case_number_context(monkeypatch):
    from types import SimpleNamespace

    from models.schemas import ChangeRow
    import routers.generate as generate

    class Cursor:
        def __init__(self):
            self.row = None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def execute(self, sql, params=None):
            if "FROM `der` WHERE `der_no`" in sql and params == ("26120862631",):
                self.row = (28776678,)
            else:
                self.row = None

        async def fetchone(self):
            return self.row

    class Conn:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def cursor(self):
            return Cursor()

    class Pool:
        def acquire(self):
            return Conn()

    class Mapper:
        def find_for_module(self, module, field_name):
            if field_name == "Original case number":
                return SimpleNamespace(
                    column_name="rd_original_der_no",
                    table_name=None,
                    ref_table="der",
                    ref_id_col="id",
                    ref_desc_col="der_no",
                    calc_expression=None,
                    lov_expression=None,
                    parent_columns=None,
                )
            if field_name == "Original Request Reason":
                return SimpleNamespace(
                    column_name="rd_original_cd_type",
                    table_name=None,
                    ref_table="cdtype",
                    ref_id_col="id",
                    ref_desc_col="description",
                    calc_expression=(
                        "SELECT id FROM cdtype WHERE description = '#Original Request Reason#' "
                        "AND request_type_id = (SELECT COALESCE(original_request_type, "
                        "(SELECT request_type FROM der WHERE id = rd_original_der_no)) "
                        "FROM der WHERE der_no = '#DER No#') LIMIT 1"
                    ),
                    lov_expression=None,
                    parent_columns=None,
                )
            return None

    captured = {}

    async def fake_find_record_id(pool, module, case_id, revision=None):
        return 29858469

    async def fake_table_has_update_datetime(pool, table):
        return True

    async def fake_get_current_value(*args, **kwargs):
        return (None, None)

    async def fake_resolve_new_value_id(pool, ref_table, ref_id_col, ref_desc_col, description, **kwargs):
        if ref_table == "der" and description == "26120862631":
            return "28776678"
        return None

    async def fake_resolve_via_calc_expression(
        pool, calc_expression, new_value, field_name, case_id, batch_values, record_id=None
    ):
        captured["calc_expression"] = calc_expression
        captured["batch_values"] = dict(batch_values)
        return "17"

    monkeypatch.setattr(generate, "find_record_id", fake_find_record_id)
    monkeypatch.setattr(generate, "table_has_update_datetime", fake_table_has_update_datetime)
    monkeypatch.setattr(generate, "get_current_value", fake_get_current_value)
    monkeypatch.setattr(generate, "resolve_new_value_id", fake_resolve_new_value_id)
    monkeypatch.setattr(generate, "resolve_via_calc_expression", fake_resolve_via_calc_expression)

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(active_pool=Pool(), field_mapper=Mapper())
        )
    )
    changes = [
        ChangeRow(
            module="der",
            case_id="26168783238",
            field_name="Original Request Reason",
            new_value="Non-Formulary",
        ),
        ChangeRow(
            module="der",
            case_id="26168783238",
            field_name="Original case number",
            new_value="26120862631",
        ),
    ]

    resolved = asyncio.run(generate._auto_resolve(changes, request))

    assert captured["batch_values"]["rd_original_der_no"] == "28776678"
    assert "WHERE id = #rd_original_der_no#" in captured["calc_expression"]
    reason = next(c for c in resolved if c.field_name == "Original Request Reason")
    assert reason.new_value == "17"
    assert reason.new_value_display == "Non-Formulary"


def test_original_request_reason_synthesizes_original_request_type_context():
    from models.schemas import ChangeRow
    from routers.generate import _apply_context_deps, _load_field_context_deps

    class Cursor:
        def __init__(self, pool):
            self.pool = pool
            self.row = None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def execute(self, sql, params=None):
            self.pool.sql_calls.append((sql, params))
            if "FROM cdtype ct" in sql and "JOIN der_request_types" in sql:
                self.row = ("Coverage Determination", 1)
            elif "SELECT `original_request_type` FROM `der`" in sql:
                self.row = (None,)
            else:
                self.row = None

        async def fetchone(self):
            return self.row

    class Conn:
        def __init__(self, pool):
            self.pool = pool

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def cursor(self):
            return Cursor(self.pool)

    class Pool:
        def __init__(self):
            self.sql_calls = []

        def acquire(self):
            return Conn(self)

    batch_values = {}
    source = ChangeRow(
        module="der",
        case_id="26168783238",
        record_id=29858469,
        table_name="der",
        field_name="Original Request Reason",
        column_name="rd_original_cd_type",
        new_value="1",
        new_value_display="Non-Formulary",
    )

    synthesized = asyncio.run(
        _apply_context_deps(
            Pool(),
            "der",
            29858469,
            "rd_original_cd_type",
            "1",
            batch_values,
            _load_field_context_deps(),
            source_change=source,
        )
    )

    assert batch_values["Original Request Type"] == "Coverage Determination"
    assert batch_values["original_request_type"] == "1"
    assert len(synthesized) == 1
    change = synthesized[0]
    assert change.field_name == "Original Request Type"
    assert change.column_name == "original_request_type"
    assert change.new_value == "1"
    assert change.new_value_display == "Coverage Determination"


def test_calc_expression_prefers_most_specific_note_type_context_candidate():
    from services.case_lookup import resolve_via_calc_expression

    class Cursor:
        def __init__(self, pool):
            self.pool = pool

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def execute(self, sql):
            self.pool.sql_calls.append(sql)

        async def fetchall(self):
            if len(self.pool.sql_calls) == 1:
                return [(4, "APPROVED"), (2207, "Approved")]
            return [
                (4, "APPROVED", 3371, 0),
                (2207, "Approved", 18285, 4),
            ]

    class Conn:
        def __init__(self, pool):
            self.pool = pool

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def cursor(self):
            return Cursor(self.pool)

    class Pool:
        def __init__(self):
            self.sql_calls = []

        def acquire(self):
            return Conn(self)

    calc = """
        SELECT DISTINCT nt.ID, nt.description
        FROM note_types nt
        INNER JOIN note_type_context ntc ON ntc.note_type_id = nt.ID
        INNER JOIN der d ON d.der_no = '#DER No#'
        WHERE nt.description = '#Letter template#'
    """

    pool = Pool()
    result = asyncio.run(
        resolve_via_calc_expression(
            pool,
            calc,
            "Approved",
            "Letter template",
            "26162819616",
            record_id=29742661,
        )
    )

    assert result == "2207"
    assert len(pool.sql_calls) == 2
    assert "specificity" in pool.sql_calls[1]
    assert "`ntc`.`der_request_type_id`" in pool.sql_calls[1]


def test_auto_resolve_normalizes_blank_tokens_to_empty_string():
    import asyncio
    from types import SimpleNamespace

    from models.schemas import ChangeRow
    from routers.generate import _auto_resolve

    class Mapper:
        def find_for_module(self, module, field_name):
            return None

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(active_pool=None, field_mapper=Mapper())
        )
    )
    changes = [
        ChangeRow(
            module="der",
            case_id="26012345678",
            field_name="Letter Template Verbiage",
            table_name="der",
            column_name="external_comments",
            record_id=123,
            new_value=" Blank ",
        ),
        ChangeRow(
            module="der",
            case_id="26012345679",
            field_name="Letter Template Verbiage",
            table_name="der",
            column_name="external_comments",
            record_id=124,
            new_value="N/A",
        ),
    ]

    resolved = asyncio.run(_auto_resolve(changes, request))

    assert [c.new_value for c in resolved] == ["", ""]


def test_auto_resolve_blocks_phi_target_columns():
    import asyncio
    from types import SimpleNamespace

    from models.schemas import ChangeRow
    from routers.generate import _auto_resolve

    class Mapper:
        def find_for_module(self, module, field_name):
            return None

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(active_pool=None, field_mapper=Mapper())
        )
    )
    changes = [
        ChangeRow(
            module="member",
            case_id="M26012345678",
            field_name="First Name",
            table_name="member",
            column_name="first_name",
            record_id=123,
            new_value="Jane",
        ),
    ]

    resolved = asyncio.run(_auto_resolve(changes, request))

    assert resolved[0].is_phi is True
    assert "PHI-protected column" in (resolved[0].error or "")


def test_debug_trace_redacts_raw_values():
    from models.schemas import ChangeRow
    from routers.generate import _dbg

    change = ChangeRow(module="der", case_id="26012345678", field_name="Status")

    _dbg(change, True, "resolve_new_value_id 'Status'", 12, "'Fax Back' in ref_table -> '285'")

    assert "Fax Back" not in change.debug_entries[0]
    assert "285" not in change.debug_entries[0]
    assert "<redacted_value>" in change.debug_entries[0]
