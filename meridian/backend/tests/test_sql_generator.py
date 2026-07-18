from __future__ import annotations

import unittest

from models.schemas import ChangeRow
from services.sql_generator import generate_blocks, generate_blocks_for_case


def _status_change(case_id: str, record_id: int) -> ChangeRow:
    return ChangeRow(
        row_num=1,
        module="provider_appeals_mgmt",
        case_id=case_id,
        record_id=record_id,
        table_name="provider_appeals_mgmt",
        field_name="Status",
        column_name="status_cid",
        new_value="3",
        new_value_display="Overturned",
    )


def _status_change_with_value(
    case_id: str,
    record_id: int,
    value: str,
    display: str,
) -> ChangeRow:
    change = _status_change(case_id, record_id)
    change.new_value = value
    change.new_value_display = display
    return change


def _terminate_change(case_id: str, record_id: int, pid: str | None = None) -> ChangeRow:
    return ChangeRow(
        row_num=2,
        module="provider_appeals_mgmt",
        case_id=case_id,
        record_id=record_id,
        table_name="provider_appeals_mgmt",
        field_name="Terminate Workflow",
        column_name="#action:terminate_workflow",
        new_value="Y",
        is_terminate_workflow=True,
        terminate_workflow_pid=pid or f"pid-{record_id}",
    )


class SqlGeneratorTerminateWorkflowTest(unittest.TestCase):
    def test_same_case_document_updates_stay_separate_by_record_id(self) -> None:
        blocks = generate_blocks([
            ChangeRow(
                row_num=1,
                module="documents",
                case_id="P123",
                record_id=111,
                table_name="documents",
                field_name="Created At",
                column_name="insert_datetime",
                current_db_value="2026-06-09 10:03:45",
                new_value="2026-06-08 10:03:00",
                new_value_display="2026-06-08 10:03:00",
            ),
            ChangeRow(
                row_num=2,
                module="documents",
                case_id="P123",
                record_id=222,
                table_name="documents",
                field_name="Created At",
                column_name="insert_datetime",
                current_db_value="2026-06-09 11:03:45",
                new_value="2026-06-08 11:03:00",
                new_value_display="2026-06-08 11:03:00",
            ),
        ])

        self.assertEqual(len(blocks), 2)
        sql = "\n".join(block.sql for block in blocks)
        self.assertIn("WHERE `id` = 111", sql)
        self.assertIn("WHERE `id` = 222", sql)

    def test_bulk_terminate_workflow_emits_process_flow_and_hist_updates(self) -> None:
        blocks = generate_blocks([
            _status_change("D123", 101),
            _terminate_change("D123", 101),
            _status_change("D456", 202),
            _terminate_change("D456", 202),
        ])

        self.assertEqual(len(blocks), 1)
        sql = blocks[0].sql
        self.assertIn("UPDATE `process_flow` pf", sql)
        self.assertIn("UPDATE `jbpm4_hist_actinst` hai", sql)
        self.assertIn("TRUNCATE TABLE `stage`.`pid`", sql)
        self.assertIn("INSERT INTO `stage`.`pid` (`pid`)", sql)
        self.assertIn("./RunAppQuery.sh", sql)
        self.assertLess(sql.index("/* Validate"), sql.index("/* STEP 1: backup active workflow rows"))
        self.assertLess(sql.index("UPDATE `process_flow` pf"), sql.index("OPS INSTRUCTION"))

    def test_single_case_terminate_workflow_emits_after_validate(self) -> None:
        block = generate_blocks_for_case([
            _status_change("D123", 101),
            _terminate_change("D123", 101),
        ])

        sql = block.sql
        self.assertIn("UPDATE `provider_appeals_mgmt` SET", sql)
        self.assertIn("UPDATE `process_flow` pf", sql)
        self.assertIn("UPDATE `jbpm4_hist_actinst` hai", sql)
        self.assertIn("./RunAppPID.sh pid-101", sql)
        self.assertNotIn("`stage`.`pid`", sql)
        self.assertLess(sql.index("/* Validate"), sql.index("/* Backup active workflow row"))
        self.assertLess(sql.index("UPDATE `process_flow` pf"), sql.index("OPS INSTRUCTION"))

    def test_nonuniform_case_updates_share_one_bulk_workflow_stage_block(self) -> None:
        blocks = generate_blocks([
            _status_change_with_value("D123", 101, "3", "Closed"),
            _terminate_change("D123", 101),
            _status_change_with_value("D456", 202, "4", "Cancelled"),
            _terminate_change("D456", 202),
        ])

        self.assertEqual(len(blocks), 3)
        sql = "\n".join(block.sql for block in blocks)
        self.assertEqual(sql.count("UPDATE `provider_appeals_mgmt` SET"), 2)
        self.assertEqual(sql.count("OPS INSTRUCTION"), 1)
        self.assertIn("TRUNCATE TABLE `stage`.`pid`", sql)
        self.assertIn("INSERT INTO `stage`.`pid` (`pid`)", sql)
        self.assertIn("./RunAppQuery.sh", sql)
        self.assertNotIn("./RunAppPID.sh", sql)
        self.assertLess(
            sql.rindex("UPDATE `provider_appeals_mgmt` SET"),
            sql.index("/* STEP 1: backup active workflow rows"),
        )

    def test_terminate_only_does_not_emit_empty_parent_update(self) -> None:
        block = generate_blocks_for_case([_terminate_change("D123", 101)])

        sql = block.sql
        self.assertNotIn("UPDATE `provider_appeals_mgmt` SET", sql)
        self.assertIn("UPDATE `process_flow` pf", sql)
        self.assertIn("UPDATE `jbpm4_hist_actinst` hai", sql)


if __name__ == "__main__":
    unittest.main()
