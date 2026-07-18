from __future__ import annotations

import json
import os
import re
from typing import TYPE_CHECKING

import yaml

from models.schemas import SpreadsheetRow
from services.module_detector import detect_module, detect_module_from_case_id

if TYPE_CHECKING:
    from services.field_mapper import FieldMapper

_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "config", "llm_config.yaml")
_PHI_COLUMNS_PATH = os.path.join(os.path.dirname(__file__), "..", "config", "phi_columns.yaml")


def _load_config() -> dict:
    try:
        with open(os.path.normpath(_CONFIG_PATH), encoding="utf-8") as f:
            return yaml.safe_load(f).get("bedrock", {})
    except Exception:
        return {}


def _get_max_sheet_rows() -> int:
    cfg = _load_config()
    default = int(cfg.get("max_sheet_rows", 10000))
    return int(
        os.environ.get(
            "MERIDIAN_LLM_MAX_ROWS",
            os.environ.get("BECU_LLM_MAX_ROWS", default),
        )
    )


_MAX_SHEET_ROWS = _get_max_sheet_rows()
_MAX_COLS = 20
_CASE_ID_PATTERN = re.compile(
    r"\b(?:CTM\d{7,12}|EXRM\d{7,12}|[A-Z]{1,5}\d{7,12}|\d{4,}[A-Z]{2,5}\d{1,}|\d{10,12})\b",
    re.IGNORECASE,
)


def _label_variants_from_column(column_name: str) -> set[str]:
    """Return human-readable PHI label variants derived from phi_columns.yaml."""
    raw = str(column_name or "").strip()
    if not raw:
        return set()

    spaced = re.sub(r"[_\-.]+", " ", raw).strip().lower()
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", spaced).lower()
    replacements = {
        "firstname": "first name",
        "lastname": "last name",
        "middlename": "middle name",
        "dateofbirth": "date of birth",
        "dateofdeath": "date of death",
        "medicareno": "medicare no",
        "medicaidno": "medicaid no",
        "contactnumberemail": "contact number email",
        "contactlastname": "contact last name",
        "contactfirstname": "contact first name",
    }
    for source, target in replacements.items():
        spaced = spaced.replace(source, target)
    spaced = re.sub(r"\s+", " ", spaced).strip()

    variants = {raw.lower(), spaced}
    without_numeric_suffix = re.sub(r"\s+\d+$", "", spaced).strip()
    if without_numeric_suffix:
        variants.add(without_numeric_suffix)
    return {variant for variant in variants if variant}


def _load_phi_label_terms() -> set[str]:
    """Load configurable PHI labels from phi_columns.yaml."""
    try:
        with open(os.path.normpath(_PHI_COLUMNS_PATH), encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception:
        return set()

    terms: set[str] = set()
    for table_cols in data.values():
        if not isinstance(table_cols, list):
            continue
        for column in table_cols:
            terms.update(_label_variants_from_column(str(column)))
    return terms


def _build_sensitive_label_pattern() -> re.Pattern:
    terms = sorted(_load_phi_label_terms(), key=len, reverse=True)
    if not terms:
        return re.compile(r"(?!x)x")
    label_pattern = "|".join(
        r"[\s_\-]*".join(re.escape(part) for part in term.split())
        for term in terms
    )
    return re.compile(
        rf"\b({label_pattern})\b\s*(?:[:=]|\|)\s*([^|\n\r;,]+)",
        re.IGNORECASE,
    )


_SENSITIVE_LABEL_PATTERN = _build_sensitive_label_pattern()
_STREET_ADDRESS_PATTERN = re.compile(
    r"\b\d{1,6}\s+[A-Z0-9][A-Z0-9 .'-]{2,80}\s+"
    r"(?:street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|lane|ln\.?|"
    r"boulevard|blvd\.?|court|ct\.?|way|circle|cir\.?|place|pl\.?|"
    r"parkway|pkwy\.?)\b",
    re.IGNORECASE,
)
_MEMBER_CONTEXT_NAME_PATTERN = re.compile(
    r"\b(member|patient|subscriber)\s+(?:is|was|named|name\s+is\s+)?"
    r"[A-Z][a-z]{1,40}(?:\s+[A-Z][a-z]{1,40}){1,2}\b",
    re.IGNORECASE,
)
_COMMA_NAME_PATTERN = re.compile(r"\b[A-Z][a-z]{1,40},\s*[A-Z][a-z]{1,40}\b")
_DIRECT_PHI_PATTERNS = (
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "<redacted_ssn>"),
    (re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE), "<redacted_email>"),
    (re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b"), "<redacted_phone>"),
)
_RESIDUAL_PHI_RISK_PATTERNS = (
    re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
    re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b"),
    _STREET_ADDRESS_PATTERN,
    _MEMBER_CONTEXT_NAME_PATTERN,
    _COMMA_NAME_PATTERN,
)
_VALID_MODULES = {
    "der",
    "appeals_mgmt",
    "grievance_mgmt",
    "auth_review",
    "authorizations",
    "ctm_mgmt",
    "provider_appeals_mgmt",
    "quality_of_care_mgmt",
    "ire_mgmt",
}


