from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

import yaml

from models.schemas import SpreadsheetRow
from services.module_detector import MODULE_CONFIG, candidate_modules_for_case_id

if TYPE_CHECKING:
    from services.field_mapper import FieldMapper


_FALLBACK_CASE_ID_RE = re.compile(
    r"\b(?:CTM\d{6,}|EXRM\d{6,}|GR\d{8,}|[ACGHDPQI]\d{8,}|\d{10,12})\b",
    re.IGNORECASE,
)
_OBVIOUS_TICKET_RE = re.compile(
    r"\b(?:BECU|CCIU|back\s*end|backend|case\s+update|field\s+update|"
    r"please\s+(?:add|update|set|correct|change)|decision\s+letter\s+template|"
    r"(?:remove|removed|kill|killed|terminate|terminated)\b.{0,120}\b(?:work\s*flow|wf))\b",
    re.IGNORECASE,
)
_SEPARATOR_RE = r"(?:\s*[:=]\s*|\s+[-\u2013\u2014]\s+)"
_STOP_MARKERS = (
    "Reporter",
    "Client Name",
    "Product Version",
    "Business Area",
    "MHK Module",
    "Business Impact",
    "Compliance Impact",
    "Detailed description",
    "Detailed business impact",
    "Steps to recreate",
    "Please fill in below",
    "Desired functionality",
    "User Roles affected",
)
@dataclass(frozen=True)
class _Alias:
    alias: str
    field_name: str


@dataclass(frozen=True)
class _ExtractedRow:
    module: str
    case_id: str
    field_name: str
    new_value: str
    label_key: str
    match_start: int


@dataclass(frozen=True)
class _TextContextModuleRule:
    module: str
    case_prefixes: tuple[str, ...]
    keywords: tuple[str, ...]


def _config_path(filename: str) -> str:
    return os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "config", filename))


