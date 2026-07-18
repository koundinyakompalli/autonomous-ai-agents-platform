from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

from models.schemas import SpreadsheetRow
from services.field_mapper import FieldMapper, FieldMapping
from services.text_ticket_parser import _keyword_matches, extract_deterministic_text_rows


def _mapper() -> FieldMapper:
    mapper = FieldMapper()
    grievance_mapping = FieldMapping(
        table_name="grievance_mgmt",
        ui_name="Decision Letter Template Note",
        column_name="secondary_comments",
        ref_table=None,
        ref_id_col=None,
        ref_desc_col=None,
        lov_expression=None,
    )
    auth_mapping = FieldMapping(
        table_name="authorizations",
        ui_name="Auth Request Type",
        column_name="auth_request_type_id",
        ref_table=None,
        ref_id_col=None,
        ref_desc_col=None,
        lov_expression=None,
    )
    review_mapping = FieldMapping(
        table_name="auth_review",
        ui_name="Review Outcome",
        column_name="review_outcome_id",
        ref_table=None,
        ref_id_col=None,
        ref_desc_col=None,
        lov_expression=None,
    )
    referral_status_mapping = FieldMapping(
        table_name="member_referral",
        ui_name="Status",
        column_name="status_id",
        ref_table="referral_status",
        ref_id_col="id",
        ref_desc_col="name",
        lov_expression=None,
    )
    referral_reason_mapping = FieldMapping(
        table_name="member_referral",
        ui_name="Status Reason",
        column_name="status_reason_id",
        ref_table="referral_status_reason",
        ref_id_col="id",
        ref_desc_col="name",
        lov_expression=None,
    )
    for mapping in (
        grievance_mapping,
        auth_mapping,
        review_mapping,
        referral_status_mapping,
        referral_reason_mapping,
    ):
        mapper._map[(mapping.table_name, mapping.ui_name.lower())] = mapping
        mapper._by_ui.setdefault(mapping.ui_name.lower(), []).append(mapping)
    return mapper


def _request(mapper: FieldMapper):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(field_mapper=mapper)))


def test_extracts_obvious_becu_decision_letter_template_field() -> None:
    text = """
    Subject: G26110835035 Update Decision Letter Template field in Production
    There were two team members in the case at the same time, so the Decision Letter Template section did not save.
    Please add the following: Decision Letter Template Field: The Grievance and Appeals Unit reviewed the quality of
    service concern(s) outlined in your grievance. Our review of the Provider's response and available records indicates
    that there was no appointment for 04/15/2026; however, you had a successful and completed visit on 03/09/2026.
    Based on our review, no quality of service issue was found. We attempted BECU but the files are still in Pending status.
    Reporter: Melissa White
    """

    rows = extract_deterministic_text_rows(text, _mapper())

    assert len(rows) == 1
    assert rows[0].module == "grievance_mgmt"
    assert rows[0].case_id == "G26110835035"
    assert rows[0].field_name == "Decision Letter Template Note"
    assert rows[0].reason == "deterministic_text"
    assert "no appointment for 04/15/2026" in rows[0].new_value
    assert "We attempted BECU" not in rows[0].new_value
    assert "Reporter:" not in rows[0].new_value


def test_parse_text_uses_deterministic_rows_before_llm() -> None:
    from routers.lookup import parse_text

    text = (
        "BECU request for G26110835035. "
        "Decision Letter Template Field: Full decision letter text."
    )

    with patch("services.llm_extractor.LLMExtractor") as extractor:
        response = asyncio.run(parse_text({"text": text}, _request(_mapper())))

    extractor.assert_not_called()
    assert response["detected_module"] == "grievance_mgmt"
    assert response["llm_used"] is False
    assert response["source"] == "deterministic_text"
    assert response["total"] == 1
    assert response["rows"][0]["field_name"] == "Decision Letter Template Note"


def test_parse_text_falls_back_to_llm_when_not_deterministic() -> None:
    from routers.lookup import parse_text

    llm_rows = [
        SpreadsheetRow(
            row_num=1,
            module="grievance_mgmt",
            case_id="G26110835035",
            field_name="Decision Letter Template Note",
            new_value="LLM extracted value",
            reason="llm_extracted",
        )
    ]

    with patch("services.llm_extractor.LLMExtractor") as extractor:
        extractor.return_value.extract_from_text.return_value = llm_rows
        response = asyncio.run(parse_text(
            {"text": "Unstructured notes for G26110835035 that need interpretation."},
            _request(_mapper()),
        ))

    extractor.assert_called_once()
    assert response["detected_module"] == "grievance_mgmt"
    assert response["llm_used"] is True
    assert response["source"] == "llm"
    assert response["total"] == 1
    assert response["rows"][0]["reason"] == "llm_extracted"


