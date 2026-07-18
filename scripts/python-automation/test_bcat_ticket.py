"""
Test script to analyze BCAT ticket and predict how many tickets will be created
"""
import requests
from requests.auth import HTTPBasicAuth
import pandas as pd
from io import BytesIO
import os
import sys
import io

# Fix Windows console encoding for emojis
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

JIRA_EMAIL = os.getenv("JIRA_EMAIL", "smulheron@mhk.com")
JIRA_API_TOKEN = os.getenv("JIRA_API_TOKEN")
if not JIRA_API_TOKEN:
    raise RuntimeError("Set JIRA_API_TOKEN before running this script.")
JIRA_BASE_URL = os.getenv("JIRA_BASE_URL", "https://mhkjira.atlassian.net")
APPROVERS_FIELD_ID = 'customfield_10003'  # FIXED: Updated to match bcat_automation.py

def fetch_ticket(ticket_key):
    """Fetch ticket details from JIRA"""
    url = f"{JIRA_BASE_URL}/rest/api/3/issue/{ticket_key}"
    params = {
        'fields': f'summary,description,attachment,labels,{APPROVERS_FIELD_ID},issuetype,parent,customfield_10010'
    }

    response = requests.get(
        url,
        auth=HTTPBasicAuth(JIRA_EMAIL, JIRA_API_TOKEN),
        params=params
    )

    if response.status_code != 200:
        print(f"❌ Error fetching ticket: {response.status_code}")
        print(response.text)
        return None

    return response.json()

def analyze_excel(attachment_url, force_upgrades=False):
    """Download and analyze Excel file to determine scenario and count tickets"""
    response = requests.get(
        attachment_url,
        auth=HTTPBasicAuth(JIRA_EMAIL, JIRA_API_TOKEN)
    )

    if response.status_code != 200:
        print(f"❌ Error downloading Excel: {response.status_code}")
        return None

    # Read Excel file
    excel_file = BytesIO(response.content)
    xls = pd.ExcelFile(excel_file)

    # Get all sheet names (lowercase for comparison)
    sheet_names = [s.lower() for s in xls.sheet_names]
    print(f"\n📋 Excel sheets found: {xls.sheet_names}")

    # Show preview of each sheet
    print(f"\n📊 Sheet Previews:")
    for sheet_name in xls.sheet_names:
        df = pd.read_excel(excel_file, sheet_name=sheet_name)
        print(f"\n  Sheet: '{sheet_name}'")
        print(f"    Rows: {len(df)}")
        print(f"    Columns: {list(df.columns)[:5]}{'...' if len(df.columns) > 5 else ''}")
        if len(df) > 0:
            print(f"    First row sample: {df.iloc[0].to_dict() if len(df) > 0 else 'N/A'}")

    # Detect scenario
    scenario = None
    ticket_count = 0
    details = []

    # Check if BC Upgrade request type forces Upgrades scenario
    if force_upgrades:
        scenario = "UPGRADES (FORCED BY REQUEST TYPE)"
        # In Upgrades scenario: one ticket per sheet + one CONFIG ENV tracking ticket
        # Each sheet is processed and rows with "Technical Enabled" = "Technical Enabled" are included

        sheets_with_data = []
        for sheet_name in xls.sheet_names:
            df = pd.read_excel(excel_file, sheet_name=sheet_name)

            # Check if sheet has "Technical\nEnabled" or "Technical Enabled" column
            tech_enabled_col = None
            for col in df.columns:
                if 'technical' in str(col).lower() and 'enabled' in str(col).lower():
                    tech_enabled_col = col
                    break

            if tech_enabled_col:
                # Count rows where Technical Enabled = "Technical Enabled"
                tech_enabled_rows = df[df[tech_enabled_col].astype(str).str.contains('Technical', case=False, na=False)]
                tech_enabled_count = len(tech_enabled_rows)

                details.append(f"  Sheet '{sheet_name}': {len(df)} total rows, {tech_enabled_count} 'Technical Enabled' rows")
                if tech_enabled_count > 0:
                    sheets_with_data.append(sheet_name)
            else:
                details.append(f"  Sheet '{sheet_name}': {len(df)} rows (no 'Technical Enabled' column)")
                if len(df) > 0:
                    sheets_with_data.append(sheet_name)

        ticket_count = len(sheets_with_data) + 1  # +1 for CONFIG ENV tracking ticket
        details.append(f"\n  📊 Breakdown:")
        details.append(f"  - {len(sheets_with_data)} sheet ticket(s)")
        details.append(f"  - 1 'Features needed - CONFIG ENV' tracking ticket")
        details.append(f"  - TOTAL: {ticket_count} tickets")

        return {
            'scenario': scenario,
            'ticket_count': ticket_count,
            'sheets': xls.sheet_names,
            'details': details
        }

    if 'letter' in sheet_names:
        scenario = "LETTERS"
        letter_idx = sheet_names.index('letter')
        df = pd.read_excel(excel_file, sheet_name=xls.sheet_names[letter_idx])
        ticket_count = len(df)
        details.append(f"  - {ticket_count} rows in 'letter' sheet")
        details.append(f"  - Each row creates 1 ticket")

    elif 'assessment workbook' in sheet_names:
        scenario = "ASSESSMENTS"
        # Count all sheets except 'assessment workbook'
        ticket_count = len([s for s in sheet_names if s != 'assessment workbook'])
        details.append(f"  - {len(xls.sheet_names)} total sheets")
        details.append(f"  - Excludes 'assessment workbook' indicator sheet")
        details.append(f"  - {ticket_count} assessment tickets will be created")

    elif 'upgrade' in sheet_names:
        scenario = "UPGRADES"
        upgrade_idx = sheet_names.index('upgrade')
        df = pd.read_excel(excel_file, sheet_name=xls.sheet_names[upgrade_idx])
        ticket_count = len(df) + 1  # +1 for CONFIG ENV tracking ticket
        details.append(f"  - {len(df)} rows in 'upgrade' sheet")
        details.append(f"  - Each row creates 1 ticket")
        details.append(f"  - +1 'Features needed - CONFIG ENV' tracking ticket")

    elif 'workbook index' in sheet_names:
        scenario = "SOLUTION WORKBOOKS"
        # Count all sheets except 'workbook index'
        ticket_count = len([s for s in sheet_names if s != 'workbook index'])
        details.append(f"  - {len(xls.sheet_names)} total sheets")
        details.append(f"  - Excludes 'workbook index' indicator sheet")
        details.append(f"  - {ticket_count} solution workbook tickets will be created")

    elif 'auto tasking' in sheet_names:
        scenario = "AUTO TASKING"
        auto_idx = sheet_names.index('auto tasking')
        df = pd.read_excel(excel_file, sheet_name=xls.sheet_names[auto_idx])
        ticket_count = len(df)
        details.append(f"  - {ticket_count} rows in 'auto tasking' sheet")
        details.append(f"  - Each row creates 1 ticket")
    else:
        scenario = "UNKNOWN"
        details.append("  - No recognized indicator sheet found")
        details.append("  - Expected: 'letter', 'assessment workbook', 'upgrade', 'workbook index', or 'auto tasking'")

    return {
        'scenario': scenario,
        'ticket_count': ticket_count,
        'sheets': xls.sheet_names,
        'details': details
    }

