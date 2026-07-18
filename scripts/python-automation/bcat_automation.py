"""
BCAT Smart Automation - Multi-Scenario Support
BC Auto Ticket - Intelligently handles different Excel formats for Letters and Assessments.

SCENARIOS:
1. Letters: Excel with "letter" tab - creates one ticket per row, uses "Template Name" as title
2. Assessments: Excel with "assessment workbook" tab (indicator) - creates one ticket per tab with Excel attachment (excludes "assessment workbook" tab)
3. Upgrades: Excel with "upgrade" tab OR parent ticket request type is "BC Upgrade" - creates one ticket per sheet with Excel attachment + one CONFIG ENV tracking ticket
4. Solution Workbooks: Excel with "workbook index" tab (indicator) - creates one ticket per tab with Excel attachment (excludes "workbook index" tab)
5. Auto Tasking: Excel with "auto tasking" tab - creates one ticket per row with Excel attachment

COMPLETE WORKFLOW:
1. User manually creates CP Support ticket in JIRA (Request type: BC Implementation OR BC Upgrade)
2. User attaches Excel file with ticket data
3. User fills in the "Approvers" field with one or more approvers
4. User manually adds label "BCAT"
5. Agent detects BCAT label + Approvers field filled
6. IF parent ticket request type is "BC Upgrade" (ID: 120), FORCE Upgrades scenario
7. ELSE, Agent analyzes Excel structure and identifies scenario based on indicator tabs:
   - Letters: has "letter" tab
   - Assessments: has "assessment workbook" tab (indicator, not processed)
   - Upgrades: has "upgrade" tab
   - Solution Workbooks: has "workbook index" tab (indicator, not processed)
   - Auto Tasking: has "auto tasking" tab
8. Agent immediately creates all tickets from Excel data
9. For Upgrades scenario: Agent creates additional "Features needed - CONFIG ENV" tracking ticket (unassigned)
10. Agent links each created ticket to the original BCAT ticket (using "Relates" link type)
11. For Assessments/Upgrades/Solution Workbooks/Auto Tasking: Agent attaches Excel file to each ticket
12. Agent adds completion comment with results and ticket links

"""
import os
import sys
import time
import requests
from requests.auth import HTTPBasicAuth
import pandas as pd
from datetime import datetime
import json
from io import BytesIO
import io

# Fix Windows console encoding for emojis and special characters
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# Configuration
JIRA_SERVER = os.getenv("JIRA_SERVER", "https://mhkjira.atlassian.net")
JIRA_EMAIL = os.getenv("JIRA_EMAIL", "smulheron@mhk.com")
JIRA_API_TOKEN = os.getenv("JIRA_API_TOKEN")
if not JIRA_API_TOKEN:
    raise RuntimeError("Set JIRA_API_TOKEN before running this script.")

TARGET_PROJECT = "CPSUP"
TRIGGER_LABEL = "BCAT"  # BC Auto Ticket
PROCESSED_LABEL = "bcat-processed"  # Marks ticket as already processed
REQUEST_TYPE_ID = "119"  # BC Implementation
BC_UPGRADE_REQUEST_TYPE_ID = "237"  # BC Upgrade (CORRECTED)
REQUEST_TYPE_FIELD_ID = "customfield_10010"  # Request Type field in JSM

# Approvers field - JSM custom field for approvers
# To find this field ID, go to JIRA and inspect the field on a ticket
# Common values: customfield_10144, customfield_10145, etc.
APPROVERS_FIELD_ID = os.getenv('JIRA_APPROVERS_FIELD', 'customfield_10003')  # Update this if needed

# Team Queue field - JSM custom field for team queue assignment
TEAM_QUEUE_FIELD_ID = 'customfield_10289'  # Team (Queue)

# Customer field - JSM custom field for customer name
CUSTOMER_FIELD_ID = 'customfield_10047'  # Customer