def _case_id_token_suffix(case_id: str) -> str:
    upper = case_id.upper()
    if upper.startswith("CTM"):
        return "C"
    if upper.startswith("EXRM"):
        return "I"
    if re.match(r"^\d{4,}[A-Z]{2,5}\d{1,}$", upper):
        return "H"
    if upper[0].isalpha():
        return upper[0]
    return "D"


def _detect_module_from_case_id(case_id: str) -> str | None:
    return detect_module_from_case_id(case_id) or detect_module(case_id)


def _redact_sensitive_text(text: str) -> str:
    """Mask common PHI/PII labels and formats before an LLM fallback call."""
    for pattern, replacement in _DIRECT_PHI_PATTERNS:
        text = pattern.sub(replacement, text)
    text = _STREET_ADDRESS_PATTERN.sub("<redacted_address>", text)
    text = _MEMBER_CONTEXT_NAME_PATTERN.sub(lambda match: f"{match.group(1)} <redacted_phi>", text)
    text = _COMMA_NAME_PATTERN.sub("<redacted_name>", text)
    return _SENSITIVE_LABEL_PATTERN.sub(
        lambda match: f"{match.group(1)}: <redacted_phi>",
        text,
    )


def _contains_residual_phi_risk(text: str) -> bool:
    """Return True if text still has high-risk PHI/PII after redaction."""
    return any(pattern.search(text) for pattern in _RESIDUAL_PHI_RISK_PATTERNS)


