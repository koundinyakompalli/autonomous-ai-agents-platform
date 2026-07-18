from __future__ import annotations

import asyncio
from datetime import datetime

from models.schemas import ChangeRow
from services.semantic_resolver import resolve_semantic_fallback


class Cursor:
    def __init__(self, pool):
        self.pool = pool
        self.sql = ""
        self.params = ()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def execute(self, sql, params=()):
        self.sql = sql
        self.params = params
        self.pool.calls.append((sql, params))

    async def fetchall(self):
        sql = self.sql
        params = self.params
        if "FROM `member_referral`" in sql:
            return []
        if "FROM `careplan`" in sql and params == ("P123",):
            return [(463460,)]
        if (
            "FROM `documents`" in sql
            and "`file_name` = %s AND `careplan_id` = %s" in sql
            and params == ("doc.pdf", 463460)
        ):
            return [(19517802, datetime(2026, 6, 9, 10, 3, 45))]
        return []


class MismatchCursor(Cursor):
    async def fetchall(self):
        sql = self.sql
        params = self.params
        if "FROM `member_referral`" in sql:
            return []
        if "FROM `careplan`" in sql and params == ("P123",):
            return [(463460,)]
        if "FROM `documents`" in sql and "`file_name` = %s AND `careplan_id` = %s" in sql:
            return []
        if "FROM `documents`" in sql and "`file_name` = %s LIMIT 5" in sql:
            return [(19517802, datetime(2026, 6, 9, 10, 3, 45))]
        return []


class MemberMatchedDocumentCursor(Cursor):
    async def fetchall(self):
        sql = self.sql
        params = self.params
        if "FROM `member_referral`" in sql and params == ("P26149191811482",):
            return [(6679766, 2243269)]
        if "FROM `careplan`" in sql:
            return []
        if (
            "FROM `documents`" in sql
            and "`file_name` = %s AND `member_referral_id` = %s" in sql
            and params == ("HSC_11435_USPS_TRACKING_LEACOCK.pdf", 6679766)
        ):
            return []
        if (
            "FROM `documents`" in sql
            and "`file_name` = %s AND `member_id` = %s" in sql
            and params == ("HSC_11435_USPS_TRACKING_LEACOCK.pdf", 2243269)
        ):
            return [(19517802, datetime(2026, 6, 9, 10, 3, 45))]
        return []


class AssessmentStatusCursor(Cursor):
    async def fetchall(self):
        sql = self.sql
        params = self.params
        if "FROM `assessment_master`" in sql and params == ("HRA-General Assessment V4",):
            return [(11844, "HRA-General Assessment V4")]
        if "FROM `member_referral`" in sql:
            return []
        if "FROM `careplan`" in sql and params == ("P22109892583736",):
            return [(255021,)]
        if (
            "FROM `member_assessment`" in sql
            and "`assessment_code_id` = %s AND `careplan_id` = %s" in sql
            and params == (11844, 255021)
        ):
            return [(8354811, 4)]
        if "FROM `assessment_status`" in sql and "LOWER(TRIM" in sql and params == ("Cancelled",):
            return [(3, "Cancelled")]
        if "FROM `assessment_status`" in sql and "`id` = %s" in sql and params == (4,):
            return [("Complete",)]
        return []


class Conn:
    def __init__(self, pool, cursor_cls=Cursor):
        self.pool = pool
        self.cursor_cls = cursor_cls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def cursor(self):
        return self.cursor_cls(self.pool)


class Pool:
    def __init__(self, cursor_cls=Cursor):
        self.cursor_cls = cursor_cls
        self.calls = []

    def acquire(self):
        return Conn(self, self.cursor_cls)


def _change() -> ChangeRow:
    return ChangeRow(
        module="member_assessment",
        case_id="P123",
        field_name="Created At",
        old_value="2026-06-09 10:03:00",
        new_value="2026-06-08 10:03:00",
        semantic_context={"document_name": "doc.pdf"},
    )


def test_semantic_fallback_resolves_document_created_at_from_context() -> None:
    change = _change()
    pool = Pool()

    handled = asyncio.run(resolve_semantic_fallback(change, pool))

    assert handled is True
    assert change.error is None
    assert change.module == "documents"
    assert change.table_name == "documents"
    assert change.record_id == 19517802
    assert change.column_name == "insert_datetime"
    assert change.current_db_value == "2026-06-09 10:03:45"
    assert change.new_value_display == "2026-06-08 10:03:00"


def test_semantic_fallback_skips_document_when_parent_case_mismatches() -> None:
    change = _change()
    pool = Pool(cursor_cls=MismatchCursor)

    handled = asyncio.run(resolve_semantic_fallback(change, pool))

    assert handled is True
    assert "does not belong to parent case" in (change.error or "")
    assert change.record_id is None
    assert "Semantic fallback manual-review evidence" in (change.manual_review_sql or "")
    assert "FROM `documents`" in (change.manual_review_sql or "")


def test_semantic_fallback_resolves_document_created_at_by_member_match() -> None:
    change = ChangeRow(
        module="member_assessment",
        case_id="P26149191811482",
        field_name="Created At",
        old_value="2026-06-09 10:03:00",
        new_value="2026-06-08 10:03:00",
        semantic_context={"document_name": "HSC_11435_USPS_TRACKING_LEACOCK.pdf"},
    )
    pool = Pool(cursor_cls=MemberMatchedDocumentCursor)

    handled = asyncio.run(resolve_semantic_fallback(change, pool))

    assert handled is True
    assert change.error is None
    assert change.module == "documents"
    assert change.table_name == "documents"
    assert change.record_id == 19517802
    assert change.column_name == "insert_datetime"
    assert change.current_db_value == "2026-06-09 10:03:45"
    assert change.new_value_display == "2026-06-08 10:03:00"


def test_semantic_fallback_resolves_member_assessment_status_from_careplan_case_number() -> None:
    change = ChangeRow(
        module="member_assessment",
        case_id="P22109892583736",
        field_name="Status",
        old_value="Complete",
        new_value="Cancelled",
        semantic_context={"assessment_name": "HRA-General Assessment V4"},
    )
    pool = Pool(cursor_cls=AssessmentStatusCursor)

    handled = asyncio.run(resolve_semantic_fallback(change, pool))

    assert handled is True
    assert change.error is None
    assert change.module == "member_assessment"
    assert change.table_name == "member_assessment"
    assert change.record_id == 8354811
    assert change.column_name == "status_id"
    assert change.current_db_value == "Complete"
    assert change.new_value == "3"
    assert change.new_value_display == "Cancelled"