class ExcelScenarioAnalyzer:
    """Analyze Excel structure to determine scenario type."""

    @staticmethod
    def detect_scenario(excel_file, filename):
        """
        Detect which scenario the Excel file represents.
        Returns: ('letters', data_dict) or ('assessments', data_dict) or (None, error_msg)
        """
        try:
            if filename.endswith('.csv'):
                # CSV is always treated as Letters (single sheet)
                df = pd.read_csv(excel_file)
                return 'letters', {'default': df}

            # Load Excel and check sheets
            xls = pd.ExcelFile(excel_file)
            sheet_names = xls.sheet_names

            print(f"  Found {len(sheet_names)} sheet(s): {sheet_names}")

            # Check for "upgrade" or "upgrades" sheet (case-insensitive) - HIGHEST PRIORITY
            upgrade_sheets = [s for s in sheet_names if 'upgrade' in s.lower()]

            if upgrade_sheets:
                # SCENARIO 3: Upgrades - has "upgrade" tabs
                # Process ALL sheets that have "upgrade" in the name
                print(f"  > Detected UPGRADES scenario (found {len(upgrade_sheets)} upgrade sheet(s))")
                sheets_data = {}
                for sheet in upgrade_sheets:
                    try:
                        df = pd.read_excel(excel_file, sheet_name=sheet)
                        if not df.empty:
                            sheets_data[sheet] = df
                    except Exception as e:
                        print(f"    Warning: Could not read sheet '{sheet}': {e}")

                if sheets_data:
                    print(f"  > Processing {len(sheets_data)} upgrade sheet(s)")
                    return 'upgrades', sheets_data
                else:
                    return None, "No readable upgrade sheets found in Excel"

            # Check for "workbook index" sheet as indicator for Solution Workbooks scenario
            workbook_index_sheets = [s for s in sheet_names if s.lower() == 'workbook index']

            if workbook_index_sheets:
                # SCENARIO 4: Solution Workbooks - has "workbook index" tab as first tab
                print(f"  > Detected SOLUTION WORKBOOKS scenario (found 'workbook index' indicator)")
                sheets_data = {}
                # Process all tabs EXCEPT "workbook index"
                for sheet in sheet_names:
                    if sheet.lower() == 'workbook index':
                        continue  # Skip the indicator tab
                    try:
                        df = pd.read_excel(excel_file, sheet_name=sheet)
                        if not df.empty:
                            sheets_data[sheet] = df
                    except Exception as e:
                        print(f"    Warning: Could not read sheet '{sheet}': {e}")

                if sheets_data:
                    print(f"  > Processing {len(sheets_data)} sheet(s) (excluding 'workbook index')")
                    return 'solution_workbooks', sheets_data
                else:
                    return None, "No readable sheets found in Solution Workbooks Excel (excluding 'workbook index')"

            # Check for "assessment workbook" sheet as indicator for Assessments scenario
            assessment_workbook_sheets = [s for s in sheet_names if s.lower() == 'assessment workbook']

            if assessment_workbook_sheets:
                # SCENARIO 2: Assessments - has "assessment workbook" tab as indicator
                print(f"  > Detected ASSESSMENTS scenario (found 'assessment workbook' indicator)")
                sheets_data = {}
                # Process all tabs EXCEPT "assessment workbook"
                for sheet in sheet_names:
                    if sheet.lower() == 'assessment workbook':
                        continue  # Skip the indicator tab
                    try:
                        df = pd.read_excel(excel_file, sheet_name=sheet)
                        if not df.empty:
                            sheets_data[sheet] = df
                    except Exception as e:
                        print(f"    Warning: Could not read sheet '{sheet}': {e}")

                if sheets_data:
                    print(f"  > Processing {len(sheets_data)} sheet(s) (excluding 'assessment workbook')")
                    return 'assessments', sheets_data
                else:
                    return None, "No readable sheets found in Assessments Excel (excluding 'assessment workbook')"

            # Check for "auto tasking" sheet (case-insensitive)
            auto_tasking_sheets = [s for s in sheet_names if 'auto tasking' in s.lower()]

            if auto_tasking_sheets:
                # SCENARIO 5: Auto Tasking - has an "auto tasking" tab
                print(f"  > Detected AUTO TASKING scenario (found sheet: {auto_tasking_sheets[0]})")
                df = pd.read_excel(excel_file, sheet_name=auto_tasking_sheets[0])
                return 'auto_tasking', {auto_tasking_sheets[0]: df}

            # Check for "letter" or "letters" sheet (case-insensitive)
            letter_sheets = [s for s in sheet_names if 'letter' in s.lower()]

            if letter_sheets:
                # SCENARIO 1: Letters - has a "letter" tab
                print(f"  > Detected LETTERS scenario (found sheet: {letter_sheets[0]})")
                df = pd.read_excel(excel_file, sheet_name=letter_sheets[0])
                return 'letters', {letter_sheets[0]: df}

            else:
                # No recognized scenario indicators found
                return None, f"Could not detect scenario. Excel must have one of: 'upgrade', 'workbook index', 'assessment workbook', 'auto tasking', or 'letter' tab"

        except Exception as e:
            return None, f"Error analyzing Excel: {e}"


