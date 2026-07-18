from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, UploadFile, File

from models.schemas import ChangeRow, LookupRequest, LookupResponse, SpreadsheetRow
from services.case_lookup import find_record_id, get_current_value, get_audit_fk_value, resolve_new_value_id
from services.field_mapper import FieldMapper
from services.module_detector import detect_module, get_config
from services.spreadsheet_parser import parse_spreadsheet
from services.text_ticket_parser import extract_deterministic_text_rows

router = APIRouter(tags=["lookup"])


def _get_pool(request: Request):
    pool = getattr(request.app.state, "active_pool", None)
    if not pool:
        raise HTTPException(status_code=400, detail="No active database connection. Please activate a profile first.")
    return pool


@router.post("/lookup", response_model=LookupResponse)
async def lookup_case(body: LookupRequest, request: Request):
    pool = _get_pool(request)
    mapper: FieldMapper = request.app.state.field_mapper
    cfg = get_config(body.module)
    if not cfg:
        raise HTTPException(status_code=400, detail=f"Unknown module: {body.module}")

    record_id = await find_record_id(pool, body.module, body.case_id, body.revision)
    if not record_id:
        return LookupResponse(
            module=body.module,
            case_id=body.case_id,
            table_name=cfg["table"],
            found=False,
            error=f"Case {body.case_id} not found",
        )

    # Negative sentinel means found in authorizations (not auth_review)
    actual_module = body.module
    if record_id < 0:
        record_id = -record_id
        actual_module = "authorizations"
        cfg = get_config("authorizations") or cfg

    return LookupResponse(
        module=actual_module,
        case_id=body.case_id,
        record_id=record_id,
        table_name=cfg["table"],
        found=True,
    )


@router.post("/parse-text")
async def parse_text(body: dict, request: Request):
    """Extract case update rows from free-form text (Jira description, email, etc.)"""
    text = (body.get("text") or "").strip()
    if not text:
        return {"detected_module": None, "rows": [], "total": 0, "llm_used": False}
    mapper = request.app.state.field_mapper
    rows = extract_deterministic_text_rows(text, mapper)
    llm_used = False
    source = "deterministic_text" if rows else None
    try:
        if not rows:
            from services.llm_extractor import LLMExtractor
            rows = LLMExtractor().extract_from_text(text, mapper)
            llm_used = bool(rows)
            source = "llm" if rows else None
    except Exception as e:
        print(f"[parse-text] LLM extraction failed: {e}")
        rows = []
        llm_used = False
        source = None
    detected_module = rows[0].module if rows else None
    return {
        "detected_module": detected_module,
        "rows": [r.model_dump() for r in rows],
        "total": len(rows),
        "llm_used": llm_used,
        "source": source,
    }


@router.post("/parse-spreadsheet")
async def parse_file(request: Request, file: UploadFile = File(...)):
    content = await file.read()
    mapper: FieldMapper = request.app.state.field_mapper
    detected_module, rows = parse_spreadsheet(content, mapper=mapper)
    llm_used = any(getattr(r, "reason", None) == "llm_extracted" for r in rows)
    return {
        "detected_module": detected_module,
        "rows": [r.model_dump() for r in rows],
        "total": len(rows),
        "llm_used": llm_used,
    }


@router.post("/resolve-changes")
async def resolve_changes(changes: list[ChangeRow], request: Request):
    """Look up current DB values for a list of changes and detect already-done."""
    pool = _get_pool(request)
    mapper: FieldMapper = request.app.state.field_mapper
    resolved = []

    for change in changes:
        cfg = get_config(change.module)
        if not cfg:
            change.error = f"Unknown module: {change.module}"
            resolved.append(change)
            continue

        # Find record
        if not change.record_id:
            record_id = await find_record_id(pool, change.module, change.case_id, change.revision)
            if not record_id:
                change.error = f"Case {change.case_id} not found"
                resolved.append(change)
                continue
            # Negative sentinel = found in authorizations instead of auth_review
            if record_id < 0:
                record_id = -record_id
                change.module = "authorizations"
                cfg = get_config("authorizations") or cfg
            change.record_id = record_id
            change.table_name = cfg["table"]

        # Resolve field mapping
        if not change.column_name:
            mapping = mapper.find_for_module(change.module, change.field_name)
            if not mapping:
                change.error = f"Field '{change.field_name}' not found in mapping"
                resolved.append(change)
                continue
            change.column_name = mapping.column_name

            # Resolve new_value ID for reference fields
            if change.new_value and mapping.ref_table and mapping.ref_id_col and mapping.ref_desc_col:
                resolved_id = await resolve_new_value_id(
                    pool, mapping.ref_table, mapping.ref_id_col, mapping.ref_desc_col,
                    change.new_value, case_id=change.case_id,
                    lov_expression=mapping.lov_expression,
                    module=change.module,
                )
                if resolved_id:
                    change.new_value = resolved_id

        # Get current value
        mapping = mapper.find_for_module(change.module, change.field_name)
        raw, display = await get_current_value(
            pool, change.module, change.record_id, change.column_name,
            mapping.ref_table if mapping else None,
            mapping.ref_id_col if mapping else None,
            mapping.ref_desc_col if mapping else None,
        )
        change.current_db_value = display or raw

        # Already-done check
        if change.new_value and change.current_db_value:
            if str(change.current_db_value).strip() == str(change.new_value).strip():
                change.already_done = True
                change.already_done_reason = f"Already set to '{change.new_value}'"

        resolved.append(change)

    return {"changes": [c.model_dump() for c in resolved]}
