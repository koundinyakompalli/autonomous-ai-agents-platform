from __future__ import annotations

import os
from dataclasses import dataclass

import openpyxl


@dataclass
class FieldMapping:
    table_name: str
    ui_name: str
    column_name: str
    ref_table: str | None
    ref_id_col: str | None
    ref_desc_col: str | None
    lov_expression: str | None
    calc_expression: str | None = None
    parent_columns: list[str] | None = None  # cascading: ordered list of parent column names


class FieldMapper:
    def __init__(self) -> None:
        # (table_name_lower, ui_name_lower) -> FieldMapping
        self._map: dict[tuple[str, str], FieldMapping] = {}
        # ui_name_lower -> list of FieldMapping (across all tables)
        self._by_ui: dict[str, list[FieldMapping]] = {}

    def load(self, xlsx_path: str) -> None:
        """Load a single xlsx file. Any sheet whose name starts with "CCIU" or "Mapping" is loaded."""
        wb = openpyxl.load_workbook(xlsx_path, data_only=True)
        sheets = [s for s in wb.sheetnames if s.upper().startswith("CCIU") or "MAPPING" in s.upper()]
        if not sheets:
            sheets = [wb.sheetnames[0]]  # fallback: first sheet
        for sheet_name in sheets:
            ws = wb[sheet_name]
            self._load_sheet(ws)

    def load_dir(self, folder: str) -> int:
        """Load all .xlsx mapping files in a folder.
        calc_expressions and cascading parent rules are now loaded live from
        the DB on activation — no CSV files are used."""
        before = len(self._map)
        for fname in sorted(os.listdir(folder)):
            if fname.startswith("~"):
                continue
            path = os.path.join(folder, fname)
            try:
                if fname.lower().endswith(".xlsx"):
                    self.load(path)
            except Exception as e:
                print(f"Warning: could not load {fname}: {e}")
        return len(self._map) - before

    def _load_sheet(self, ws) -> None:
        for row in ws.iter_rows(min_row=2, values_only=True):
            table, ui_name, col_name = row[0], row[1], row[2]
            if not table or not ui_name or not col_name:
                continue
            ref_table = row[3] if row[3] and row[3] != "NULL" else None
            ref_id = row[4] if row[4] and row[4] != "NULL" else None
            ref_desc = row[5] if row[5] and row[5] != "NULL" else None
            calc = row[8] if len(row) > 8 and row[8] and row[8] != "NULL" else None
            lov = row[9] if len(row) > 9 and row[9] and row[9] != "NULL" else None

            mapping = FieldMapping(
                table_name=str(table).lower(),
                ui_name=str(ui_name),
                column_name=str(col_name),
                ref_table=str(ref_table).lower() if ref_table else None,
                ref_id_col=str(ref_id).lower() if ref_id else None,
                ref_desc_col=str(ref_desc).lower() if ref_desc else None,
                lov_expression=str(lov) if lov else None,
                calc_expression=str(calc) if calc else None,
            )
            key = (mapping.table_name, mapping.ui_name.lower())
            # Preserve calc_expression from existing entry if this one doesn't have it
            existing = self._map.get(key)
            if existing and existing.calc_expression and not mapping.calc_expression:
                mapping.calc_expression = existing.calc_expression
            self._map[key] = mapping
            self._by_ui.setdefault(mapping.ui_name.lower(), []).append(mapping)

    async def load_from_db(self, pool) -> int:
        """Load (or refresh) mappings from data_loader_config + data_loader_config_fields.
        DB rows overwrite Excel rows for the same (table, ui_name) key.
        Returns number of mappings loaded from DB."""
        try:
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute("""
                        SELECT c.table_name, f.name, f.column_name,
                               f.reference_table, f.reference_table_id_column,
                               f.reference_column, f.lov_expression, f.calc_expression
                        FROM data_loader_config_fields f
                        JOIN data_loader_config c ON c.id = f.data_loader_config_id
                        WHERE f.column_name IS NOT NULL AND f.name IS NOT NULL
                          AND f.column_name != ''
                    """)
                    rows = await cur.fetchall()
            count = 0
            for table, ui_name, col_name, ref_table, ref_id, ref_desc, lov, calc in rows:
                ref_table = ref_table if ref_table and ref_table.strip() else None
                ref_id = ref_id if ref_id and ref_id.strip() else None
                ref_desc = ref_desc if ref_desc and ref_desc.strip() else None
                mapping = FieldMapping(
                    table_name=str(table).lower(),
                    ui_name=str(ui_name),
                    column_name=str(col_name),
                    ref_table=str(ref_table).lower() if ref_table else None,
                    ref_id_col=str(ref_id).lower() if ref_id else None,
                    ref_desc_col=str(ref_desc).lower() if ref_desc else None,
                    lov_expression=str(lov) if lov else None,
                    calc_expression=str(calc) if calc else None,
                )
                key = (mapping.table_name, mapping.ui_name.lower())
                # Excel calc_expression takes priority — it may be client-specific scoping
                # that the generic DB calc doesn't handle. If Excel has a calc, keep it
                # even when the DB supplies a different one.
                existing = self._map.get(key)
                if existing and existing.calc_expression:
                    mapping.calc_expression = existing.calc_expression
                self._map[key] = mapping
                self._by_ui.setdefault(mapping.ui_name.lower(), []).append(mapping)
                count += 1
            return count
        except Exception as e:
            print(f"Warning: could not load mappings from DB: {e}")
            return 0

    async def load_from_message_constant(self, pool) -> int:
        """
        Tier 3 fallback: load field mappings from message_constant table.

        message_constant stores per-client UI label overrides:
          label_title = what the operator sees (e.g. 'Clinical Appeal?')
          label_name  = encodes table + column via a known prefix convention
                        e.g. 'medAppealsCustomText1' → appeals_mgmt.custom_text1

        Only registers mappings where the derived column actually exists in the DB,
        and only if the (table, ui_name) key is not already mapped by a higher tier.
        Returns the number of new mappings added.
        """
        import re as _re

        # Prefix → table mapping — only prefixes whose suffix IS the column name
        _PREFIX_TABLE: dict[str, str] = {
            "medAppeals":         "appeals_mgmt",
            "medGrievance":       "grievance_mgmt",
            "medDer":             "der",
            "medCtm":             "ctm_mgmt",
            "medAuth":            "auth_review",
            "medIre":             "ire_mgmt",
            "medProviderAppeals": "provider_appeals_mgmt",
        }

        def _camel_to_snake(s: str) -> str:
            s = _re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", s)
            s = _re.sub(r"([a-z\d])([A-Z])", r"\1_\2", s)
            return s.lower()

        try:
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "SELECT label_name, label_title FROM message_constant "
                        "WHERE label_title IS NOT NULL AND label_name IS NOT NULL"
                    )
                    mc_rows = await cur.fetchall()

                    # Build set of existing columns per table (one query per table)
                    existing_cols: dict[str, set] = {}
                    for table in _PREFIX_TABLE.values():
                        await cur.execute(
                            "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
                            "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s",
                            (table,)
                        )
                        existing_cols[table] = {r[0].lower() for r in await cur.fetchall()}

            count = 0
            for label_name, label_title in mc_rows:
                title = label_title.strip().rstrip("?").strip()
                if not title:
                    continue
                for prefix, table in _PREFIX_TABLE.items():
                    if label_name.startswith(prefix) and len(label_name) > len(prefix):
                        col = _camel_to_snake(label_name[len(prefix):])
                        if not col:
                            continue
                        # Only register if column exists in the table
                        if col not in existing_cols.get(table, set()):
                            continue
                        key = (table, title.lower())
                        # Only register if not already mapped by a higher tier
                        if key in self._map:
                            break
                        mapping = FieldMapping(
                            table_name=table,
                            ui_name=title,
                            column_name=col,
                            ref_table=None,
                            ref_id_col=None,
                            ref_desc_col=None,
                            lov_expression=None,
                            calc_expression=None,
                        )
                        self._map[key] = mapping
                        self._by_ui.setdefault(title.lower(), []).append(mapping)
                        count += 1
                        break
            return count
        except Exception as e:
            print(f"Warning: could not load mappings from message_constant: {e}")
            return 0

    def get(self, table_name: str, ui_name: str) -> FieldMapping | None:
        key = (table_name.lower(), ui_name.lower())
        return self._map.get(key)

    def get_by_ui(self, ui_name: str) -> list[FieldMapping]:
        return self._by_ui.get(ui_name.lower(), [])

    # Parent table relationships — when a field isn't found on the child module,
    # also search these parent tables before giving up.
    _PARENT_TABLES: dict[str, list[str]] = {
        "auth_review": ["authorizations"],
    }

    def find_for_module(self, module_table: str, ui_name: str) -> FieldMapping | None:
        """Try exact match, then prefix match, then parent table fallback.

        Uses prefix match (t.startswith(tbl)) not substring match to avoid
        'appeals_mgmt' accidentally matching 'provider_appeals_mgmt'.
        """
        m = self.get(module_table, ui_name)
        if m:
            return m
        # Prefix match: mapped table must start with the requested module name.
        # e.g. 'der' matches 'der_child' but NOT 'provider_appeals_mgmt'
        tbl = module_table.lower()
        for (t, u), mapping in self._map.items():
            if t.startswith(tbl) and u == ui_name.lower():
                return mapping
        # Parent table fallback: some fields (e.g. Auth Request Type) live on the
        # parent authorizations table rather than auth_review
        for parent in self._PARENT_TABLES.get(tbl, []):
            m = self.get(parent, ui_name)
            if m:
                return m
        return None