class BCATSmartAutomation:
    """BCAT automation with intelligent scenario detection."""

    def __init__(self):
        self.server = JIRA_SERVER
        self.email = JIRA_EMAIL
        self.api_token = JIRA_API_TOKEN
        self.auth = HTTPBasicAuth(self.email, self.api_token)
        self.headers = {
            "Accept": "application/json",
            "Content-Type": "application/json"
        }
        self.analyzer = ExcelScenarioAnalyzer()

    def search_new_bcat_tickets(self):
        """Search for tickets with BCAT label and not yet processed."""
        url = f"{self.server}/rest/api/3/search/jql"
        # Removed Approvers field requirement for testing
        jql = f'labels = "{TRIGGER_LABEL}" AND labels != "{PROCESSED_LABEL}" AND status != Done ORDER BY created DESC'

        payload = {
            "jql": jql,
            "maxResults": 50,
            "fields": ["summary", "description", "attachment", "labels", "key", "status", REQUEST_TYPE_FIELD_ID, "assignee", "priority", APPROVERS_FIELD_ID, TEAM_QUEUE_FIELD_ID, CUSTOMER_FIELD_ID]
        }

        try:
            response = requests.post(url, json=payload, auth=self.auth, headers=self.headers)
            response.raise_for_status()
            data = response.json()
            return data.get("issues", [])
        except Exception as e:
            print(f"Error searching for BCAT tickets: {e}")
            return []

    def get_request_type_id(self, issue):
        """Extract request type ID from issue data."""
        try:
            request_type_field = issue["fields"].get(REQUEST_TYPE_FIELD_ID)
            if request_type_field:
                # Request type field can be string or nested dict with 'requestType' -> 'id'
                if isinstance(request_type_field, dict):
                    # Check for nested requestType structure (JSM v3 API)
                    if 'requestType' in request_type_field:
                        return request_type_field['requestType'].get('id', '')
                    # Fallback to direct id key
                    return request_type_field.get('id', '')
                return str(request_type_field)
            return None
        except Exception as e:
            print(f"Error extracting request type: {e}")
            return None

    def download_excel_attachment(self, issue_key):
        """Download Excel attachment from a JIRA issue."""
        url = f"{self.server}/rest/api/3/issue/{issue_key}"

        try:
            response = requests.get(url, auth=self.auth, headers=self.headers)
            response.raise_for_status()
            issue_data = response.json()

            attachments = issue_data.get("fields", {}).get("attachment", [])
            excel_files = [
                att for att in attachments
                if att["filename"].endswith(('.xlsx', '.xls', '.csv'))
            ]

            if not excel_files:
                print(f"No Excel files found in {issue_key}")
                return None, None

            excel_file = excel_files[-1]
            filename = excel_file["filename"]
            download_url = excel_file["content"]

            print(f"Downloading {filename} from {issue_key}...")
            file_response = requests.get(download_url, auth=self.auth)
            file_response.raise_for_status()

            return BytesIO(file_response.content), filename

        except Exception as e:
            print(f"Error downloading attachment from {issue_key}: {e}")
            return None, None

    def prepare_letters_data(self, sheets_data):
        """Prepare data for Letters scenario (rows from letter sheet)."""
        # Get the first/only sheet
        sheet_name = list(sheets_data.keys())[0]
        df = sheets_data[sheet_name]

        # Normalize column names
        df.columns = df.columns.str.strip().str.lower().str.replace(' ', '_')

        # Check for title column - prefer 'template_name', fallback to 'summary'
        title_column = None
        if 'template_name' in df.columns:
            title_column = 'template_name'
        elif 'summary' in df.columns:
            title_column = 'summary'
        else:
            return None, "Excel must have a 'Template Name' or 'summary' column for Letters scenario"

        # Remove empty rows based on title column
        df = df[df[title_column].notna() & (df[title_column].astype(str).str.strip() != '')]

        if len(df) == 0:
            return None, "No valid rows found in letter sheet"

        tickets_info = []
        for idx, row in df.iterrows():
            # Build ticket title from Template Name
            summary = str(row[title_column]).strip()

            # Build description from all other columns
            description_parts = []
            for col in df.columns:
                if col != title_column and pd.notna(row[col]) and str(row[col]).strip():
                    field_name = col.replace('_', ' ').title()
                    field_value = str(row[col]).strip()
                    description_parts.append(f"{field_name}: {field_value}")

            description = "\n".join(description_parts) if description_parts else ''

            tickets_info.append({
                'summary': summary,
                'description': description,
                'type': 'Letter',
                'source': f"Row {idx+1}"
            })

        return tickets_info, None

    def prepare_assessments_data(self, sheets_data):
        """Prepare data for Assessments scenario (one ticket per tab with Excel attachment).

        Note: 'assessment workbook' tab is excluded during detection and not passed to this method.
        """
        tickets_info = []

        for sheet_name, df in sheets_data.items():
            # Skip empty sheets
            if df.empty:
                continue

            # Build summary from sheet name
            summary = f"Assessment - {sheet_name}"

            # Build description with only assessment name and row count
            description_parts = [f"Assessment from sheet: {sheet_name}"]
            description_parts.append(f"Total rows: {len(df)}")
            description = "\n".join(description_parts)

            tickets_info.append({
                'summary': summary,
                'description': description,
                'type': 'Assessment',
                'source': f"Sheet: {sheet_name}",
                'sheet_name': sheet_name,
                'dataframe': df  # Include DataFrame for Excel attachment
            })

        if not tickets_info:
            return None, "No valid sheets found for Assessments"

        return tickets_info, None

    def prepare_upgrades_data(self, sheets_data, customer_name=""):
        """Prepare data for Upgrades scenario (one ticket per sheet tab with Technical Enabled rows).

        Creates ONE ticket per Excel sheet tab.
        Only includes rows where "Technical Enabled" column = "Technical Enabled".
        All Technical Enabled rows are included in the ticket description as an ADF table.

        Args:
            sheets_data: Dictionary of sheet_name -> DataFrame
            customer_name: Customer name from Customer field (customfield_10047) for intro text
        """
        import re

        tickets_info = []

        # Process each sheet in the workbook
        for sheet_name, df in sheets_data.items():
            original_columns = df.columns.tolist()

            # Find the "Technical Enabled" column (may have line breaks or special chars)
            tech_enabled_col = None
            for col in original_columns:
                col_clean = str(col).strip().replace('\r\n', ' ').replace('\n', ' ')
                if 'technical' in col_clean.lower() and 'enabled' in col_clean.lower():
                    tech_enabled_col = col
                    break

            if not tech_enabled_col:
                print(f"  Warning: No 'Technical Enabled' column found in sheet '{sheet_name}', skipping")
                continue

            # Filter rows where Technical Enabled column = "Technical Enabled"
            tech_enabled_value = df[tech_enabled_col].apply(
                lambda x: 'technical' in str(x).lower() and 'enabled' in str(x).lower()
            )
            tech_enabled_rows = df[tech_enabled_value]

            # Skip sheets with no Technical Enabled rows
            if len(tech_enabled_rows) == 0:
                print(f"  Warning: No Technical Enabled rows found in sheet '{sheet_name}', skipping")
                continue

            # Use sheet name as the summary (will be prefixed with client name later)
            summary = sheet_name[:255]

            # Map Excel columns to their normalized names for matching
            column_map = {}
            for col in original_columns:
                col_normalized = str(col).strip().lower().replace('\r\n', ' ').replace('\n', ' ').replace(' ', '_')
                column_map[col_normalized] = col

            # Build ADF table structure
            table_rows = []

            # Header row
            header_cells = []
            for header_text in ['Results', 'Release', 'Ticket #', 'Title', 'Technical Enabled', 'Configuration', 'Testing']:
                header_cells.append({
                    "type": "tableHeader",
                    "attrs": {},
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [
                                {
                                    "type": "text",
                                    "text": header_text
                                }
                            ]
                        }
                    ]
                })
            table_rows.append({
                "type": "tableRow",
                "content": header_cells
            })

            # Data rows
            for idx, row in tech_enabled_rows.iterrows():
                data_cells = []

                # Results column
                results_col = self._find_column(column_map, ['results', 'result'])
                results_val = str(row[results_col]).strip() if results_col and not pd.isna(row[results_col]) else ''
                data_cells.append(self._create_table_cell(results_val))

                # Release column
                release_col = self._find_column(column_map, ['release'])
                release_val = str(row[release_col]).strip() if release_col and not pd.isna(row[release_col]) else ''
                data_cells.append(self._create_table_cell(release_val))

                # Ticket # column (with hyperlink)
                ticket_col = self._find_column(column_map, ['ticket', 'ticket_#', 'ticket_number'])
                ticket_val = str(row[ticket_col]).strip() if ticket_col and not pd.isna(row[ticket_col]) else ''
                # Extract ticket keys for hyperlinking
                ticket_pattern = r'\b([A-Z]{2,10}-\d+)\b'
                ticket_matches = re.findall(ticket_pattern, ticket_val)
                if ticket_matches:
                    # Create cell with hyperlinks
                    data_cells.append(self._create_table_cell_with_links(ticket_val, ticket_matches))
                else:
                    data_cells.append(self._create_table_cell(ticket_val))

                # Title column
                title_col = self._find_column(column_map, ['title', 'feature_name', 'feature'])
                title_val = str(row[title_col]).strip() if title_col and not pd.isna(row[title_col]) else ''
                data_cells.append(self._create_table_cell(title_val))

                # Technical Enabled column
                tech_enabled_val = str(row[tech_enabled_col]).strip() if not pd.isna(row[tech_enabled_col]) else ''
                data_cells.append(self._create_table_cell(tech_enabled_val))

                # Configuration column
                config_col = self._find_column(column_map, ['configuration', 'config'])
                config_val = str(row[config_col]).strip() if config_col and not pd.isna(row[config_col]) else ''
                data_cells.append(self._create_table_cell(config_val))

                # Testing column (empty as requested)
                data_cells.append(self._create_table_cell(''))

                table_rows.append({
                    "type": "tableRow",
                    "content": data_cells
                })

            # Create ADF description structure with intro paragraph + table
            description_adf = []

            # Add introductory paragraph
            intro_text = f"ALL configuration items completed in {customer_name} CONFIG1." if customer_name else "ALL configuration items completed in CONFIG1."
            description_adf.append({
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": intro_text
                    }
                ]
            })

            # Add table
            description_adf.append({
                "type": "table",
                "attrs": {
                    "isNumberColumnEnabled": False,
                    "layout": "default"
                },
                "content": table_rows
            })

            # Store the entire sheet for Excel attachment
            tickets_info.append({
                'summary': summary,
                'description_adf': description_adf,
                'type': 'Upgrade',
                'source': f"Sheet: {sheet_name}",
                'sheet_name': sheet_name,
                'dataframe': df  # Include entire sheet for Excel attachment
            })

        if not tickets_info:
            return None, "No sheets with Technical Enabled rows found in Upgrades Excel"

        return tickets_info, None

    def _find_column(self, column_map, possible_names):
        """Helper to find a column by checking multiple possible normalized names."""
        for name in possible_names:
            if name in column_map:
                return column_map[name]
        return None

    def _create_table_cell(self, text):
        """Create an ADF table cell with plain text."""
        return {
            "type": "tableCell",
            "attrs": {},
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": text
                        }
                    ] if text else []
                }
            ]
        }

    def _create_table_cell_with_links(self, text, ticket_keys):
        """Create an ADF table cell with JIRA ticket hyperlinks."""
        import re

        content_parts = []
        last_end = 0
        ticket_pattern = r'\b([A-Z]{2,10}-\d+)\b'

        for match in re.finditer(ticket_pattern, text):
            # Add text before the match
            if match.start() > last_end:
                content_parts.append({
                    "type": "text",
                    "text": text[last_end:match.start()]
                })

            # Add hyperlink
            ticket_key = match.group(1)
            content_parts.append({
                "type": "text",
                "text": ticket_key,
                "marks": [
                    {
                        "type": "link",
                        "attrs": {
                            "href": f"{self.server}/browse/{ticket_key}"
                        }
                    }
                ]
            })

            last_end = match.end()

        # Add remaining text
        if last_end < len(text):
            content_parts.append({
                "type": "text",
                "text": text[last_end:]
            })

        return {
            "type": "tableCell",
            "attrs": {},
            "content": [
                {
                    "type": "paragraph",
                    "content": content_parts if content_parts else []
                }
            ]
        }

    def prepare_solution_workbooks_data(self, sheets_data):
        """Prepare data for Solution Workbooks scenario (one ticket per tab with Excel attachment).

        Note: 'workbook index' tab is excluded during detection and not passed to this method.
        """
        tickets_info = []

        for sheet_name, df in sheets_data.items():
            # Skip empty sheets
            if df.empty:
                continue

            # Use sheet name as the ticket title
            summary = sheet_name

            # Build description with sheet name and row count
            description_parts = [f"Solution Workbook from sheet: {sheet_name}"]
            description_parts.append(f"Total rows: {len(df)}")
            description = "\n".join(description_parts)

            tickets_info.append({
                'summary': summary,
                'description': description,
                'type': 'Solution Workbook',
                'source': f"Sheet: {sheet_name}",
                'sheet_name': sheet_name,
                'dataframe': df  # Include DataFrame for Excel attachment
            })

        if not tickets_info:
            return None, "No valid sheets found for Solution Workbooks"

        return tickets_info, None

    def prepare_auto_tasking_data(self, sheets_data):
        """Prepare data for Auto Tasking scenario (one ticket per row with Excel attachment)."""
        # Get the first/only sheet
        sheet_name = list(sheets_data.keys())[0]
        df = sheets_data[sheet_name]

        # Normalize column names
        df.columns = df.columns.str.strip().str.lower().str.replace(' ', '_')

        # Check for required columns - prefer 'summary' or 'task' or 'title'
        title_column = None
        if 'summary' in df.columns:
            title_column = 'summary'
        elif 'task' in df.columns:
            title_column = 'task'
        elif 'title' in df.columns:
            title_column = 'title'
        elif 'task_name' in df.columns:
            title_column = 'task_name'
        else:
            return None, "Excel must have a 'summary', 'task', 'title', or 'task_name' column for Auto Tasking scenario"

        # Remove empty rows based on title column
        df = df[df[title_column].notna() & (df[title_column].astype(str).str.strip() != '')]

        if len(df) == 0:
            return None, "No valid rows found in auto tasking sheet"

        tickets_info = []
        for idx, row in df.iterrows():
            # Build summary from title column
            summary = str(row[title_column]).strip()

            # Build description from all available columns except title column
            description_parts = []
            for col in df.columns:
                if col != title_column and pd.notna(row[col]) and str(row[col]).strip():
                    field_name = col.replace('_', ' ').title()
                    field_value = str(row[col]).strip()
                    description_parts.append(f"{field_name}: {field_value}")

            description = "\n".join(description_parts) if description_parts else "Auto Tasking request"

            # Store the entire dataframe for Excel attachment (single row)
            single_row_df = pd.DataFrame([row])

            tickets_info.append({
                'summary': summary,
                'description': description,
                'type': 'Auto Tasking',
                'source': f"Row {idx+1}",
                'row_index': idx,
                'dataframe': single_row_df  # Include single row for Excel attachment
            })

        return tickets_info, None

    def add_comment(self, issue_key, comment_text):
        """Add comment to a JIRA issue."""
        url = f"{self.server}/rest/api/3/issue/{issue_key}/comment"

        payload = {
            "body": {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {
                                "type": "text",
                                "text": comment_text
                            }
                        ]
                    }
                ]
            }
        }

        try:
            response = requests.post(url, json=payload, headers=self.headers, auth=self.auth)
            response.raise_for_status()
            print(f"Added comment to {issue_key}")
            return True
        except Exception as e:
            print(f"Error adding comment: {e}")
            return False

    def add_label(self, issue_key, label):
        """Add a label to a JIRA issue."""
        url = f"{self.server}/rest/api/3/issue/{issue_key}"

        payload = {
            "update": {
                "labels": [{"add": label}]
            }
        }

        try:
            response = requests.put(url, json=payload, headers=self.headers, auth=self.auth)
            response.raise_for_status()
            return True
        except Exception as e:
            print(f"Error adding label: {e}")
            return False

    def attach_file_to_ticket(self, issue_key, file_content, filename):
        """Attach a file to a JIRA ticket."""
        url = f"{self.server}/rest/api/3/issue/{issue_key}/attachments"

        headers = {
            "X-Atlassian-Token": "no-check"
        }

        files = {
            'file': (filename, file_content, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        }

        try:
            response = requests.post(url, files=files, headers=headers, auth=self.auth)
            response.raise_for_status()
            print(f"    ↳ Attached {filename}")
            return True
        except Exception as e:
            print(f"    ⚠ Could not attach file: {e}")
            return False

    def create_single_sheet_excel(self, df, sheet_name):
        """Create an Excel file with a single sheet from a DataFrame."""
        from io import BytesIO
        output = BytesIO()

        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            df.to_excel(writer, sheet_name=sheet_name, index=False)

        output.seek(0)
        return output

    def link_ticket_to_parent(self, child_ticket_key, parent_ticket_key):
        """Create a link between the created ticket and the original BCAT ticket."""
        url = f"{self.server}/rest/api/3/issueLink"

        payload = {
            "type": {
                "name": "Relates"  # Use "Relates" link type (most common)
            },
            "inwardIssue": {
                "key": child_ticket_key
            },
            "outwardIssue": {
                "key": parent_ticket_key
            }
        }

        try:
            response = requests.post(url, json=payload, headers=self.headers, auth=self.auth)
            response.raise_for_status()
            print(f"    ↳ Linked to {parent_ticket_key}")
            return True
        except Exception as e:
            print(f"    ⚠ Could not link to parent: {e}")
            return False

    def remove_label(self, issue_key, label):
        """Remove a label from a JIRA issue."""
        url = f"{self.server}/rest/api/3/issue/{issue_key}"

        payload = {
            "update": {
                "labels": [{"remove": label}]
            }
        }

        try:
            response = requests.put(url, json=payload, headers=self.headers, auth=self.auth)
            response.raise_for_status()
            return True
        except Exception as e:
            print(f"Error removing label: {e}")
            return False

    def create_cpsup_ticket(self, summary, description="", description_adf=None, labels=None, assignee=None, priority=None, request_type_id=None, approvers=None, team_queue=None, customer=None):
        """Create a CP Support ticket with optional fields copied from parent.

        Args:
            description: Plain text description (will be wrapped in paragraph)
            description_adf: Raw ADF content array (use instead of description for tables)
            customer: Customer field value (customfield_10047) to copy from parent
        """
        url = f"{self.server}/rest/api/3/issue"

        # Use ADF content if provided, otherwise wrap plain text in paragraph
        if description_adf:
            description_content = description_adf
        else:
            description_content = [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": description
                        }
                    ]
                }
            ]

        payload = {
            "fields": {
                "project": {"key": TARGET_PROJECT},
                "summary": summary,
                "description": {
                    "type": "doc",
                    "version": 1,
                    "content": description_content
                },
                "issuetype": {"name": "Service request"},
                "customfield_10010": request_type_id or REQUEST_TYPE_ID
            }
        }

        # Copy optional fields from parent ticket
        if labels:
            payload["fields"]["labels"] = labels if isinstance(labels, list) else [labels]

        if assignee:
            payload["fields"]["assignee"] = {"accountId": assignee}

        if priority:
            payload["fields"]["priority"] = {"name": priority}

        if approvers:
            payload["fields"][APPROVERS_FIELD_ID] = approvers

        if team_queue:
            payload["fields"][TEAM_QUEUE_FIELD_ID] = team_queue

        if customer:
            payload["fields"][CUSTOMER_FIELD_ID] = customer

        try:
            response = requests.post(url, json=payload, headers=self.headers, auth=self.auth)
            response.raise_for_status()
            result = response.json()
            return result["key"]
        except Exception as e:
            print(f"Error creating ticket: {e}")
            return None

    def process_new_ticket(self, issue):
        """Process a new BCAT ticket - create tickets immediately if approvers field is filled."""
        issue_key = issue["key"]
        issue_summary = issue["fields"]["summary"]
        approvers = issue["fields"].get(APPROVERS_FIELD_ID)

        print(f"\n{'='*60}")
        print(f"Processing BCAT ticket: {issue_key}")
        print(f"Summary: {issue_summary}")
        if approvers:
            if isinstance(approvers, list):
                approver_names = [a.get('displayName', 'Unknown') for a in approvers if isinstance(a, dict)]
                print(f"Approvers: {', '.join(approver_names)}")
            elif isinstance(approvers, dict):
                print(f"Approver: {approvers.get('displayName', 'Unknown')}")
            else:
                print(f"Approvers: {approvers}")
        print(f"{'='*60}\n")

        # Check request type - if BC Upgrade, force Upgrades scenario
        request_type_id = self.get_request_type_id(issue)
        force_upgrades_scenario = False

        if request_type_id == BC_UPGRADE_REQUEST_TYPE_ID:
            print(f"Request type is BC Upgrade (ID: {BC_UPGRADE_REQUEST_TYPE_ID}) - forcing UPGRADES scenario")
            force_upgrades_scenario = True

        # Download Excel
        excel_file, filename = self.download_excel_attachment(issue_key)

        if not excel_file:
            self.add_comment(
                issue_key,
                "⚠️ BCAT Error: No Excel file found.\n\n"
                "Please attach an Excel file (.xlsx, .xls, or .csv)"
            )
            self.add_label(issue_key, PROCESSED_LABEL)
            return False

        # Detect scenario (or force Upgrades if BC Upgrade request type)
        if force_upgrades_scenario:
            print("  > Forcing UPGRADES scenario (BC Upgrade request type)")
            # Load all Excel sheets for Upgrades scenario
            try:
                if filename.endswith('.csv'):
                    df = pd.read_csv(excel_file)
                    scenario_type = 'upgrades'
                    data = {'default': df}
                else:
                    xls = pd.ExcelFile(excel_file)
                    sheet_names = xls.sheet_names
                    print(f"  Found {len(sheet_names)} sheet(s): {sheet_names}")

                    # Load ALL sheets for Upgrades scenario (one ticket per sheet)
                    if sheet_names:
                        sheets_data = {}
                        for sheet in sheet_names:
                            try:
                                df = pd.read_excel(excel_file, sheet_name=sheet)
                                if not df.empty:
                                    sheets_data[sheet] = df
                            except Exception as e:
                                print(f"    Warning: Could not read sheet '{sheet}': {e}")

                        if sheets_data:
                            scenario_type = 'upgrades'
                            data = sheets_data
                        else:
                            self.add_comment(issue_key, "⚠️ BCAT Error: No readable sheets found in Excel")
                            self.add_label(issue_key, PROCESSED_LABEL)
                            return False
                    else:
                        self.add_comment(issue_key, "⚠️ BCAT Error: Excel file has no sheets")
                        self.add_label(issue_key, PROCESSED_LABEL)
                        return False
            except Exception as e:
                self.add_comment(issue_key, f"⚠️ BCAT Error: Could not read Excel file: {e}")
                self.add_label(issue_key, PROCESSED_LABEL)
                return False
        else:
            print("Analyzing Excel structure...")
            scenario_type, data = self.analyzer.detect_scenario(excel_file, filename)

        if scenario_type is None:
            self.add_comment(
                issue_key,
                f"⚠️ BCAT Error: {data}\n\n"
                "Supported scenarios:\n"
                "  1. Letters: Excel with 'letter' tab (creates tickets from rows, requires 'Template Name' column)\n"
                "  2. Assessments: Excel with 'assessment workbook' tab as indicator (creates one ticket per tab, excludes 'assessment workbook')\n"
                "  3. Upgrades: Excel with 'upgrade' tab (creates tickets from rows with Excel attachment)\n"
                "  4. Solution Workbooks: Excel with 'workbook index' tab as indicator (creates one ticket per tab, excludes 'workbook index')\n"
                "  5. Auto Tasking: Excel with 'auto tasking' tab (creates tickets from rows with Excel attachment)"
            )
            self.add_label(issue_key, PROCESSED_LABEL)
            return False

        # Extract customer name from Customer field (for title prefix and upgrades intro text)
        customer_name = ""
        customer_field = issue.get("fields", {}).get(CUSTOMER_FIELD_ID)
        if customer_field:
            # Customer field is a list of objects with 'value' key
            if isinstance(customer_field, list) and len(customer_field) > 0:
                customer_name = customer_field[0].get('value', '')
            elif isinstance(customer_field, dict):
                customer_name = customer_field.get('value', '')
            print(f"  Customer: '{customer_name}'")

        # Prepare tickets based on scenario
        if scenario_type == 'letters':
            tickets_info, error = self.prepare_letters_data(data)
        elif scenario_type == 'upgrades':
            tickets_info, error = self.prepare_upgrades_data(data, customer_name)
        elif scenario_type == 'solution_workbooks':
            tickets_info, error = self.prepare_solution_workbooks_data(data)
        elif scenario_type == 'auto_tasking':
            tickets_info, error = self.prepare_auto_tasking_data(data)
        else:  # assessments
            tickets_info, error = self.prepare_assessments_data(data)

        if tickets_info is None:
            self.add_comment(issue_key, f"⚠️ BCAT Error: {error}")
            self.add_label(issue_key, PROCESSED_LABEL)
            return False

        # Immediately create tickets
        ticket_count = len(tickets_info)
        if scenario_type == 'letters':
            scenario_name = "LETTERS"
        elif scenario_type == 'upgrades':
            scenario_name = "UPGRADES"
        elif scenario_type == 'solution_workbooks':
            scenario_name = "SOLUTION WORKBOOKS"
        elif scenario_type == 'auto_tasking':
            scenario_name = "AUTO TASKING"
        else:
            scenario_name = "ASSESSMENTS"

        print(f"Creating {ticket_count} {scenario_name} tickets...")

        # Use client prefix extracted earlier for prefixing sub-tickets
        if customer_name:
            print(f"  Using customer name for title prefix: '{customer_name}'")

        # Extract parent ticket fields to copy to sub-tickets
        parent_fields = issue.get("fields", {})
        parent_assignee = parent_fields.get("assignee")
        parent_assignee_id = parent_assignee.get("accountId") if parent_assignee else None
        parent_priority = parent_fields.get("priority")
        parent_priority_name = parent_priority.get("name") if parent_priority else None
        parent_request_type_id = request_type_id  # Already extracted earlier
        parent_approvers = parent_fields.get(APPROVERS_FIELD_ID)
        parent_team_queue = parent_fields.get(TEAM_QUEUE_FIELD_ID)
        parent_customer = customer_field  # Customer field to copy to sub-tickets

        # For Upgrades scenario, do NOT copy assignee (leave unassigned)
        if scenario_type == 'upgrades':
            parent_assignee_id = None
            print(f"  Upgrades scenario: Leaving assignee unassigned")
        elif parent_assignee_id:
            print(f"  Copying assignee: {parent_assignee.get('displayName', 'Unknown')}")

        if parent_priority_name:
            print(f"  Copying priority: {parent_priority_name}")
        if parent_team_queue:
            team_queue_value = parent_team_queue.get('value') if isinstance(parent_team_queue, dict) else parent_team_queue
            print(f"  Copying team queue: {team_queue_value}")
        if parent_customer and customer_name:
            print(f"  Copying customer: {customer_name}")

        # Add processing comment
        process_comment = f"🤖 BCAT Automation - Processing\n\n📊 Scenario: {scenario_name}\n  • File: {filename}\n  • Creating {ticket_count} tickets..."
        self.add_comment(issue_key, process_comment)

        # Create tickets
        created_keys = []
        failed = []
        total = len(tickets_info)

        for idx, ticket_info in enumerate(tickets_info, 1):
            try:
                labels = [
                    'bcat-auto-created',
                    f'from-{issue_key}',
                    f'bcat-{scenario_type}'
                ]

                # Add customer name prefix to summary if available
                summary = ticket_info['summary']
                if customer_name and not summary.startswith(customer_name):
                    summary = f"{customer_name} | {summary}"

                # Create ticket with parent fields copied
                # Use ADF description if available (for tables), otherwise use plain text
                if 'description_adf' in ticket_info:
                    ticket_key = self.create_cpsup_ticket(
                        summary=summary,
                        description_adf=ticket_info['description_adf'],
                        labels=labels,
                        assignee=parent_assignee_id,
                        priority=parent_priority_name,
                        request_type_id=parent_request_type_id,
                        approvers=parent_approvers,
                        team_queue=parent_team_queue,
                        customer=parent_customer
                    )
                else:
                    ticket_key = self.create_cpsup_ticket(
                        summary=summary,
                        description=ticket_info['description'],
                        labels=labels,
                        assignee=parent_assignee_id,
                        priority=parent_priority_name,
                        request_type_id=parent_request_type_id,
                        approvers=parent_approvers,
                        team_queue=parent_team_queue,
                        customer=parent_customer
                    )

                if ticket_key:
                    created_keys.append((ticket_key, ticket_info['summary']))
                    print(f"  [{idx}/{total}] ✓ {ticket_key}: {ticket_info['summary']}")

                    # Link the created ticket back to the original BCAT ticket
                    try:
                        self.link_ticket_to_parent(ticket_key, issue_key)
                    except Exception as link_error:
                        print(f"    ⚠ Could not link ticket: {link_error}")

                    # For ASSESSMENTS, UPGRADES, SOLUTION_WORKBOOKS, and AUTO_TASKING, attach the Excel file
                    if scenario_type in ['assessments', 'upgrades', 'solution_workbooks', 'auto_tasking'] and 'dataframe' in ticket_info:
                        try:
                            if scenario_type in ['assessments', 'solution_workbooks', 'upgrades']:
                                # Use the actual sheet name from the ticket info
                                sheet_name = ticket_info.get('sheet_name', f'Sheet_{idx}')
                            else:  # auto_tasking
                                sheet_name = f"Task_{idx}"

                            excel_content = self.create_single_sheet_excel(
                                ticket_info['dataframe'],
                                sheet_name
                            )
                            sanitized_name = sheet_name.replace('/', '-').replace('\\', '-')
                            attachment_filename = f"{sanitized_name}.xlsx"
                            self.attach_file_to_ticket(ticket_key, excel_content, attachment_filename)
                        except Exception as attach_error:
                            print(f"    ⚠ Could not attach Excel: {attach_error}")
                else:
                    failed.append(f"{ticket_info['source']}: {ticket_info['summary']}")
                    print(f"  [{idx}/{total}] ✗ Failed: {ticket_info['summary']}")

                time.sleep(0.5)

            except Exception as e:
                failed.append(f"{ticket_info['source']}: {str(e)}")
                print(f"  [{idx}/{total}] ✗ Error: {e}")

        # For Upgrades scenario, create additional CONFIG ENV tracking ticket
        if scenario_type == 'upgrades' and len(created_keys) > 0:
            print(f"\n  Creating CONFIG ENV tracking ticket...")

            # Build description with links to all created upgrade tickets
            config_description_parts = [
                "This ticket tracks all configuration changes required for the upgrade implementation.",
                "",
                "Related upgrade tickets:"
            ]

            for key, summary in created_keys:
                config_description_parts.append(f"• {key} - {summary}")
                config_description_parts.append(f"  {self.server}/browse/{key}")

            config_description_parts.append("")
            config_description_parts.append(f"Total upgrade tickets: {len(created_keys)}")
            config_description_parts.append("")
            config_description_parts.append(
                "Please verify all configuration changes have been applied in the CONFIG "
                "environment before promoting to production."
            )

            # Build summary with customer name prefix
            config_summary = f"{customer_name} | Features needed - CONFIG ENV" if customer_name else "Features needed - CONFIG ENV"

            # Create CONFIG ENV ticket - same fields as other upgrade tickets (unassigned)
            config_ticket_key = self.create_cpsup_ticket(
                summary=config_summary,
                description="\n".join(config_description_parts),
                labels=[
                    'bcat-auto-created',
                    'config-env',
                    f'from-{issue_key}',
                    'bcat-upgrades'
                ],
                assignee=parent_assignee_id,  # Will be None for Upgrades scenario
                priority=parent_priority_name,
                request_type_id=parent_request_type_id,
                approvers=parent_approvers,
                team_queue=parent_team_queue,
                customer=parent_customer
            )

            if config_ticket_key:
                created_keys.append((config_ticket_key, config_summary))
                print(f"  ✓ CONFIG ENV ticket created: {config_ticket_key}")

                # Link CONFIG ENV ticket to parent
                try:
                    self.link_ticket_to_parent(config_ticket_key, issue_key)
                except Exception as link_error:
                    print(f"    ⚠ Could not link CONFIG ENV ticket: {link_error}")
            else:
                failed.append(f"CONFIG ENV ticket: {config_summary}")
                print(f"  ✗ Failed to create CONFIG ENV ticket")

        # Build completion comment
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

        comment_lines = [
            f"✅ BCAT Automation Complete",
            f"",
            f"⏰ Completed: {timestamp}",
            f"📊 Scenario: {scenario_name}",
            f"",
            f"Results:",
            f"  • Total: {total}",
            f"  • Created: {len(created_keys)}",
            f"  • Failed: {len(failed)}",
            f"",
        ]

        if created_keys:
            comment_lines.append("✅ Created tickets:")
            for key, summary in created_keys:
                comment_lines.append(f"  • {key} - {summary}")
                comment_lines.append(f"    {self.server}/browse/{key}")

        if failed:
            comment_lines.append("")
            comment_lines.append("❌ Failed:")
            for fail in failed:
                comment_lines.append(f"  • {fail}")

        self.add_comment(issue_key, "\n".join(comment_lines))

        # Mark as processed
        self.add_label(issue_key, PROCESSED_LABEL)

        print(f"\n✓ Completed: {len(created_keys)}/{total} tickets created")
        return True

    def run_once(self):
        """Run automation once."""
        processed = 0

        # Process new tickets with BCAT label and Approvers field filled
        print(f"Checking for {TRIGGER_LABEL} tickets with Approvers field filled...")
        new_issues = self.search_new_bcat_tickets()

        if new_issues:
            print(f"Found {len(new_issues)} ticket(s) to process\n")
            for issue in new_issues:
                try:
                    self.process_new_ticket(issue)
                    processed += 1
                except Exception as e:
                    print(f"Error processing {issue['key']}: {e}")
        else:
            print("No tickets to process")

        return processed

    def run_continuous(self, interval_seconds=60):
        """Run automation continuously."""
        print(f"Starting BCAT Smart Automation...")
        print(f"Checking every {interval_seconds} seconds")
        print(f"Trigger: {TRIGGER_LABEL} label + Approvers field filled")
        print(f"Approvers Field ID: {APPROVERS_FIELD_ID}")
        print(f"Supported scenarios: Letters, Assessments, Upgrades, Solution Workbooks, Auto Tasking")
        print(f"Tickets will be created immediately when conditions are met")
        print(f"Press Ctrl+C to stop\n")

        try:
            while True:
                processed = self.run_once()

                if processed > 0:
                    print(f"\nProcessed {processed} ticket(s). Waiting {interval_seconds}s...\n")
                else:
                    print(f"No tickets to process. Checking again in {interval_seconds}s...\n")

                time.sleep(interval_seconds)

        except KeyboardInterrupt:
            print("\n\nStopping BCAT automation...")


