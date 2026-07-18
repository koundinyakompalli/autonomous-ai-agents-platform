from __future__ import annotations

import asyncio
import io
from types import SimpleNamespace

import openpyxl


def test_exrm_original_case_number_maps_to_configured_original_case_no_field() -> None:
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


def test_bulk_preload_marks_explicit_null_target_already_done(monkeypatch) -> None:
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
