from __future__ import annotations

import asyncio
import unittest
from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import patch

from routers import generate


@dataclass
class _Mapping:
    ui_name: str
    column_name: str
    ref_table: str | None = None
    ref_id_col: str | None = None
    ref_desc_col: str | None = None
    calc_expression: str | None = None
    lov_expression: str | None = None


class _Mapper:
    def find_for_module(self, module: str, ui_name: str):
        if module != "provider_appeals_mgmt":
            return None
        if ui_name == "Status":
            return _Mapping(ui_name="Status", column_name="status_cid")
        return None


async def _bulk_find_record_ids(pool, module: str, case_ids: list[str]) -> dict[str, int]:
    return {case_id: index for index, case_id in enumerate(case_ids, start=101)}


async def _has_update_datetime(pool, table: str) -> bool:
    return True


class GenerateCaseListResponseTest(unittest.TestCase):
    def test_case_list_helper_emits_bulk_sql_with_workflow_termination(self) -> None:
        request = SimpleNamespace(
            app=SimpleNamespace(
                state=SimpleNamespace(
                    active_pool=object(),
                    field_mapper=_Mapper(),
                )
            )
        )

        async def run():
            with patch.object(generate, "bulk_find_record_ids", _bulk_find_record_ids):
                with patch("services.case_lookup.table_has_update_datetime", _has_update_datetime):
                    return await generate._generate_case_list_sql_response(
                        request,
                        case_ids=["D123", "D456"],
                        extras=[
                            {"field_name": "Status", "new_value": "Overturned"},
                            {"field_name": "Terminate Workflow", "new_value": "Y"},
                        ],
                        module="provider_appeals_mgmt",
                        source_file="cases.xlsx",
                    )

        response = asyncio.run(run())
        sql = response.body.decode("utf-8")

        self.assertIn("BULK PROVIDER_APPEALS_MGMT | 2 cases", sql)
        self.assertIn("MERIDIAN bulk case-list generation completed", sql)
        self.assertIn("UPDATE `process_flow` pf", sql)
        self.assertIn("UPDATE `jbpm4_hist_actinst` hai", sql)
        self.assertIn("TRUNCATE TABLE `stage`.`pid`", sql)
        self.assertIn("INSERT INTO `stage`.`pid` (`pid`)", sql)
        self.assertIn("./RunAppQuery.sh", sql)
        self.assertLess(sql.index("UPDATE `process_flow` pf"), sql.index("OPS INSTRUCTION"))


if __name__ == "__main__":
    unittest.main()
