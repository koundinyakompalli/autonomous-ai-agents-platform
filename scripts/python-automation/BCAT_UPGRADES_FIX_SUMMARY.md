# BCAT Upgrades Scenario Fix

## Issue
CPSUP-40167 created **67 tickets** when it should have created **1-2 tickets** (one per Excel sheet tab).

## Root Cause
The Python `bcat_automation.py` Upgrades scenario was creating **one ticket per row** instead of **one ticket per sheet tab**.

## Fix Applied
Updated the Python implementation to match the TypeScript implementation:

### Changes Made to `bcat_automation.py`:

#### 1. Updated `detect_scenario()` (Lines 80-94)
**Before:** Loaded only the first upgrade sheet
```python
df = pd.read_excel(excel_file, sheet_name=upgrade_sheets[0])
return 'upgrades', {upgrade_sheets[0]: df}
```

**After:** Loads ALL upgrade sheets
```python
sheets_data = {}
for sheet in upgrade_sheets:
    df = pd.read_excel(excel_file, sheet_name=sheet)
    if not df.empty:
        sheets_data[sheet] = df
return 'upgrades', sheets_data
```

#### 2. Rewrote `prepare_upgrades_data()` (Lines 327-393)
**Before:** Created one ticket per row
```python
for idx, row in df.iterrows():
    tickets_info.append({...})  # One ticket per row
```

**After:** Creates one ticket per sheet tab with all Technical Enabled rows
```python
for sheet_name, df in sheets_data.items():
    # Find "Technical Enabled" column
    # Filter rows where Technical Enabled = "Technical Enabled"
    tech_enabled_rows = df[tech_enabled_value]

    # Skip sheets with no Technical Enabled rows
    if len(tech_enabled_rows) == 0:
        continue

    # Create ONE ticket with all Technical Enabled rows in description
    tickets_info.append({...})  # One ticket per sheet
```

#### 3. Fixed Excel attachment naming (Line 833)
**Before:** Used generic name `f"Upgrade_{idx}"`
```python
sheet_name = f"Upgrade_{idx}"
```

**After:** Uses actual sheet name
```python
sheet_name = ticket_info.get('sheet_name', f'Sheet_{idx}')
```

## New Behavior

### Upgrades Scenario Now:
1. **Processes ALL sheets** with "upgrade" in the name
2. **Creates ONE ticket per sheet tab** (not per row)
3. **Filters rows** to only include "Technical Enabled" rows
4. **Puts all Technical Enabled rows** in the ticket description
5. **Excludes fields**: Technical Enabled, Client Applicable, Notes
6. **Attaches the full sheet** as Excel file to the ticket

## Expected Results for CPSUP-40167

Instead of:
- ❌ 67 tickets (one per row)

Should create:
- ✅ 1-2 tickets (one per Excel sheet tab that has "upgrade" in the name)

## Testing Required

1. Test with a new BC Upgrade ticket
2. Verify only 1 ticket is created per Excel sheet tab
3. Verify only "Technical Enabled" rows appear in the description
4. Verify Excel attachment contains the full sheet

## Date Fixed
March 12, 2026

## Files Modified
- `c:\Users\smulheron\OneDrive - Hearst\Documents\Claude-Setup\JIRA_automation\bcat_automation.py`
  - Lines 80-94: Scenario detection
  - Lines 327-393: prepare_upgrades_data()
  - Line 833: Excel attachment naming
