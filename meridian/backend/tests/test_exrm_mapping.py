from __future__ import annotations

import asyncio
import io
from pathlib import Path
from types import SimpleNamespace

import openpyxl


def test_exrm_wide_parser_routes_numeric_cases_to_ire_mgmt():
    from services.spreadsheet_parser import parse_spreadsheet

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append([
        "Case #",
        "ExRM Case no (old value)",
        "ExRM Case no (new value)",
        "External Decision Date (old value)",
        "External Decision Date (new value)",
        "EXRM Decision Date (old value)",
        "EXRM Decision Date (new value)",
        "Effectuation Type (old value)",
        "Effectuation Type (new value)",
    ])
    ws.append([
        "26100000000",
        "",
        "",
        "",
        "06/18/2026",
        "",
        "06/19/2026",
        "",
        "Prospective",
    ])

    buf = io.BytesIO()
    wb.save(buf)

    module, rows = parse_spreadsheet(buf.getvalue())

    assert module == "ire_mgmt"
    assert [(row.module, row.field_name, row.new_value) for row in rows] == [
        ("ire_mgmt", "External Decision Date", "2026-06-18 00:00:00"),
        ("ire_mgmt", "EXRM Decision Date", "2026-06-19 00:00:00"),
        ("ire_mgmt", "Effectuation Type", "Prospective"),
    ]


def test_exrm_wide_parser_maps_original_case_number_to_ire_field():
    from services.spreadsheet_parser import parse_spreadsheet

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append([
        "Case #",
        "ExRM Case no (old value)",
        "ExRM Case no (new value)",
        "Original Case Number (old value)",
        "Original Case Number (new value)",
    ])
    ws.append(["1-16185267645", "", "", "", "26149562004"])

    buf = io.BytesIO()
    wb.save(buf)

    module, rows = parse_spreadsheet(buf.getvalue())

    assert module == "ire_mgmt"
    assert [(row.module, row.field_name, row.new_value) for row in rows] == [
        ("ire_mgmt", "Original Case No", "26149562004"),
    ]


def test_exrm_mapping_contains_external_decision_date_and_effectuation_type_lookup():
    from services.field_mapper import FieldMapper

    mappings_path = Path(__file__).resolve().parents[1] / "mappings" / "CCIU_BECU_Mapping.xlsx"
    mapper = FieldMapper()
    mapper.load(str(mappings_path))

    external_decision_date = mapper.get("ire_mgmt", "External Decision Date")
    assert external_decision_date is not None
    assert external_decision_date.column_name == "ire_decision_date"
    assert external_decision_date.ref_table is None
    assert external_decision_date.lov_expression is None

    exrm_decision_date = mapper.get("ire_mgmt", "EXRM Decision Date")
    assert exrm_decision_date is not None
    assert exrm_decision_date.column_name == "ire_decision_date"
    assert exrm_decision_date.ref_table is None
    assert exrm_decision_date.lov_expression is None

    effectuation_type = mapper.get("ire_mgmt", "Effectuation Type")
    assert effectuation_type is not None
    assert effectuation_type.column_name == "effectuation_type_id"
    assert effectuation_type.ref_table == "list_values"
    assert effectuation_type.ref_id_col == "id"
    assert effectuation_type.ref_desc_col == "value"
    assert "EffectuationType" in (effectuation_type.lov_expression or "")


def test_bulk_preload_marks_explicit_null_target_already_done(monkeypatch):
    from models.schemas import ChangeRow
    from routers import generate

    async def fake_bulk_find_record_ids(pool, module, case_ids):
        return {"26165240164": 39708}

    async def fake_bulk_get_current_values(pool, table, pk_col, record_ids, columns):
        return {(39708, "effectuation_type_id"): (None, None)}

    class Mapper:
        def find_for_module(self, module, field_name):
            return SimpleNamespace(ref_table="list_values", ref_id_col="id", ref_desc_col="value")

    monkeypatch.setattr(generate, "bulk_find_record_ids", fake_bulk_find_record_ids)
    monkeypatch.setattr(generate, "bulk_get_current_values", fake_bulk_get_current_values)

    change = ChangeRow(
        module="ire_mgmt",
        case_id="26165240164",
        field_name="Effectuation Type",
        column_name="effectuation_type_id",
        new_value=None,
    )

    asyncio.run(generate._bulk_preload([change], object(), Mapper()))

    assert change.record_id == 39708
    assert change.current_db_value == "NULL"
    assert change.already_done is True
    assert change.already_done_reason == "Already set to NULL"