class LLMExtractor:
    """
    Calls Claude Haiku via AWS Bedrock to extract structured case update rows
    from an unrecognised worksheet.

    Only instantiated when the standard spreadsheet_parser returns no rows.
    Failure is always silent — returns [] so the caller can handle gracefully.
    """

    def __init__(self) -> None:
        cfg = _load_config()
        self.region = cfg.get("region", os.environ.get("AWS_REGION", "us-east-2"))
        self.model_id = cfg.get(
            "model_id", "us.anthropic.claude-haiku-4-5-20251001-v1:0"
        )
        self.max_tokens = int(cfg.get("max_tokens", 4096))
        self.temperature = float(cfg.get("temperature", 0.0))
        self._bedrock_client = self._make_client()

    def _make_client(self):
        try:
            import boto3
            return boto3.client("bedrock-runtime", region_name=self.region)
        except Exception:
            return None

    def build_system_prompt(self, mapper: FieldMapper) -> str:
        """Build a system prompt that includes the live field catalog."""
        catalog: dict[str, set] = {}
        for (table, _), mapping in mapper._map.items():
            catalog.setdefault(table, set()).add(mapping.ui_name)
        catalog_lines = []
        for table, names in sorted(catalog.items()):
            catalog_lines.append(f'  "{table}": {sorted(names)[:60]}')
        catalog_str = "\n".join(catalog_lines)

        return f"""You are a data extraction assistant for a healthcare case management system.

Your ONLY job is to read the content of a spreadsheet and output a single JSON object.

## Output format
Output MUST be valid JSON with this exact structure — no markdown fences, no explanation:
{{
  "rows": [
    {{
      "case_id": "string — the anonymous CASE token exactly as it appears (e.g. CASE_001_A, CASE_002_G, CASE_003_D)",
      "module": "string — one of: der, appeals_mgmt, grievance_mgmt, auth_review, authorizations, ctm_mgmt, provider_appeals_mgmt, quality_of_care_mgmt, ire_mgmt",
      "field_name": "string — the field name (see catalog below)",
      "old_value": "string or null — the old/current value if present, else null",
      "new_value": "string or null — the new/target value if present, else null"
    }}
  ]
}}

## Module detection rules
Real case numbers are replaced before you see the sheet. Use the CASE token suffix:
- CASE_*_A → appeals_mgmt
- CASE_*_G → grievance_mgmt
- CASE_*_H → auth_review or authorizations
- CASE_*_D → der or provider_appeals_mgmt; use surrounding sheet labels to choose
- CASE_*_C → ctm_mgmt
- CASE_*_Q → quality_of_care_mgmt
- CASE_*_I → ire_mgmt

## Field name catalog (match field labels from the sheet to these names)
{catalog_str}

## Anti-hallucination rules — STRICTLY ENFORCE
1. Every case_id you output MUST be a CASE token that appears verbatim in the sheet content below.
2. Every field_name you output MUST be from the catalog above OR clearly labeled in the sheet.
3. Every new_value you output MUST appear in the sheet content below (exact cell value or parseable date/number from it).
4. If you are not certain about a value, set it to null — do NOT invent values.
5. If a row says "blank", "remove", or "N/A" for new_value, set new_value to null.

## PHI rules
You will receive anonymous case tokens and redacted PHI/PII placeholders, not real case/member identifiers. Do NOT output any of these as field_name values: first_name, last_name, ssn, date_of_birth, address, phone, npi, medicare_no, medicaid_no, fax.

## Date format
Normalize all dates to: YYYY-MM-DD HH:MM:SS (24-hour). If time is missing, use 00:00:00.

Output only the JSON object. Nothing else."""

    def _load_text_field_map(self) -> dict[str, str]:
        """Load text_field_map.yaml — natural language → field name mappings."""
        try:
            import yaml
            config_path = os.path.join(os.path.dirname(__file__), "..", "config", "text_field_map.yaml")
            with open(os.path.normpath(config_path), encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            return {str(k).lower(): str(v) for k, v in data.items()}
        except Exception as e:
            print(f"Warning: could not load text_field_map.yaml: {e}")
            return {}

    def build_text_system_prompt(self, mapper: "FieldMapper") -> str:
        """System prompt for free-text input (Jira tickets, emails, etc.).
        Language → field name mappings are loaded from config/text_field_map.yaml.
        """
        # Build field catalog
        catalog: dict[str, set] = {}
        for (table, _), mapping in mapper._map.items():
            catalog.setdefault(table, set()).add(mapping.ui_name)
        catalog_lines = []
        for table, names in sorted(catalog.items()):
            catalog_lines.append(f'  "{table}": {sorted(names)[:60]}')
        catalog_str = "\n".join(catalog_lines)

        # Build language mappings section from config
        text_map = self._load_text_field_map()
        lang_lines = "\n".join(
            f'- "{phrase}" → "{field_name}"'
            for phrase, field_name in sorted(text_map.items())
        )

        return f"""You are a data extraction assistant for a healthcare case management system.

Your ONLY job is to read a Jira ticket description, email, or table and output a single JSON object.

## Output format
Output MUST be valid JSON — no markdown fences, no explanation:
{{
  "rows": [
    {{
      "case_id": "string — the anonymous CASE token exactly as it appears",
      "module": "string — one of: der, appeals_mgmt, grievance_mgmt, auth_review, authorizations, ctm_mgmt, provider_appeals_mgmt, quality_of_care_mgmt, ire_mgmt",
      "field_name": "string — the exact field name from the catalog below",
      "old_value": "string or null",
      "new_value": "string or null"
    }}
  ]
}}

## IMPORTANT: One row per field per case
If a single case needs multiple field updates, output one row per field.
Example: if GR123 needs Regulatory=No AND Executive Compliant=No, output two rows for GR123.

## Module detection rules
Real case numbers are replaced before you see the text. Use the CASE token suffix:
- CASE_*_A → appeals_mgmt
- CASE_*_G → grievance_mgmt
- CASE_*_H → auth_review or authorizations
- CASE_*_D → der or provider_appeals_mgmt; use surrounding text labels to choose
- CASE_*_C → ctm_mgmt
- CASE_*_Q → quality_of_care_mgmt
- CASE_*_I → ire_mgmt

## Field name catalog
{catalog_str}

## Common ticket language → field name mappings
{lang_lines}
- Any phrase not listed above → match to the closest field name in the catalog

## Anti-hallucination rules
1. Every case_id MUST be a CASE token that appears verbatim in the text below.
2. Every field_name MUST be from the catalog above or the language mappings.
3. Every new_value MUST be derivable from the text (exact value or parseable date).
4. If uncertain, set to null — do NOT invent values.
5. "yes"/"Yes" → "Yes", "no"/"No" → "No" for boolean fields.
6. "unpreventable" and similar fields not in catalog → skip (set to null and omit row).

## PHI rules
You will receive anonymous case tokens and redacted PHI/PII placeholders, not real case/member identifiers. Do NOT output any PHI/PII placeholders as field names or values.

## Date format
Normalize dates to: YYYY-MM-DD HH:MM:SS. If time missing, use 00:00:00.

Output only the JSON object. Nothing else."""

    def extract_from_text(self, text: str, mapper: "FieldMapper") -> list[SpreadsheetRow]:
        """
        Extract SpreadsheetRow list from free-form text (Jira ticket description,
        email body, table in markdown, etc.) using Claude.
        Returns [] on any failure — never raises.
        """
        try:
            system_prompt = self.build_text_system_prompt(mapper)
            anonymized_text, restore_map = self._anonymise_text(text)
            if _contains_residual_phi_risk(anonymized_text):
                print("[LLMExtractor] extract_from_text() blocked: residual PHI/PII risk after redaction")
                return []
            user_message = f"Extract case update rows from this text:\n\n{anonymized_text}"
            result = self._call_bedrock(system_prompt, user_message)
            if not result or "rows" not in result:
                return []

            rows: list[SpreadsheetRow] = []
            for i, item in enumerate(result["rows"]):
                token = str(item.get("case_id") or "").strip()
                field_name = str(item.get("field_name") or "").strip()
                module = str(item.get("module") or "").strip()
                new_value = item.get("new_value")
                old_value = item.get("old_value")
                case_id = restore_map.get(token)

                if not case_id or not field_name:
                    continue

                if not module or module not in _VALID_MODULES:
                    module = _detect_module_from_case_id(case_id)
                    if not module:
                        continue

                rows.append(SpreadsheetRow(
                    row_num=i + 1,
                    module=module,
                    case_id=case_id,
                    field_name=field_name,
                    old_value=str(old_value).strip() if old_value else None,
                    new_value=str(new_value).strip() if new_value else None,
                    reason="llm_extracted",
                ))

            return rows

        except Exception as e:
            print(f"[LLMExtractor] extract_from_text() failed: {e}")
            return []

    def _anonymise_text(self, text: str) -> tuple[str, dict[str, str]]:
        """Replace case identifiers with stable anonymous tokens before Bedrock."""
        restore_map: dict[str, str] = {}
        token_by_case_id: dict[str, str] = {}

        def replace(match: re.Match[str]) -> str:
            case_id = match.group(0)
            key = case_id.upper()
            token = token_by_case_id.get(key)
            if token is None:
                token = f"CASE_{len(token_by_case_id) + 1:03d}_{_case_id_token_suffix(case_id)}"
                token_by_case_id[key] = token
                restore_map[token] = case_id
            return token

        anonymized = _CASE_ID_PATTERN.sub(replace, text)
        return _redact_sensitive_text(anonymized), restore_map

    def _sheet_to_text(self, ws) -> str:
        """Convert worksheet to a compact text representation for the LLM."""
        lines = []
        for row in ws.iter_rows(
            min_row=1, max_row=min(ws.max_row, _MAX_SHEET_ROWS), values_only=False
        ):
            cells = []
            for cell in row[:_MAX_COLS]:
                v = cell.value
                if v is not None:
                    cells.append(str(v).strip())
            if cells:
                lines.append(" | ".join(cells))
        return "\n".join(lines)

    def _anonymise_sheet(self, ws) -> tuple[str, dict[str, str]]:
        """Convert a worksheet to text and anonymize case identifiers."""
        return self._anonymise_text(self._sheet_to_text(ws))

    def _call_bedrock(self, system_prompt: str, user_message: str) -> dict | None:
        """Send a request to Bedrock and return the parsed JSON response body."""
        if not self._bedrock_client:
            return None

        payload = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_message}],
        }

        try:
            response = self._bedrock_client.invoke_model(
                modelId=self.model_id,
                contentType="application/json",
                accept="application/json",
                body=json.dumps(payload),
            )
            body_str = response["body"].read().decode("utf-8")
            response_body = json.loads(body_str)
            text = response_body["content"][0]["text"].strip()
            # Strip markdown fences if present (e.g. ```json ... ```)
            if text.startswith("```"):
                text = text.split("\n", 1)[-1]
                if text.endswith("```"):
                    text = text.rsplit("```", 1)[0]
            return json.loads(text.strip())
        except Exception as e:
            print(f"[LLMExtractor] Bedrock call failed: {e}")
            return None

    def extract(self, ws, mapper: FieldMapper) -> list[SpreadsheetRow]:
        """
        Extract SpreadsheetRow list from an unstructured worksheet using Claude.
        Returns [] on any failure — never raises.
        """
        try:
            system_prompt = self.build_system_prompt(mapper)
            sheet_text, restore_map = self._anonymise_sheet(ws)
            if _contains_residual_phi_risk(sheet_text):
                print("[LLMExtractor] extract() blocked: residual PHI/PII risk after redaction")
                return []
            user_message = f"Extract case update rows from this spreadsheet content:\n\n{sheet_text}"

            result = self._call_bedrock(system_prompt, user_message)
            if not result or "rows" not in result:
                return []

            rows: list[SpreadsheetRow] = []
            for i, item in enumerate(result["rows"]):
                token = str(item.get("case_id") or "").strip()
                field_name = str(item.get("field_name") or "").strip()
                module = str(item.get("module") or "").strip()
                new_value = item.get("new_value")
                old_value = item.get("old_value")
                case_id = restore_map.get(token)

                if not case_id or not field_name:
                    continue

                if not module or module not in _VALID_MODULES:
                    module = _detect_module_from_case_id(case_id)
                    if not module:
                        continue

                rows.append(SpreadsheetRow(
                    row_num=i + 1,
                    module=module,
                    case_id=case_id,
                    field_name=field_name,
                    old_value=str(old_value).strip() if old_value else None,
                    new_value=str(new_value).strip() if new_value else None,
                    reason="llm_extracted",
                ))

            return rows

        except Exception as e:
            print(f"[LLMExtractor] extract() failed: {e}")
            return []