def _load_text_context_module_rules() -> tuple[_TextContextModuleRule, ...]:
    try:
        with open(_config_path("text_context_modules.yaml"), encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception:
        return ()

    raw_rules = data.get("rules") or []
    rules: list[_TextContextModuleRule] = []
    for raw in raw_rules:
        if not isinstance(raw, dict):
            continue
        module = str(raw.get("module") or "").strip()
        if module not in MODULE_CONFIG:
            continue
        keywords = tuple(
            str(keyword).strip().lower()
            for keyword in raw.get("keywords") or []
            if str(keyword or "").strip()
        )
        if not keywords:
            continue
        case_prefixes = tuple(
            str(prefix).strip().upper()
            for prefix in raw.get("case_prefixes") or []
            if str(prefix or "").strip()
        )
        rules.append(_TextContextModuleRule(
            module=module,
            case_prefixes=case_prefixes,
            keywords=keywords,
        ))
    return tuple(rules)


_TEXT_CONTEXT_MODULE_RULES = _load_text_context_module_rules()


def _case_id_re_from_config() -> re.Pattern[str]:
    patterns: list[str] = []
    for cfg in MODULE_CONFIG.values():
        for pattern in cfg.get("case_id_patterns") or []:
            search_pattern = str(pattern).strip()
            if search_pattern.startswith("^"):
                search_pattern = search_pattern[1:]
            if search_pattern.endswith("$"):
                search_pattern = search_pattern[:-1]
            if search_pattern:
                patterns.append(f"(?:{search_pattern})")

    if not patterns:
        return _FALLBACK_CASE_ID_RE

    return re.compile(
        rf"(?<![A-Z0-9])(?:{'|'.join(patterns)})(?![A-Z0-9])",
        re.IGNORECASE,
    )


_CASE_ID_RE = _case_id_re_from_config()


def _normalise_space(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _unique_case_ids(text: str) -> list[str]:
    seen: set[str] = set()
    case_ids: list[str] = []
    for match in _CASE_ID_RE.finditer(text or ""):
        case_id = match.group(0).upper()
        if case_id not in seen:
            seen.add(case_id)
            case_ids.append(case_id)
    return case_ids


def _split_markdown_row(line: str) -> list[str]:
    if "|" not in line:
        return []
    stripped = line.strip()
    if not stripped.startswith("|"):
        return []
    return [
        _normalise_space(cell.replace("\xa0", " "))
        for cell in stripped.strip("|").split("|")
    ]


def _is_separator_row(cells: list[str]) -> bool:
    non_empty = [cell.replace(" ", "") for cell in cells if cell.strip()]
    return bool(non_empty) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in non_empty)


def _normalise_header(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").replace("\xa0", " ").lower())


def _find_header(headers: list[str], predicate) -> int | None:
    for index, header in enumerate(headers):
        if predicate(_normalise_header(header)):
            return index
    return None


def _cell(cells: list[str], index: int | None) -> str:
    if index is None or index >= len(cells):
        return ""
    return cells[index].strip()


def _normalise_context_token(token: str) -> str:
    token = str(token or "").lower()
    if len(token) > 4 and token.endswith("ies"):
        return token[:-3] + "y"
    if len(token) > 4 and token.endswith("s") and not token.endswith(("ss", "us", "is")):
        return token[:-1]
    return token


def _context_tokens(value: str) -> list[str]:
    return [
        _normalise_context_token(token)
        for token in re.findall(r"[a-z0-9]+", str(value or "").lower())
    ]


def _keyword_matches(text: str, keyword: str) -> bool:
    keyword_tokens = _context_tokens(keyword)
    if not keyword_tokens:
        return False
    text_tokens = _context_tokens(text)
    window = len(keyword_tokens)
    return any(
        text_tokens[index:index + window] == keyword_tokens
        for index in range(0, len(text_tokens) - window + 1)
    )


def _rule_matches_case_id(rule: _TextContextModuleRule, case_id: str) -> bool:
    if not rule.case_prefixes:
        return True
    normalized = str(case_id or "").strip().upper()
    return any(normalized.startswith(prefix) for prefix in rule.case_prefixes)


def _module_from_text_context(text: str, case_id: str) -> str | None:
    for rule in _TEXT_CONTEXT_MODULE_RULES:
        if not _rule_matches_case_id(rule, case_id):
            continue
        if any(_keyword_matches(text, keyword) for keyword in rule.keywords):
            return rule.module
    return None


def detect_module_from_text_context(text: str, case_ids: list[str]) -> str | None:
    for case_id in case_ids:
        module = _module_from_text_context(text, case_id)
        if module:
            return module
    return None


def _candidate_modules_for_text(text: str, case_id: str) -> list[str]:
    contextual = _module_from_text_context(text, case_id)
    if contextual:
        return [contextual]
    return candidate_modules_for_case_id(case_id)


def _mapped_or_special(mapper: "FieldMapper", module: str, field_name: str) -> bool:
    if field_name == "Terminate Workflow":
        return True
    return mapper.find_for_module(module, field_name) is not None


def _workflow_termination_requested(text: str, case_id: str) -> bool:
    action_re = re.compile(r"\b(?:remove|removed|kill|killed|terminate|terminated)\b", re.IGNORECASE)
    workflow_re = re.compile(r"\b(?:work\s*flow|wf)\b", re.IGNORECASE)
    for match in re.finditer(re.escape(case_id), text, re.IGNORECASE):
        start = max(0, match.start() - 160)
        end = min(len(text), match.end() + 160)
        window = text[start:end]
        if action_re.search(window) and workflow_re.search(window):
            return True
    return False


def _extract_workflow_termination_rows(text: str, case_ids: list[str]) -> list[SpreadsheetRow]:
    rows: list[SpreadsheetRow] = []
    row_num = 1
    seen: set[tuple[str, str]] = set()
    for case_id in case_ids:
        if not _workflow_termination_requested(text, case_id):
            continue
        modules = _candidate_modules_for_text(text, case_id)
        if len(modules) != 1:
            continue
        key = (modules[0], case_id)
        if key in seen:
            continue
        seen.add(key)
        rows.append(SpreadsheetRow(
            row_num=row_num,
            module=modules[0],
            case_id=case_id,
            field_name="Terminate Workflow",
            new_value="Y",
            reason="deterministic_text_workflow",
        ))
        row_num += 1
    return rows


def _extract_markdown_table_rows(text: str, mapper: "FieldMapper") -> list[SpreadsheetRow]:
    rows: list[SpreadsheetRow] = []
    row_num = 1
    lines = text.splitlines()
    index = 0
    while index < len(lines) - 1:
        headers = _split_markdown_row(lines[index])
        separator = _split_markdown_row(lines[index + 1])
        if not headers or not _is_separator_row(separator):
            index += 1
            continue

        normalized_headers = [_normalise_header(header) for header in headers]
        case_col = _find_header(headers, lambda h: h.startswith("case") or h in {"caseno", "caseid"})
        new_status_col = _find_header(
            headers,
            lambda h: "newstatus" in h and "reason" not in h,
        )
        old_status_col = _find_header(
            headers,
            lambda h: "oldstatus" in h and "reason" not in h,
        )
        new_reason_col = _find_header(headers, lambda h: "newstatusreason" in h)
        old_reason_col = _find_header(headers, lambda h: "oldstatusreason" in h)
        remove_col = _find_header(headers, lambda h: "removefromworkflow" in h or h == "workflowyn")

        useful_table = (
            case_col is not None
            and (
                new_status_col is not None
                or new_reason_col is not None
                or remove_col is not None
            )
        )
        if not useful_table:
            index += 1
            continue

        index += 2
        while index < len(lines):
            cells = _split_markdown_row(lines[index])
            if not cells:
                break
            if _is_separator_row(cells):
                index += 1
                continue
            if len(cells) < len(normalized_headers):
                cells.extend([""] * (len(normalized_headers) - len(cells)))

            case_cell = _cell(cells, case_col)
            case_match = _CASE_ID_RE.search(case_cell) or _CASE_ID_RE.search(" ".join(cells))
            if not case_match:
                index += 1
                continue
            case_id = case_match.group(0).upper()
            modules = _candidate_modules_for_text(text, case_id)
            if len(modules) != 1:
                index += 1
                continue
            module = modules[0]

            status = _cell(cells, new_status_col)
            if status and _mapped_or_special(mapper, module, "Status"):
                rows.append(SpreadsheetRow(
                    row_num=row_num,
                    module=module,
                    case_id=case_id,
                    field_name="Status",
                    old_value=_cell(cells, old_status_col) or None,
                    new_value=status,
                    reason="deterministic_text_table",
                ))
                row_num += 1

            status_reason = _cell(cells, new_reason_col)
            if status_reason and _mapped_or_special(mapper, module, "Status Reason"):
                rows.append(SpreadsheetRow(
                    row_num=row_num,
                    module=module,
                    case_id=case_id,
                    field_name="Status Reason",
                    old_value=_cell(cells, old_reason_col) or None,
                    new_value=status_reason,
                    reason="deterministic_text_table",
                ))
                row_num += 1

            remove_value = _cell(cells, remove_col).lower()
            if remove_value in {"y", "yes", "true", "1"}:
                rows.append(SpreadsheetRow(
                    row_num=row_num,
                    module=module,
                    case_id=case_id,
                    field_name="Terminate Workflow",
                    new_value="Y",
                    reason="deterministic_text_table",
                ))
                row_num += 1

            index += 1
        continue

    return rows


def _module_field_mappings(mapper: "FieldMapper", module: str):
    raw_map = getattr(mapper, "_map", {})
    for (table, _ui_key), mapping in raw_map.items():
        table_name = str(table or "").lower()
        if table_name == module or table_name.startswith(f"{module}_"):
            yield mapping


def _add_alias(aliases: dict[str, _Alias], alias: str, field_name: str) -> None:
    cleaned = _normalise_space(alias)
    if not cleaned:
        return
    key = cleaned.lower()
    aliases.setdefault(key, _Alias(alias=cleaned, field_name=field_name))


def _field_aliases(mapper: "FieldMapper", module: str) -> list[_Alias]:
    aliases: dict[str, _Alias] = {}
    for mapping in _module_field_mappings(mapper, module):
        field_name = str(getattr(mapping, "ui_name", "") or "").strip()
        if not field_name:
            continue
        _add_alias(aliases, field_name, field_name)
        _add_alias(aliases, f"{field_name} Field", field_name)

        # Common BECU/CCIU ticket wording says "Field" even when the loader
        # mapping stores the editable text field as "... Note".
        if field_name.lower().endswith(" note"):
            stem = field_name[:-5].strip()
            _add_alias(aliases, stem, field_name)
            _add_alias(aliases, f"{stem} Field", field_name)
        if field_name.lower().endswith(" template note"):
            stem = field_name[:-5].strip()
            _add_alias(aliases, stem, field_name)
            _add_alias(aliases, f"{stem} Field", field_name)

    # High-value aliases observed in BECU/CCIU ticket bodies. These still only
    # emit rows when the mapped field exists for the detected module.
    for requested, mapped in {
        "Decision Letter Template Field": "Decision Letter Template Note",
        "Decision Letter Template": "Decision Letter Template Note",
    }.items():
        if mapper.find_for_module(module, mapped):
            _add_alias(aliases, requested, mapped)

    return sorted(aliases.values(), key=lambda item: len(item.alias), reverse=True)


def _compile_alias_pattern(aliases: list[_Alias]) -> re.Pattern[str] | None:
    if not aliases:
        return None
    alternatives = "|".join(re.escape(item.alias) for item in aliases)
    return re.compile(
        rf"(?<![A-Za-z0-9])(?P<label>{alternatives}){_SEPARATOR_RE}",
        re.IGNORECASE,
    )


def _trim_value(value: str) -> str:
    value = str(value or "").replace("\r", "").strip()
    lowered = value.lower()
    search_from = 0
    while (word_start := lowered.find("we", search_from)) >= 0:
        search_from = word_start + 2
        if word_start == 0 or not value[word_start - 1].isspace():
            continue
        cursor = word_start + 2
        if cursor >= len(value) or not value[cursor].isspace():
            continue
        while cursor < len(value) and value[cursor].isspace():
            cursor += 1
        attempted_end = cursor + len("attempted")
        if lowered[cursor:attempted_end] != "attempted":
            continue
        cursor = attempted_end
        if cursor >= len(value) or not value[cursor].isspace():
            continue
        while cursor < len(value) and value[cursor].isspace():
            cursor += 1
        client_end = cursor + 4
        if lowered[cursor:client_end] not in {"becu", "cciu"}:
            continue
        if client_end < len(value) and value[client_end].isalnum():
            continue
        value = value[:word_start].strip()
        break

    line_offset = 0
    stop_markers = {marker.casefold() for marker in _STOP_MARKERS}
    for line in value.splitlines(keepends=True):
        candidate = line.lstrip(" \t")
        if candidate.startswith("|"):
            candidate = candidate[1:].lstrip(" \t")
        label, separator, _remainder = candidate.partition(":")
        if separator and label.strip().casefold() in stop_markers:
            value = value[:line_offset].strip()
            break
        line_offset += len(line)

    value = re.sub(r"\n[^\S\r\n]*\|[^\S\r\n]*", "\n", value)
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip(" \n\t|")


def _alias_by_label(aliases: list[_Alias]) -> dict[str, _Alias]:
    return {item.alias.lower(): item for item in aliases}


def _extract_rows_for_module(
    text: str,
    mapper: "FieldMapper",
    case_id: str,
    module: str,
) -> list[_ExtractedRow]:
    aliases = _field_aliases(mapper, module)
    pattern = _compile_alias_pattern(aliases)
    if not pattern:
        return []
    by_label = _alias_by_label(aliases)

    rows: list[_ExtractedRow] = []
    matches = list(pattern.finditer(text))
    for index, match in enumerate(matches):
        label_key = match.group("label").lower()
        alias = by_label.get(label_key)
        if not alias:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        value = _trim_value(text[match.end():end])
        if not value:
            continue
        rows.append(_ExtractedRow(
            module=module,
            case_id=case_id,
            field_name=alias.field_name,
            new_value=value,
            label_key=label_key,
            match_start=match.start(),
        ))
    return rows


def _has_ambiguous_module_match(rows: list[_ExtractedRow]) -> bool:
    modules_by_match: dict[tuple[int, str, str], set[str]] = {}
    for row in rows:
        key = (row.match_start, row.label_key, row.new_value)
        modules_by_match.setdefault(key, set()).add(row.module)
    return any(len(modules) > 1 for modules in modules_by_match.values())


def extract_deterministic_text_rows(text: str, mapper: "FieldMapper") -> list[SpreadsheetRow]:
    """Extract obvious BECU/CCIU ticket update rows without invoking an LLM.

    This intentionally handles only high-signal ticket formats: a recognizable
    case identifier plus mapped field labels written as "Label: value" or
    "Label - value". Messier prose falls through to the LLM extractor.
    """
    text = str(text or "")
    if not text.strip() or not _OBVIOUS_TICKET_RE.search(text):
        return []

    case_ids = _unique_case_ids(text)
    if not case_ids:
        return []

    table_rows = _extract_markdown_table_rows(text, mapper)
    if table_rows:
        return table_rows

    workflow_rows = _extract_workflow_termination_rows(text, case_ids)
    if workflow_rows:
        return workflow_rows

    rows: list[SpreadsheetRow] = []
    row_num = 1
    for case_id in case_ids:
        candidate_modules = _candidate_modules_for_text(text, case_id)
        if not candidate_modules:
            continue

        extracted: list[_ExtractedRow] = []
        for module in candidate_modules:
            extracted.extend(_extract_rows_for_module(text, mapper, case_id, module))

        if len(candidate_modules) > 1 and _has_ambiguous_module_match(extracted):
            # Example: H-prefixed identifiers can be authorizations.auth_number
            # or auth_review.review_number. If the field label does not narrow
            # that down, let the LLM path use broader context.
            return []

        for extracted_row in sorted(extracted, key=lambda item: item.match_start):
            rows.append(SpreadsheetRow(
                row_num=row_num,
                module=extracted_row.module,
                case_id=extracted_row.case_id,
                field_name=extracted_row.field_name,
                new_value=extracted_row.new_value,
                reason="deterministic_text",
            ))
            row_num += 1

    return rows