def test_h_case_uses_authorizations_when_field_maps_to_authorizations() -> None:
    rows = extract_deterministic_text_rows(
        "BECU request for H26034774917. Auth Request Type: Inpatient",
        _mapper(),
    )

    assert len(rows) == 1
    assert rows[0].module == "authorizations"
    assert rows[0].case_id == "H26034774917"
    assert rows[0].field_name == "Auth Request Type"


def test_h_case_uses_auth_review_when_field_maps_to_auth_review() -> None:
    rows = extract_deterministic_text_rows(
        "CCIU request for H26034774917. Review Outcome: Approved",
        _mapper(),
    )

    assert len(rows) == 1
    assert rows[0].module == "auth_review"
    assert rows[0].case_id == "H26034774917"
    assert rows[0].field_name == "Review Outcome"


def test_h_case_ambiguous_field_label_falls_back_to_llm() -> None:
    from routers.lookup import parse_text

    mapper = _mapper()
    for table in ("authorizations", "auth_review"):
        mapping = FieldMapping(
            table_name=table,
            ui_name="Status",
            column_name="status",
            ref_table=None,
            ref_id_col=None,
            ref_desc_col=None,
            lov_expression=None,
        )
        mapper._map[(table, "status")] = mapping
        mapper._by_ui.setdefault("status", []).append(mapping)

    llm_rows = [
        SpreadsheetRow(
            row_num=1,
            module="auth_review",
            case_id="H26034774917",
            field_name="Status",
            new_value="Approved",
            reason="llm_extracted",
        )
    ]

    with patch("services.llm_extractor.LLMExtractor") as extractor:
        extractor.return_value.extract_from_text.return_value = llm_rows
        response = asyncio.run(parse_text(
            {"text": "BECU request for H26034774917. Status: Approved"},
            _request(mapper),
        ))

    extractor.assert_called_once()
    assert response["llm_used"] is True
    assert response["source"] == "llm"
    assert response["rows"][0]["module"] == "auth_review"


def test_referral_markdown_table_routes_p_cases_to_member_referral() -> None:
    text = """
    BECU request:
    Summary: JHP BECU | Baby Partner Referrals (17)

    | Case # (Mandatory) | Old Status | New Status | Old Status Reason | New Status Reason | Remove from Workflow Y/N (Portlet) |
    | --- | --- | --- | --- | --- | --- |
    | P2530191858 | pending | closed | outreach | unable to reach | y |
    | P2529696106 | pending | cancelled | outreach | duplicate | y |
    """

    rows = extract_deterministic_text_rows(text, _mapper())

    assert len(rows) == 6
    assert {row.module for row in rows} == {"member_referral"}
    assert [row.field_name for row in rows[:3]] == [
        "Status",
        "Status Reason",
        "Terminate Workflow",
    ]
    assert rows[0].case_id == "P2530191858"
    assert rows[0].old_value == "pending"
    assert rows[0].new_value == "closed"
    assert rows[1].old_value == "outreach"
    assert rows[1].new_value == "unable to reach"
    assert rows[2].new_value == "Y"
    assert all(row.reason == "deterministic_text_table" for row in rows)


def test_prose_workflow_removal_routes_program_referral_to_termination() -> None:
    text = """
    Subject: P2302452303575 Remove Program from workflow in Production
    Business Problem Statement/Summary:
    Please remove this program referral P2302452303575 from workflow in Production.
    User reopened it after it was closed and it is stuck in workflow.
    Describe any existing processes in place related to the request: <Insert>
    """

    rows = extract_deterministic_text_rows(text, _mapper())

    assert len(rows) == 1
    assert rows[0].module == "member_referral"
    assert rows[0].case_id == "P2302452303575"
    assert rows[0].field_name == "Terminate Workflow"
    assert rows[0].new_value == "Y"
    assert rows[0].reason == "deterministic_text_workflow"


def test_mixed_grievance_and_ctm_workflow_cases_route_by_prefix() -> None:
    text = """
    TC | BECU - GRV Cases (CVS)
    Please kill work flow, if needed, and make necessary updates to clear the following cases from SLA Missed queue:
    GR2611072972
    GR2610797706
    C2603504448
    """

    rows = extract_deterministic_text_rows(text, _mapper())

    assert [(row.module, row.case_id, row.field_name, row.new_value) for row in rows] == [
        ("grievance_mgmt", "GR2611072972", "Terminate Workflow", "Y"),
        ("grievance_mgmt", "GR2610797706", "Terminate Workflow", "Y"),
        ("ctm_mgmt", "C2603504448", "Terminate Workflow", "Y"),
    ]
    assert all(row.reason == "deterministic_text_workflow" for row in rows)


def test_text_context_keyword_matching_normalizes_simple_plurals() -> None:
    assert _keyword_matches("JHP BECU | Baby Partner Referrals (17)", "referral")
    assert _keyword_matches("Member Referrals table", "member referral")
    assert _keyword_matches("Provider Disputes backend update", "provider dispute")