def main(ticket_key):
    print(f"🔍 Analyzing BCAT ticket: {ticket_key}\n")

    # Fetch ticket
    ticket = fetch_ticket(ticket_key)
    if not ticket:
        return

    fields = ticket.get('fields', {})
    summary = fields.get('summary', 'N/A')
    labels = fields.get('labels', [])
    approvers = fields.get(APPROVERS_FIELD_ID, None)
    attachments = fields.get('attachment', [])
    request_type = fields.get('customfield_10010', {})
    request_type_name = request_type.get('requestType', {}).get('name', 'N/A') if request_type else 'N/A'
    request_type_id = request_type.get('requestType', {}).get('id', 'N/A') if request_type else 'N/A'

    print(f"📝 Ticket: {ticket_key}")
    print(f"   Summary: {summary}")
    print(f"   Labels: {labels}")
    print(f"   Approvers: {approvers if approvers else '❌ NOT SET'}")
    print(f"   Attachments: {len(attachments)}")
    print(f"   Request Type: {request_type_name} (ID: {request_type_id})")

    # Check if BCAT label exists
    has_bcat_label = 'BCAT' in labels
    print(f"\n✅ BCAT Label: {'Present' if has_bcat_label else '❌ MISSING'}")
    print(f"✅ Approvers Field: {'Set' if approvers else '❌ NOT SET'}")

    if not has_bcat_label:
        print(f"\n⚠️  WARNING: BCAT label is missing!")
        print(f"   Automation will NOT run until 'BCAT' label is added")

    if not approvers:
        print(f"\n⚠️  WARNING: Approvers field is not set!")
        print(f"   Automation will NOT run until Approvers field is filled")

    # Find Excel attachment
    excel_attachment = None
    for att in attachments:
        filename = att.get('filename', '')
        if filename.endswith(('.xlsx', '.xls')):
            excel_attachment = att
            break

    if not excel_attachment:
        print(f"\n❌ No Excel attachment found!")
        return

    print(f"\n📎 Excel File: {excel_attachment['filename']}")

    # Check if BC Upgrade request type (ID: 237)
    force_upgrades = (request_type_id == '237' or request_type_name == 'BC Upgrade')

    if force_upgrades:
        print(f"\n🎯 BC Upgrade Request Type Detected!")
        print(f"   Forcing UPGRADES scenario regardless of Excel structure")

    # Analyze Excel
    analysis = analyze_excel(excel_attachment['content'], force_upgrades=force_upgrades)
    if not analysis:
        return

    print(f"\n🎯 Detected Scenario: {analysis['scenario']}")
    print(f"\n📊 Ticket Prediction:")
    for detail in analysis['details']:
        print(detail)

    print(f"\n{'='*60}")
    print(f"🎫 TOTAL TICKETS TO BE CREATED: {analysis['ticket_count']}")
    print(f"{'='*60}")

    if not has_bcat_label or not approvers:
        print(f"\n⚠️  AUTOMATION WILL RUN ONCE:")
        if not has_bcat_label:
            print(f"   1. 'BCAT' label is added")
        if not approvers:
            print(f"   2. 'Approvers' field is filled")
    else:
        print(f"\n✅ AUTOMATION READY TO RUN!")
        print(f"   All prerequisites met - tickets will be created automatically")

if __name__ == '__main__':
    ticket_key = sys.argv[1] if len(sys.argv) > 1 else 'CPSUP-43786'
    main(ticket_key)
