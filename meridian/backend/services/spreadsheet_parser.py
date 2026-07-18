from __future__ import annotations

import io
import csv
import re
from datetime import datetime

import openpyxl

import os

from models.schemas import SpreadsheetRow
from services.llm_extractor import LLMExtractor
from services.module_detector import detect_module
from services.text_ticket_parser import detect_module_from_text_context


def _load_field_map(filename: str) -> dict[str, str]:
    """Load field name normalization mappings from a yaml config file."""
    try:
        import yaml
        config_path = os.path.join(os.path.dirname(__file__), "..", "config", filename)
        with open(os.path.normpath(config_path), encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return {str(k).lower(): str(v) for k, v in data.items()}
    except Exception as e:
        print(f"Warning: could not load {filename}: {e}")
        return {}


def _load_wide_field_map() -> dict[str, str]:
    return _load_field_map("wide_field_map.yaml")


def _load_tall_field_map() -> dict[str, str]:
    return _load_field_map("tall_field_map.yaml")


def _load_tall_column_map() -> dict:
    """Load tall-format column header detection patterns from config."""
    try:
        import yaml
        config_path = os.path.join(os.path.dirname(__file__), "..", "config", "tall_column_map.yaml")
        with open(os.path.normpath(config_path), encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        normalized = {}
        for k, v in data.items():
            if isinstance(v, list):
                normalized[k] = [str(p).lower() for p in v]
            else:
                normalized[k] = v
        return normalized
    except Exception as e:
        print(f"Warning: could not load tall_column_map.yaml: {e}")
        return {}


def _decode_csv_bytes(file_bytes: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return file_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    return file_bytes.decode("utf-8", errors="replace")


def _load_workbook(file_bytes: bytes) -> openpyxl.Workbook:
    try:
        return openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True)
    except Exception as exc:
        text = _decode_csv_bytes(file_bytes)
        sample = text[:4096]
        if "," not in sample and "\t" not in sample and "\n" not in sample:
            raise exc

        dialect = csv.excel
        try:
            dialect = csv.Sniffer().sniff(sample)
        except Exception:
            pass

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "CSV"
        for row in csv.reader(io.StringIO(text), dialect):
            ws.append(row)
        return wb


# Sentinel returned when a NEW value cell explicitly says "Blank/NA/N/A"
# meaning: set this field to NULL in the database.
EXPLICIT_NULL = "__EXPLICIT_NULL__"


# All date/time formats found in BECU spreadsheets, tried in order.
# Multiple spaces are collapsed before parsing.
_DATE_FORMATS = [
    "%Y-%m-%d %H:%M:%S",       # already correct MySQL format
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%m/%d/%Y %H:%M:%S %p",    # 2/5/2026 17:30:00 PM  (24h with dangling AM/PM marker)
    "%m/%d/%Y %I:%M:%S %p",    # 02/05/2026 05:30:00 PM (true 12h)
    "%m/%d/%Y %I:%M %p",       # 02/05/2026 05:30 PM
    "%m/%d/%Y %H:%M:%S",       # 02/05/2026 17:30:00
    "%m/%d/%Y %H:%M",          # 02/05/2026 17:30
    "%m/%d/%Y",                # 02/05/2026
    "%m-%d-%Y %H:%M:%S",
    "%m-%d-%Y",
]


def _parse_date_string(s: str) -> str | None:
    """Try to parse a date string into MySQL YYYY-MM-DD HH:MM:SS format.
    Returns the original string unchanged if it doesn't look like a date."""
    orig = s
    # Collapse multiple spaces/newlines only for date parsing attempts
    s_norm = " ".join(s.split()).strip()
    if not s_norm:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s_norm, fmt).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    # Not a recognisable date — return original unchanged (preserves newlines in rich text)
    return orig


def _fmt_date(val) -> str | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.strftime("%Y-%m-%d %H:%M:%S")
    s = str(val).strip()
    if not s or s.lower() in ("none", "blank", "na", "n/a"):
        return None
    return _parse_date_string(s)


def _fmt_date_new(val) -> str | None:
    """Like _fmt_date but returns EXPLICIT_NULL when value is 'Blank'/'NA'/'N/A'.
    Used for NEW value columns — 'Blank' means set to NULL, not skip the row."""
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.strftime("%Y-%m-%d %H:%M:%S")
    s = str(val).strip()
    if not s:
        return None
    if s.lower() in ("none", "blank", "na", "n/a"):
        return EXPLICIT_NULL
    return _parse_date_string(s)


def _clean(val) -> str | None:
    if val is None:
        return None
    s = str(val).strip()
    return None if s.lower() in ("", "none", "blank", "na", "n/a") else s


_CASE_ID_PATTERN = re.compile(
    r"(?<![A-Z0-9])(?:GR\d{3,}|[ACDGHIM]\d{3,}|P(?:O)?\d{6,}|\d{4,}[A-Z]{2,5}\d{1,}|\d{9,14})(?![A-Z0-9])",
    re.IGNORECASE,
)


def _infer_module_from_case_id(case_id: str) -> str | None:
    normalized = str(case_id).strip().upper()
    if re.match(r"^D\d+", normalized):
        return "provider_appeals_mgmt"
    if re.match(r"^GR?\d+", normalized):
        return "grievance_mgmt"
    if re.match(r"^H\d+", normalized):
        return "auth_review"
    if re.match(r"^A\d+", normalized):
        return "appeals_mgmt"
    if re.match(r"^C\d+", normalized):
        return "ctm_mgmt"
    if re.match(r"^I\d+", normalized):
        return "ire_mgmt"
    if re.match(r"^M\d+", normalized):
        return "member_referral"
    if re.match(r"^P\d+", normalized):
        return "member_assessment"
    if re.match(r"^\d{9,14}$", normalized):
        return "der"
    return None


def infer_module_from_case_ids(case_ids: list[str], detected_module: str | None = None) -> str | None:
    if detected_module:
        return detected_module

    inferred: list[str] = []
    for case_id in case_ids:
        module = _infer_module_from_case_id(case_id)
        if module:
            inferred.append(module)

    if not inferred:
        return None

    for module in inferred:
        if inferred.count(module) == len(inferred):
            return module
    return inferred[0]


def extract_case_ids(file_bytes: bytes) -> list[str]:
    """Extract ordered, de-duplicated case identifiers from every workbook sheet."""
    wb = _load_workbook(file_bytes)
    seen: set[str] = set()
    case_ids: list[str] = []

    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            for value in row:
                if value is None:
                    continue
                text = str(value)
                for match in _CASE_ID_PATTERN.finditer(text):
                    case_id = match.group(0).upper()
                    if case_id in seen:
                        continue
                    seen.add(case_id)
                    case_ids.append(case_id)

    return case_ids


_GENERIC_FIELD_NAME_PATTERN = re.compile(r"^field\s+[a-z0-9]+$", re.IGNORECASE)
_HEADER_CASE_VALUES = {
    "auth reference/review #",
    "case",
    "case #",
    "case#",
    "case id",
    "case no",
    "case number",
    "auth reference",
    "auth/referral/case number",
    "mhk auth/referral/case number",
}


def _normalized_label(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


def _looks_like_header_case_id(value: str | None) -> bool:
    normalized = _normalized_label(value).rstrip(":")
    return normalized in _HEADER_CASE_VALUES


def _looks_like_generic_field_name(value: str | None) -> bool:
    normalized = _normalized_label(value)
    return bool(_GENERIC_FIELD_NAME_PATTERN.match(normalized)) or normalized in {
        "field",
        "field name",
        "old value",
        "new value",
        "current value",
    }


def _extract_guidance_field_name(value: str | None) -> str | None:
    """Extract template guidance like 'Name of the field: Status'."""
    text = str(value or "").strip()
    if not text:
        return None
    match = re.search(r"\bname\s+of\s+(?:the\s+)?field\s*:?\s*(.+)$", text, re.IGNORECASE)
    if not match:
        return None
    field = match.group(1).strip()
    return field or None


def _case_col_index(headers_lower: list[str]) -> int | None:
    _col_map = _load_tall_column_map()
    for pattern in _col_map.get("case_col") or []:
        for index, header in enumerate(headers_lower):
            if pattern in header:
                return index
    return None


def _sample_case_ids_from_column(ws, case_col: int | None, start_row: int, max_rows: int = 10) -> list[str]:
    if case_col is None:
        return []
    case_ids: list[str] = []
    seen: set[str] = set()
    for row in ws.iter_rows(min_row=start_row, max_row=start_row + max_rows - 1, values_only=True):
        if case_col >= len(row):
            continue
        case_id = _clean(row[case_col])
        if not case_id or _looks_like_header_case_id(case_id):
            continue
        normalized = str(case_id).strip().upper()
        if normalized in seen:
            continue
        seen.add(normalized)
        case_ids.append(normalized)
    return case_ids


def _field_maps(row: SpreadsheetRow, mapper, sheet_module: str | None) -> bool:
    if mapper is None or not row.field_name:
        return False
    if row.field_name == "Terminate Workflow":
        return True

    modules = [
        module
        for module in (row.module, sheet_module)
        if module
    ]
    for module in modules:
        try:
            if mapper.find_for_module(module, row.field_name):
                return True
        except Exception:
            continue

    try:
        return bool(mapper.get_by_ui(row.field_name))
    except Exception:
        return False


def _deterministic_parse_low_confidence(
    rows: list[SpreadsheetRow],
    mapper,
    sheet_module: str | None,
) -> bool:
    """Return True when deterministic parsing produced likely header artifacts.

    This is intentionally cheap: no DB calls and no LLM calls. It only checks
    parsed field labels and loaded field mapper hits.
    """
    if not rows:
        return True

    checkable = [
        row for row in rows
        if row.case_id and row.field_name and not _looks_like_header_case_id(row.case_id)
    ]
    if not checkable:
        return True

    generic_count = sum(1 for row in checkable if _looks_like_generic_field_name(row.field_name))
    mapped_count = sum(1 for row in checkable if _field_maps(row, mapper, sheet_module))

    if generic_count and mapped_count == 0:
        return True

    if mapper is not None and len(checkable) >= 3:
        return (mapped_count / len(checkable)) < 0.5

    return False


def _llm_fallback_rows(ws, mapper, sheet_module: str | None) -> tuple[str | None, list[SpreadsheetRow]]:
    try:
        from services.field_mapper import FieldMapper as _FieldMapper
        import inspect as _inspect
        _mapper = mapper
        if _mapper is None:
            for frame_info in _inspect.stack():
                req = frame_info.frame.f_locals.get("request")
                if req and hasattr(req, "app"):
                    _mapper = getattr(req.app.state, "field_mapper", None)
                    break
        if _mapper is None:
            _mapper = _FieldMapper()
            _mappings_dir = os.path.join(os.path.dirname(__file__), "..", "mappings")
            _mapper.load_dir(_mappings_dir)
        rows = LLMExtractor().extract(ws, _mapper)
        if rows:
            return sheet_module or rows[0].module, rows
    except Exception as _e:
        print(f"[parse_spreadsheet] Sheet '{ws.title}' LLM fallback failed: {_e}")
    return sheet_module, []


def parse_spreadsheet(file_bytes: bytes, mapper=None, context_text: str = "") -> tuple[str | None, list[SpreadsheetRow]]:
    """
    Parse an xlsx back-end edit spreadsheet.
    All sheets are parsed and rows merged; each sheet is treated independently.
    Supports three formats:
    1. TALL format: one field change per row (COMPASS, UM BEE forms)
       Headers: Case#, Field Name, Old Value, New Value, ...
    2. WIDE format: multiple field columns per row, each as (OLD)/(NEW) pairs
       Headers: Case#, Field A (OLD), Field A (NEW), Field B (OLD), Field B (NEW), ...
    3. FLAT format: one case per row, no OLD/NEW pairs, no Field Name column.
       Each column whose header matches a known field name is treated as a NEW value.
       Headers: Dispute#, Category, Sub Category, Ex Code, ...
    """
    wb = _load_workbook(file_bytes)

    all_rows: list[SpreadsheetRow] = []
    overall_module: str | None = None
    row_offset = 0

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]

        detected_module: str | None = None

        # ── Find header row ───────────────────────────────────────────────────────
        header_row: list[str] = []
        header_idx: int | None = None
        for r in range(1, 8):
            cells = [str(c.value or "") for c in ws[r]]
            cells_lower = " ".join(cells).lower()
            _header_patterns = _load_tall_column_map().get("header_detect", [
                "case #", "case#", "auth reference", "member id", "user id",
                "case ", "(old)", "(new)", "old value", "new value",
            ])
            if any(k in cells_lower for k in _header_patterns):
                header_row = cells
                header_idx = r
                break

        if not header_row or header_idx is None:
            print(f"[parse_spreadsheet] Sheet '{sheet_name}': no header row found, skipping")
            continue

        # ── Detect module from title/header rows only ─────────────────────────────
        # Data values can contain alias substrings (for example "Determination"
        # contains "termination"), so do not scan below the detected header row.
        for r in range(1, min(header_idx, 4) + 1):
            for cell in ws[r]:
                if cell.value:
                    m = detect_module(str(cell.value))
                    if m:
                        detected_module = m
                        break
            if detected_module:
                break

        headers_lower = [h.lower() for h in header_row]
        case_col_for_context = _case_col_index(headers_lower)
        context_case_ids = _sample_case_ids_from_column(ws, case_col_for_context, header_idx + 1)
        context_module = detect_module_from_text_context(context_text, context_case_ids) if context_text else None
        if context_module:
            detected_module = context_module

        # ── Detect format ─────────────────────────────────────────────────────────
        is_wide = any("(old)" in h or "(old " in h or "(new)" in h or "(new " in h for h in headers_lower)
        # Also detect "Current X" / "New X" wide pairs (used by APPEALS, GRIEVANCES, ExRM templates)
        is_current_new_wide = (
            not is_wide
            and any(h.startswith("current") for h in headers_lower)
            and any(h.startswith("new") for h in headers_lower)
        )
        has_field_col = any(p in " ".join(headers_lower) for p in ("field name", "target field"))

        if has_field_col:
            sheet_module, rows = _parse_tall(ws, header_row, headers_lower, header_idx, detected_module)
        elif is_wide:
            sheet_module, rows = _parse_wide(ws, header_row, header_idx, detected_module)
        elif is_current_new_wide:
            sheet_module, rows = _parse_current_new_wide(ws, header_row, headers_lower, header_idx, detected_module)
        elif not has_field_col and mapper is not None:
            sheet_module, rows = _parse_flat(ws, header_row, headers_lower, header_idx, detected_module, mapper)
        else:
            sheet_module, rows = _parse_tall(ws, header_row, headers_lower, header_idx, detected_module)

        # ── LLM fallback ─────────────────────────────────────────────────────────
        # Fall back not only when deterministic parsing found no rows, but also
        # when it produced header artifacts such as "Field A" / "Field B" that
        # do not map to Meridian fields.
        if _deterministic_parse_low_confidence(rows, mapper, sheet_module or detected_module):
            sheet_module, rows = _llm_fallback_rows(ws, mapper, sheet_module or detected_module)

        # Re-number rows globally and stamp module
        for row in rows:
            row_offset += 1
            row.row_num = row_offset
            if row.module is None:
                row.module = sheet_module

        all_rows.extend(rows)

        if sheet_module and overall_module is None:
            overall_module = sheet_module

        print(f"[parse_spreadsheet] Sheet '{sheet_name}': module={sheet_module}, {len(rows)} rows")

    return overall_module, all_rows


# ── FLAT format parser ───────────────────────────────────────────────────────

def _parse_flat(ws, header_row: list[str], headers_lower: list[str], header_idx: int,
                detected_module: str | None, mapper) -> tuple[str | None, list[SpreadsheetRow]]:
    """
    Flat format: one case per row, no (OLD)/(NEW) pairs, no Field Name column.
    Each column whose header the mapper recognises as a known field is treated as
    a new-value update.  The case-ID column is identified via tall_column_map case_col
    patterns (same logic as the tall parser).
    """
    _col_map = _load_tall_column_map()

    def col_idx(role: str) -> int | None:
        patterns = _col_map.get(role) or []
        for p in patterns:
            for i, h in enumerate(headers_lower):
                if p in h:
                    return i
        return None

    case_col = col_idx("case_col")
    if case_col is None:
        return detected_module, []

    # Infer module from first data row's case ID — case ID pattern is authoritative
    _module = detected_module
    for data_row in ws.iter_rows(min_row=header_idx + 1, max_row=header_idx + 3, values_only=True):
        if case_col < len(data_row) and data_row[case_col]:
            case_str = str(data_row[case_col]).strip()
            if re.match(r'^D\d+', case_str, re.I):
                _module = "provider_appeals_mgmt"
            elif re.match(r'^\d{9,12}$', case_str):
                _module = "der"
            elif re.match(r'^H\d+', case_str, re.I):
                _module = _module or "auth_review"
            elif re.match(r'^GR?\d+', case_str, re.I):
                _module = "grievance_mgmt"
            elif re.match(r'^A\d+', case_str, re.I):
                _module = "appeals_mgmt"
            elif re.match(r'^C\d+', case_str, re.I):
                _module = "ctm_mgmt"
            elif re.match(r'^[A-Z]\d{8,}', case_str):
                _module = _module or "appeals_mgmt"
            break

    # Discover which columns map to known fields via the mapper.
    field_columns: list[tuple[int, str]] = []  # (col_idx, field_name_as_in_header)
    for i, h in enumerate(header_row):
        if i == case_col or not h.strip():
            continue
        if _module and mapper.find_for_module(_module, h.strip()):
            field_columns.append((i, h.strip()))

    if not field_columns:
        return _module, []

    rows: list[SpreadsheetRow] = []
    row_counter = 0
    for row_num, row in enumerate(ws.iter_rows(min_row=header_idx + 1, values_only=True), start=header_idx + 1):
        if not any(row):
            continue
        case_id = _clean(row[case_col]) if case_col < len(row) else None
        if not case_id:
            continue

        for col_i, field_name in field_columns:
            raw = row[col_i] if col_i < len(row) else None
            new_val = _fmt_date_new(raw)
            if new_val is None:
                continue
            if new_val == EXPLICIT_NULL:
                new_val = None

            row_counter += 1
            rows.append(SpreadsheetRow(
                row_num=row_counter,
                module=_module,
                case_id=case_id,
                field_name=field_name,
                old_value=None,
                new_value=new_val,
            ))

    return _module, rows


# ── CURRENT/NEW wide format parser ───────────────────────────────────────────

def _parse_current_new_wide(
    ws, header_row: list[str], headers_lower: list[str], header_idx: int,
    detected_module: str | None
) -> tuple[str | None, list[SpreadsheetRow]]:
    """
    Wide format using 'Current X' / 'New X' column pairs instead of 'X (OLD)' / 'X (NEW)'.
    Used by APPEALS, GRIEVANCES, and ExRM template sheets.
    Column 0 is always Case# / case identifier.
    """
    _wide_field_map: dict[str, str] = _load_wide_field_map()

    def _normalize(raw: str) -> str:
        return _wide_field_map.get(raw.strip().lower(), raw.strip())

    # Build a map of normalized field name -> (current_col, new_col)
    # "Current X" headers define the field name; we strip the "Current " prefix.
    current_cols: dict[str, int] = {}   # field_name_lower -> col index
    new_cols: dict[str, int] = {}       # field_name_lower -> col index

    for i, h in enumerate(headers_lower):
        h_stripped = h.strip()
        if h_stripped.startswith("current"):
            field_raw = re.sub(r'^current[\s\n]+', '', h_stripped, flags=re.I).strip()
            if field_raw:
                current_cols[field_raw] = i
        elif h_stripped.startswith("new"):
            field_raw = re.sub(r'^new[\s\n]+', '', h_stripped, flags=re.I).strip()
            if field_raw:
                new_cols[field_raw] = i

    # Pair current/new by matching field name
    field_pairs: list[tuple[str, int, int]] = []  # (field_name, current_col, new_col)
    for field_key, cur_idx in current_cols.items():
        if field_key in new_cols:
            display_name = _normalize(re.sub(r'\s+', ' ', field_key).strip())
            field_pairs.append((display_name, cur_idx, new_cols[field_key]))

    # Also capture unpaired "New X" columns (no matching "Current X" companion).
    # These are new-value-only fields (e.g. "New Creation Type" on ExRM sheet).
    # Append them BEFORE the paired fields so they populate batch_values first.
    new_only_pairs: list[tuple[str, int, int]] = []  # (field_name, sentinel=-1, new_col)
    paired_new_cols = {new_cols[k] for k in current_cols if k in new_cols}
    for field_key, new_idx in new_cols.items():
        if new_idx not in paired_new_cols:
            display_name = _normalize(re.sub(r'\s+', ' ', field_key).strip())
            new_only_pairs.append((display_name, -1, new_idx))
    # Prepend new-only so they're resolved before paired fields that depend on them
    field_pairs = new_only_pairs + field_pairs

    if not field_pairs:
        return detected_module, []

    # Infer module from case# in first data row
    _module = detected_module
    for data_row in ws.iter_rows(min_row=header_idx + 1, max_row=header_idx + 3, values_only=True):
        if data_row[0]:
            case_str = str(data_row[0]).strip()
            m = detect_module(case_str)
            if m:
                _module = m
                break
            if re.match(r'^\d{9,12}$', case_str):
                _module = "ire_mgmt"
            elif re.match(r'^GR?\d+', case_str, re.I):
                _module = "grievance_mgmt"
            elif re.match(r'^A\d+', case_str, re.I):
                _module = "appeals_mgmt"
            elif re.match(r'^C\d+', case_str, re.I):
                _module = "ctm_mgmt"
        break

    rows: list[SpreadsheetRow] = []
    row_counter = 0
    for row in ws.iter_rows(min_row=header_idx + 1, values_only=True):
        if not any(row):
            continue
        case_id = _clean(row[0])
        if not case_id:
            continue

        for field_name, cur_idx, new_idx in field_pairs:
            old_val = _fmt_date(row[cur_idx]) if cur_idx >= 0 and cur_idx < len(row) else None
            new_val = _fmt_date_new(row[new_idx]) if new_idx < len(row) else None

            if new_val is None:
                continue
            if new_val == EXPLICIT_NULL:
                new_val = None

            row_counter += 1
            rows.append(SpreadsheetRow(
                row_num=row_counter,
                module=_module,
                case_id=case_id,
                field_name=field_name,
                old_value=old_val,
                new_value=new_val,
            ))

    return _module, rows


# ── WIDE format parser ────────────────────────────────────────────────────────

def _parse_wide(ws, header_row: list[str], header_idx: int, detected_module: str | None) -> tuple[str | None, list[SpreadsheetRow]]:
    """
    Wide format: Case# in col 0, then Field (OLD) / Field (NEW) column pairs.
    Each row may produce multiple SpreadsheetRows.
    """
    rows: list[SpreadsheetRow] = []
    row_counter = 0

    # Wide-format header normalization — loaded from config/wide_field_map.yaml.
    # Maps spreadsheet column labels (e.g. "Letter Template") to the field names
    # used in data_loader_config_fields. Add new mappings to the yaml file.
    _wide_field_map: dict[str, str] = _load_wide_field_map()

    def _normalize_wide_field(raw: str, module: str | None = None) -> str:
        key = raw.strip().lower()
        if module:
            scoped_key = f"{module.strip().lower()}:{key}"
            if scoped_key in _wide_field_map:
                return _wide_field_map[scoped_key]
        return _wide_field_map.get(key, raw.strip())

    def _strip_wide_suffix(raw: str, suffix: str) -> str:
        return re.sub(rf'\s*\({suffix}[^)]*\)', '', raw, flags=re.I).strip()

    def _normalized_header_key(raw: str) -> str:
        return re.sub(r"[^a-z0-9]+", "", str(raw or "").lower())

    def _is_remove_workflow_header(raw: str) -> bool:
        key = _normalized_header_key(raw)
        return key in {
            "removefromworkflow",
            "removefromworkflowyn",
            "workflowyn",
        }

    def _is_yes(value) -> bool:
        return str(value or "").strip().lower() in {"y", "yes", "true", "1"}

    headers_lower = [h.lower() for h in header_row]
    case_col = _case_col_index(headers_lower)
    if case_col is None:
        case_col = 0
    remove_workflow_cols = [
        index
        for index, header in enumerate(header_row)
        if index != case_col and _is_remove_workflow_header(header)
    ]

    label_row = None
    data_start_row = header_idx + 1
    if any(_looks_like_generic_field_name(_strip_wide_suffix(h, "old")) for h in header_row):
        try:
            label_row = [cell.value for cell in ws[header_idx + 1]]
            data_start_row = header_idx + 2
        except Exception:
            label_row = None

    # Build field pairs: list of (field_name, old_col_idx, new_col_idx, old_header, new_header)
    field_pairs: list[tuple[str, int, int, str, str]] = []
    i = 0
    while i < len(header_row):
        if i == case_col:
            i += 1
            continue
        h = header_row[i]
        hl = h.lower()
        if "(old)" in hl or "(old " in hl:
            old_header = _strip_wide_suffix(h, "old")
            # Look for matching (NEW) in adjacent columns
            new_idx = None
            for j in range(i + 1, min(i + 3, len(header_row))):
                nj = header_row[j].lower()
                if "(new)" in nj or "(new " in nj:
                    new_idx = j
                    break
            if new_idx is not None:
                new_header = _strip_wide_suffix(header_row[new_idx], "new")
                if label_row and _looks_like_generic_field_name(old_header):
                    old_label = _clean(label_row[i]) if i < len(label_row) else None
                    new_label = _clean(label_row[new_idx]) if new_idx < len(label_row) else None
                    old_header = old_label or new_label or old_header
                    new_header = new_label or old_label or new_header
                field_name = _normalize_wide_field(old_header, detected_module)
                field_pairs.append((field_name, i, new_idx, old_header, new_header))
                i = new_idx + 1
                continue
        i += 1

    # Infer module from case number format when no explicit module hint was found
    # in the sheet. Numeric case IDs are used by more than one workflow, so an
    # explicit header signal such as ExRM should win over the legacy DER fallback.
    for data_row in ws.iter_rows(min_row=data_start_row, max_row=data_start_row + 2, values_only=True):
        if case_col < len(data_row) and data_row[case_col]:
            case_str = str(data_row[case_col]).strip()
            if detected_module is None and re.match(r'^\d{9,12}$', case_str):
                detected_module = "der"   # 11-digit numeric = DER (COMPASS)
            elif detected_module is None and re.match(r'^H\d+', case_str, re.I):
                # H-prefix = either auth_review (with revision) or authorizations (without)
                # Default to auth_review; lookup will try authorizations first if no revision
                detected_module = "auth_review"
            elif detected_module is None and re.match(r'^GR?\d+', case_str, re.I):
                detected_module = "grievance_mgmt"
            elif detected_module is None and re.match(r'^[A-Z]\d{8,}', case_str):
                detected_module = "ctm_mgmt" if re.match(r'^C\d+', case_str, re.I) else "appeals_mgmt"
            break

    for row_num, row in enumerate(ws.iter_rows(min_row=data_start_row, values_only=True), start=data_start_row):
        if not any(row):
            continue
        case_id = _clean(row[case_col]) if case_col < len(row) else None
        if not case_id:
            continue

        for field_name, old_idx, new_idx, old_header, new_header in field_pairs:
            old_val = _fmt_date(row[old_idx]) if old_idx < len(row) else None
            new_val = _fmt_date_new(row[new_idx]) if new_idx < len(row) else None

            if new_val is None:
                continue  # Cell is empty — no instruction, skip

            # EXPLICIT_NULL means "set to NULL" — convert to None for the change row
            # but still generate the update (new_value=None → UPDATE SET col = NULL)
            if new_val == EXPLICIT_NULL:
                new_val = None

            new_field_name = _normalize_wide_field(new_header, detected_module)
            if (
                detected_module == "der"
                and old_header.strip().lower() == "request type"
                and new_field_name.lower() == "original request reason"
            ):
                # Some BECU RD sheets place Request Type (OLD) next to
                # Original Request Reason (NEW). The OLD request type is the
                # prior current-case type, not original_request_type context.
                row_counter += 1
                rows.append(SpreadsheetRow(
                    row_num=row_counter,
                    module=detected_module,
                    case_id=case_id,
                    field_name="Original Request Reason",
                    old_value=None,
                    new_value=new_val,
                ))
                continue

            # Note: do NOT skip old == new here — the underlying DB ID may differ
            # even when display values match (e.g. Classification under a new Request Type).
            # The already_done check in generate.py handles true no-ops via raw ID comparison.

            row_counter += 1
            rows.append(SpreadsheetRow(
                row_num=row_counter,
                module=detected_module,
                case_id=case_id,
                field_name=field_name,
                old_value=old_val,
                new_value=new_val,
            ))

        if any(col < len(row) and _is_yes(row[col]) for col in remove_workflow_cols):
            row_counter += 1
            rows.append(SpreadsheetRow(
                row_num=row_counter,
                module=detected_module,
                case_id=case_id,
                field_name="Terminate Workflow",
                old_value=None,
                new_value="Y",
            ))

    return detected_module, rows


# ── TALL format parser ────────────────────────────────────────────────────────

def _parse_tall(ws, header_row: list[str], headers_lower: list[str], header_idx: int, detected_module: str | None) -> tuple[str | None, list[SpreadsheetRow]]:
    """
    Tall format: one field per row.
    Headers: Case#, [Revision], Field Name, Old Value, New Value, Reason, ...
    """
    _tall_map = _load_tall_field_map()
    _col_map  = _load_tall_column_map()

    def _normalize_tall_field(raw: str) -> str:
        """Normalize field name: strip whitespace/newlines, then apply config map."""
        cleaned = raw.strip().rstrip('\n').strip()
        return _tall_map.get(cleaned.lower(), cleaned)

    def col_idx(role: str, fallback_patterns: list[str] | None = None) -> int | None:
        # Iterate patterns in priority order first, then scan headers for each pattern.
        # This ensures a higher-priority pattern wins even if a lower-priority pattern
        # appears in an earlier column (e.g. "auth review #" beats "auth reference").
        patterns = _col_map.get(role) or fallback_patterns or []
        for p in patterns:
            for i, h in enumerate(headers_lower):
                if p in h:
                    return i
        return None

    case_col    = col_idx("case_col")
    field_col   = col_idx("field_col")
    old_col     = col_idx("old_col")
    new_col     = col_idx("new_col")
    reason_col  = col_idx("reason_col")
    rev_col     = col_idx("rev_col")
    assess_col  = col_idx("assess_col")
    created_col = col_idx("created_col")
    role_cols = {
        "case_col": case_col,
        "field_col": field_col,
        "old_col": old_col,
        "new_col": new_col,
        "reason_col": reason_col,
        "rev_col": rev_col,
        "assess_col": assess_col,
        "created_col": created_col,
    }

    def semantic_context_for(row) -> dict[str, str] | None:
        context: dict[str, str] = {}
        for key, cfg in (_col_map.get("semantic_context") or {}).items():
            if not isinstance(cfg, dict):
                continue
            col = role_cols.get(str(cfg.get("column_role") or ""))
            if col is None or col >= len(row):
                continue
            if cfg.get("formatter") == "datetime":
                value = _fmt_date(row[col])
            else:
                value = _clean(row[col])
            if value:
                context[str(key)] = value
        return context or None

    if case_col is None:
        return detected_module, []

    rows: list[SpreadsheetRow] = []
    pending_guidance_field: str | None = None
    for row_num, row in enumerate(ws.iter_rows(min_row=header_idx + 1, values_only=True), start=header_idx + 1):
        if not any(row):
            continue
        case_id = _clean(row[case_col]) if case_col < len(row) else None
        if not case_id:
            continue
        raw_field = _clean(row[field_col]) if field_col is not None and field_col < len(row) else None
        if _looks_like_header_case_id(case_id):
            guidance_field = _extract_guidance_field_name(raw_field)
            if guidance_field:
                pending_guidance_field = _normalize_tall_field(guidance_field)
            continue

        row_module = detected_module or _infer_module_from_case_id(case_id)
        if detected_module is None and row_module:
            detected_module = row_module

        # For user termination, field_name is optional (implicit "Termination")
        field = None
        if raw_field:
            field = _normalize_tall_field(raw_field) if raw_field else None

        old_val = _fmt_date(row[old_col]) if old_col is not None and old_col < len(row) else None
        new_val_raw = _fmt_date_new(row[new_col]) if new_col is not None and new_col < len(row) else None
        new_val = None if new_val_raw == EXPLICIT_NULL else new_val_raw
        if new_val_raw is None:
            continue  # completely empty new value cell — skip
        reason  = _clean(row[reason_col]) if reason_col is not None and reason_col < len(row) else None
        revision = int(row[rev_col]) if rev_col is not None and rev_col < len(row) and row[rev_col] else None
        assess  = _clean(row[assess_col]) if assess_col is not None and assess_col < len(row) else None
        created = _fmt_date(row[created_col]) if created_col is not None and created_col < len(row) else None
        semantic_context = semantic_context_for(row)
        if pending_guidance_field and field and old_val and _normalized_label(field) == _normalized_label(old_val):
            field = pending_guidance_field
            pending_guidance_field = None

        # For user termination format — no field column, synthesize
        if not field:
            if detected_module == "users":
                field = "Termination"
            else:
                continue  # Skip rows without a field name for other modules

        rows.append(SpreadsheetRow(
            row_num=row_num,
            module=row_module,
            case_id=case_id,
            field_name=field,
            old_value=old_val,
            new_value=new_val,
            reason=reason,
            revision=revision,
            assessment_name=assess,
            created_at=created,
            semantic_context=semantic_context,
        ))

    return detected_module, rows
