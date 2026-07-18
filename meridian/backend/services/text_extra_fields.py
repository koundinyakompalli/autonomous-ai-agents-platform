from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime
from difflib import SequenceMatcher
from typing import TYPE_CHECKING

import yaml

if TYPE_CHECKING:
    from services.field_mapper import FieldMapper


_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "config", "text_extra_field_map.yaml")
_LABEL_VALUE = re.compile(r"^(.{1,90}?)(?:\s*[:=]\s*|\s+[\u2013\u2014]\s+|\s+-\s+)(.+?)\s*$")
_BULLET_PREFIX = re.compile(r"^\s*(?:[-*\u2022]|\d+[.)]|[a-z][.)])\s+", re.IGNORECASE)
_MARKDOWN_LINK_OR_IMAGE = re.compile(r"^!?\[[^\]]*\]\([^)]*\)")
_SIGNATURE_OR_HEADER = re.compile(
    r"^(?:thanks|thank you|regards|best|sincerely|from|to|cc|bcc|fax|phone|email|"
    r"cid:|image:|confidentiality notice)\b",
    re.IGNORECASE,
)
_NEGATED_WORKFLOW = re.compile(
    r"\b(?:do\s+not|don't|dont|not)\s+(?:kill|terminate|remove|close)\b.*\b(?:work\s*flow|wf)\b",
    re.IGNORECASE,
)
_WORKFLOW_ACTION = re.compile(
    r"\b(?:kill(?:ed)?|terminate(?:d)?|remove(?:d)?)\s+(?:from\s+)?(?:work\s*flow|wf)\b"
    r"|\bclose(?:d|s|ing)?(?:\s+cases?)?\s+(?:from|out\s+of)\s+(?:work\s*flow|wf)\b",
    re.IGNORECASE,
)
_FIELD_REQUEST_HINT = re.compile(
    r"\b(?:back\s*end|backend|case\s+update|update(?:d)?\s+(?:to|as)|field(?:s)?|"
    r"status|category|subcategory|closed?\s+date|case\s+note|workflow)\b",
    re.IGNORECASE,
)

_DATE_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%m/%d/%Y %H:%M:%S %p",
    "%m/%d/%Y %I:%M:%S %p",
    "%m/%d/%Y %I:%M %p",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M",
    "%m/%d/%Y",
    "%m-%d-%Y %H:%M:%S",
    "%m-%d-%Y",
)
_FUZZY_LABEL_THRESHOLD = 0.86
_FUZZY_LABEL_MARGIN = 0.04


@dataclass(frozen=True)
class TicketExtraField:
    field_name: str
    new_value: str | None
    source: str = "ticket_text"