def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description='BCAT Smart Automation - Multi-Scenario Support',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Supported Scenarios:
  1. LETTERS: Excel with 'letter' tab
     - Creates one ticket per row in the letter sheet
     - Uses 'Template Name' column as ticket title
     - All other columns become the description

  2. ASSESSMENTS: Excel with 'assessment workbook' tab (indicator)
     - First tab must be named 'assessment workbook' (case-insensitive)
     - Creates one ticket per sheet/tab (excludes 'assessment workbook' tab)
     - Each assessment tab becomes a separate ticket with its name as the title
     - Attaches Excel file to each ticket

  3. UPGRADES: Excel with 'upgrade' tab OR parent ticket request type is "BC Upgrade" (ID: 120)
     - If request type is "BC Upgrade", Upgrades scenario is forced regardless of Excel structure
     - Creates one ticket per row in the upgrade sheet
     - Attaches Excel file (single row) to each ticket
     - Flexible columns: summary, system, current_version, target_version, etc.

  4. SOLUTION WORKBOOKS: Excel with 'workbook index' tab (indicator)
     - First tab must be named 'workbook index' (case-insensitive)
     - Creates one ticket per sheet/tab (excludes 'workbook index' tab)
     - Tab name becomes the ticket title
     - Attaches Excel file to each ticket

  5. AUTO TASKING: Excel with 'auto tasking' tab
     - Creates one ticket per row in the auto tasking sheet
     - Attaches Excel file (single row) to each ticket
     - Uses 'summary', 'task', 'title', or 'task_name' column as ticket title
     - All other columns become the description

Workflow:
  1. Create ticket in JIRA and attach Excel file
  2. Fill in the "Approvers" field with one or more approvers
  3. Add label "BCAT"
  4. Automation detects label + Approvers field and creates tickets immediately
  5. Each created ticket is linked to the original BCAT ticket (using "Relates" link)
  6. Automation adds completion comment with created ticket links

Configuration:
  Set JIRA_APPROVERS_FIELD environment variable if the default field ID doesn't work
  Default: customfield_10144

Examples:
  # Run once
  python bcat_smart_automation.py

  # Run continuously (monitor mode)
  python bcat_smart_automation.py --monitor

  # Custom check interval
  python bcat_smart_automation.py --monitor --interval 30
        """
    )

    parser.add_argument(
        '--monitor',
        action='store_true',
        help='Run continuously (monitor mode)'
    )

    parser.add_argument(
        '--interval',
        type=int,
        default=60,
        help='Check interval in seconds (default: 60)'
    )

    args = parser.parse_args()

    automation = BCATSmartAutomation()

    if args.monitor:
        automation.run_continuous(args.interval)
    else:
        automation.run_once()


if __name__ == '__main__':
    main()