def _load_text_field_map(module: str | None) -> dict[str, str]:
    try:
        with open(os.path.normpath(_CONFIG_PATH), encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        merged: dict[str, str] = {}
        for scope in ("default", module or ""):
            values = data.get(scope)
            if not isinstance(values, dict):
                continue
            merged.update({_normalise_key(str(k)): str(v).strip() for k, v in values.items()})
        return merged
    except Exception as exc:
        print(f"Warning: could not load text_extra_field_map.yaml: {exc}")
        return {}


def _normalise_key(value: str) -> str:
    value = re.sub(r"[*_`]+", "", str(value or ""))
    value = re.sub(r"[_\-.]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip().lower()
    return value


def _token_sort_key(value: str) -> str:
    return " ".join(sorted(_normalise_key(value).split()))


def _label_similarity(left: str, right: str) -> float:
    left_key = _normalise_key(left)
    right_key = _normalise_key(right)
    if not left_key or not right_key:
        return 0.0
    direct = SequenceMatcher(None, left_key, right_key).ratio()
    token_sorted = SequenceMatcher(None, _token_sort_key(left_key), _token_sort_key(right_key)).ratio()
    return max(direct, token_sorted)


def _fuzzy_text_map_lookup(key: str, text_map: dict[str, str]) -> str | None:
    if len(key) < 5:
        return None

    scored: list[tuple[float, str]] = []
    for known_label, field_name in text_map.items():
        if len(known_label) < 5:
            continue
        score = _label_similarity(key, known_label)
        if score >= _FUZZY_LABEL_THRESHOLD:
            scored.append((score, field_name))

    if not scored:
        return None

    scored.sort(key=lambda item: item[0], reverse=True)
    best_score, best_field = scored[0]
    for score, field_name in scored[1:]:
        if best_score - score > _FUZZY_LABEL_MARGIN:
            break
        if field_name != best_field:
            return None
    return best_field


def _clean_line(line: str) -> str:
    line = str(line or "").replace("\u00a0", " ").strip()
    line = _BULLET_PREFIX.sub("", line)
    line = re.sub(r"^[>|\s]+", "", line).strip()
    line = re.sub(r"[*_`]+", "", line).strip()
    return line


def _normalise_value(field_name: str, value: str | None) -> str | None:
    if value is None:
        return None
    value = re.sub(r"\s+", " ", str(value).strip().strip("\"'")).strip()
    if not value or value.lower() in {"blank", "none", "na", "n/a", "null"}:
        return None
    if "date" in field_name.lower():
        parsed = _parse_date(value)
        if parsed:
            return parsed
    return value


def _parse_date(value: str) -> str | None:
    value = " ".join(str(value or "").split()).strip()
    if not value:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(value, fmt).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    return value


def _resolve_field_name(label: str, mapper: "FieldMapper", module: str | None) -> str | None:
    text_map = _load_text_field_map(module)
    key = _normalise_key(label)
    mapped = text_map.get(key) or _fuzzy_text_map_lookup(key, text_map)
    candidates = []
    if mapped:
        candidates.append(mapped)
    cleaned = re.sub(r"\s+", " ", re.sub(r"[*_`]+", "", label)).strip()
    candidates.extend([cleaned, cleaned.title()])

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate:
            continue
        dedupe_key = candidate.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        if module:
            mapping = mapper.find_for_module(module, candidate)
            if mapping:
                return mapping.ui_name
        else:
            matches = mapper.get_by_ui(candidate)
            if len(matches) == 1:
                return matches[0].ui_name

    if mapped and not module:
        return mapped
    return None


def _split_label_value(line: str, mapper: "FieldMapper", module: str | None) -> tuple[str, str] | None:
    match = _LABEL_VALUE.match(line)
    if not match:
        return None
    label = match.group(1).strip()
    value = match.group(2).strip()
    field_name = _resolve_field_name(label, mapper, module)
    if not field_name:
        return None
    return field_name, value


def _is_multiline_field(field_name: str) -> bool:
    key = field_name.lower()
    return "note" in key or "reason" in key


def _should_stop_continuation(line: str) -> bool:
    if not line:
        return True
    if _MARKDOWN_LINK_OR_IMAGE.match(line):
        return True
    if _SIGNATURE_OR_HEADER.match(line):
        return True
    if line.startswith("[") and "]" in line:
        return True
    return False


def _is_workflow_action(line: str) -> bool:
    return bool(_WORKFLOW_ACTION.search(line)) and not bool(_NEGATED_WORKFLOW.search(line))


def _workflow_field(mapper: "FieldMapper", module: str | None) -> TicketExtraField | None:
    field_name = _resolve_field_name("terminate workflow", mapper, module)
    if not field_name:
        return None
    return TicketExtraField(field_name=field_name, new_value="Y", source="ticket_text_workflow_phrase")


def _dedupe(fields: list[TicketExtraField]) -> list[TicketExtraField]:
    order: list[str] = []
    by_field: dict[str, TicketExtraField] = {}
    for field in fields:
        key = field.field_name.lower()
        if key not in by_field:
            order.append(key)
        by_field[key] = field
    return [by_field[key] for key in order]


def extract_deterministic_ticket_extra_fields(
    text: str,
    mapper: "FieldMapper",
    module: str | None,
) -> list[TicketExtraField]:
    """Extract uniform ticket-level backend fields without calling an LLM."""
    fields: list[TicketExtraField] = []
    active_idx: int | None = None

    for raw_line in str(text or "").splitlines():
        line = _clean_line(raw_line)
        if not line:
            active_idx = None
            continue

        if _is_workflow_action(line):
            workflow = _workflow_field(mapper, module)
            if workflow:
                fields.append(workflow)
            active_idx = None
            continue

        parsed = _split_label_value(line, mapper, module)
        if parsed:
            field_name, raw_value = parsed
            fields.append(
                TicketExtraField(
                    field_name=field_name,
                    new_value=_normalise_value(field_name, raw_value),
                    source="ticket_text_label",
                )
            )
            active_idx = len(fields) - 1 if _is_multiline_field(field_name) else None
            continue

        if active_idx is not None:
            if _LABEL_VALUE.match(line):
                active_idx = None
                continue
            if _should_stop_continuation(line):
                active_idx = None
                continue
            current = fields[active_idx]
            joined = "\n".join(part for part in [current.new_value, line] if part)
            fields[active_idx] = TicketExtraField(
                field_name=current.field_name,
                new_value=joined,
                source=current.source,
            )

    return _dedupe(fields)


def _looks_like_extra_field_request(text: str) -> bool:
    return bool(_FIELD_REQUEST_HINT.search(text or ""))


def _normalise_llm_fields(
    raw_fields: list[dict],
    mapper: "FieldMapper",
    module: str | None,
) -> list[TicketExtraField]:
    fields: list[TicketExtraField] = []
    for raw in raw_fields:
        field_name = _resolve_field_name(str(raw.get("field_name") or ""), mapper, module)
        if not field_name:
            continue
        fields.append(
            TicketExtraField(
                field_name=field_name,
                new_value=_normalise_value(field_name, raw.get("new_value")),
                source="ticket_text_llm",
            )
        )
    return _dedupe(fields)


def extract_ticket_extra_fields(
    text: str,
    mapper: "FieldMapper",
    module: str | None,
    *,
    allow_llm: bool = True,
) -> list[TicketExtraField]:
    """Extract uniform update fields to apply to every case in a companion spreadsheet."""
    deterministic = extract_deterministic_ticket_extra_fields(text, mapper, module)
    if deterministic:
        return deterministic

    if not allow_llm or not _looks_like_extra_field_request(text):
        return []

    try:
        from services.llm_extractor import LLMExtractor

        raw_fields = LLMExtractor().extract_extra_fields_from_text(text, mapper, module)
        return _normalise_llm_fields(raw_fields, mapper, module)
    except Exception as exc:
        print(f"[text_extra_fields] LLM extra-field extraction failed: {exc}")
        return []
