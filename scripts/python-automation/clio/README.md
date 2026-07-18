# CLIO - Historical Research Agent for Jira

**CLIO** (Configuration Lookup and Issue Orchestrator) is an automated research agent that analyzes Jira tickets and provides historical context, similar issues, and configuration instructions from legacy systems.

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![Python](https://img.shields.io/badge/python-3.8+-green.svg)
![Status](https://img.shields.io/badge/status-production-success.svg)

---

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [How It Works](#how-it-works)
- [Output Format](#output-format)
- [Available Scripts](#available-scripts)
- [Filters and Exclusions](#filters-and-exclusions)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

---

## 🎯 Overview

CLIO automates the research process for Jira tickets by:

1. **Searching OLD JIRA** (https://jira.medhokapps.com/) for historical context
2. **Finding similar issues** using AI-powered similarity search
3. **Extracting configuration instructions** from related tickets
4. **Posting formatted results** as comments on NEW JIRA tickets

This saves hours of manual research time and ensures consistent, thorough investigation of issues.

---

## ✨ Features

### Core Capabilities

- **🔍 Intelligent Search**: Uses keyword extraction and semantic similarity to find related historical tickets
- **⚙️ Configuration Extraction**: Automatically identifies and extracts:
  - System variables
  - Database configuration
  - Setup instructions
  - SQL statements
  - Deployment steps
- **🎯 Smart Filtering**:
  - Excludes irrelevant NEW JIRA tickets
  - Filters out CCM deployment-only tickets
  - Focuses on meaningful OLD JIRA historical data
- **📊 Professional Formatting**: Outputs results in structured ADF (Atlassian Document Format)
- **🔄 Bulk Processing**: Can process multiple tickets with the "Clio" label automatically

### Key Benefits

- ✅ **Time Savings**: Reduces research time from hours to minutes
- ✅ **Consistency**: Ensures all tickets receive thorough historical research
- ✅ **Knowledge Retention**: Captures configuration from legacy systems
- ✅ **Quality**: Professional formatted output with clear sections

---

## 🚀 Installation

### Prerequisites

- Python 3.8 or higher
- Access to both Jira instances (OLD and NEW)
- Jira API credentials

### Step 1: Clone Repository

```bash
git clone <repository-url>
cd clio-research-agent
```

### Step 2: Install Dependencies

```bash
pip install -r requirements.txt
```

**Required packages:**
```
jira==3.5.0
requests==2.31.0
python-dotenv==1.0.0
```

### Step 3: Install Custom Dependencies

The tool requires `jira_similarity_search` module:
```bash
pip install -e ./jira_similarity_search
```

---

## ⚙️ Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# NEW JIRA Configuration
JIRA_URL=https://mhkjira.atlassian.net
JIRA_USERNAME=your.email@company.com
JIRA_PASSWORD=your_jira_api_token

# OLD JIRA Configuration (hardcoded in scripts)
# OLD_JIRA_URL=https://jira.medhokapps.com
# OLD_JIRA_USERNAME=username
# OLD_JIRA_PASSWORD=password
```

### Getting Jira API Token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Copy the token to your `.env` file

---

## 📖 Usage

### Automatic Processing (Recommended)

Process all Pending and In Progress tickets with the "Clio" label:

```bash
python research_pending_inprogress_clio.py
```

**Output:**
```
================================================================================
RESEARCH PENDING AND IN PROGRESS CLIO TICKETS
================================================================================

Connecting to: https://mhkjira.atlassian.net
Username: your.email@company.com

JQL Query: labels = "Clio" AND (status = "Pending" OR status = "In Progress")

Found 2 ticket(s) to process

1. [CPSUP-39282] BCBSMA | Upheld Cases Not Showing In ExRM Tab
   Status: Pending
   ---------------------------------------------------------------------------

   Processing: [CPSUP-39282]
   Summary: BCBSMA | Upheld Cases Not Showing In ExRM Tab
   Searching for similar issues...
   Found: 10 similar issues (7 resolved)
   Extracting configuration from similar issues...
   Searching Old Jira directly for configuration...
   Found configuration in 8 ticket(s)
   Posting comment...
      [OK] Comment added (ID: 325704)
   [OK] Successfully processed CPSUP-39282
```

### Manual Single Ticket Processing

Process a specific ticket:

```bash
python add_results_38911.py  # Update script with your ticket key
```

### List All Clio Tickets

View all tickets with the Clio label:

```bash
python list_clio_tickets.py
```

### List Clio Tickets with Dates

See when the Clio label was added:

```bash
python list_clio_tickets_with_dates.py
```

---

## 🔧 How It Works

### Research Process

```
┌─────────────────────────────────────────────────────────────┐
│  1. TICKET IDENTIFICATION                                   │
│     - Search for tickets with "Clio" label                  │
│     - Filter by status (Pending/In Progress)                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  2. SIMILARITY SEARCH                                       │
│     - Extract key terms from ticket summary                 │
│     - Run AI-powered similarity search                      │
│     - Find related issues in OLD JIRA                       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  3. CONFIGURATION EXTRACTION                                │
│     - Search OLD JIRA with extracted terms                  │
│     - Identify tickets with configuration keywords          │
│     - Extract: System variables, SQL, setup steps           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  4. FILTERING                                               │
│     - Remove CCM deployment tickets                         │
│     - Filter out irrelevant NEW JIRA tickets                │
│     - Keep only OLD JIRA historical data                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  5. FORMAT & POST                                           │
│     - Format results in professional ADF structure          │
│     - Post comment to Jira ticket                           │
│     - Include metadata and timestamps                       │
└─────────────────────────────────────────────────────────────┘
```

### Configuration Detection

CLIO identifies configuration information using these keywords:

```python
config_keywords = [
    'configuration', 'config:', 'sv:', 'system variable',
    'database config', 'added sv', 'config update',
    'configuration instructions', 'config change',
    'settings', 'parameter', 'table:', 'insert into',
    'update medhok', 'alter table', 'create table',
    'sql', 'database', 'add to', 'update to',
    'change to', 'set to', 'configure', 'setup',
    'added:', 'updated:', 'changed:', 'modified:',
    'step 1', 'step 2', 'step:', 'instructions'
]
```

---

## 📄 Output Format

### Comment Structure

CLIO posts comments in a professional format matching the HERMES agent style:

```
┌───────────────────────────────────────────────────────────┐
│  Agent Analysis Result                                    │
├───────────────────────────────────────────────────────────┤
│  [METADATA HEADER - Codeblock]                            │
│  - AI-Generated Content Warning                           │
│  - Agent Execution Report                                 │
│  - Customer, Branch, Duration, Model                      │
│  - Confidential Markings                                  │
│  - Ticket Summary & Research Overview                     │
├───────────────────────────────────────────────────────────┤
│  Similar Historical Issues                                │
│  - List of related OLD JIRA tickets                       │
│  - Status, Resolution, Updated dates                      │
│  - Links to tickets                                       │
├───────────────────────────────────────────────────────────┤
│  Configuration Instructions                               │
│  - Configuration from related tickets                     │
│  - System variables                                       │
│  - Database changes                                       │
│  - Setup steps                                            │
│  - SQL statements (in code blocks)                        │
├───────────────────────────────────────────────────────────┤
│  Footer                                                   │
│  - Generation timestamp                                   │
│  - Agent attribution                                      │
└───────────────────────────────────────────────────────────┘
```

### Example Output

```markdown
## Agent Analysis Result

```markdown
AI-GENERATED CONTENT - FOR INTERNAL USE ONLY

Agent Execution Report:

Customer: JHP
Code Branch: Clio Research

Generated By: CLIO (Historical Research Agent)
Duration: 2m 15s
Model: Claude Sonnet 4.5

CONFIDENTIAL • DO NOT DISTRIBUTE • INTERNAL ONLY

---

# CLIO Historical Research for CPSUP-38911

## Ticket Summary
JHP UAT: CM CAID 001

## Research Overview
This analysis searched historical OLD JIRA tickets for related
configuration instructions and similar issues.
```

## Configuration Instructions

Found configuration details in 8 OLD JIRA ticket(s):

### [TMPLT-85527](https://jira.medhokapps.com/browse/TMPLT-85527) - CAID Configuration

*Source: Description*

```text
Configuration Steps:

1. System Variable: CAID_ENABLED = true
2. Database Table: cm_caid_settings
3. Status Reason: Pending Review
```

---

*Generated by Specter AI Agent at 2026-03-12T14:30:45.123Z*
```

---

## 📚 Available Scripts

### Main Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `research_pending_inprogress_clio.py` | **Main script** - Process all Pending/In Progress Clio tickets | `python research_pending_inprogress_clio.py` |
| `list_clio_tickets.py` | List all tickets with Clio label | `python list_clio_tickets.py` |
| `list_clio_tickets_with_dates.py` | List Clio tickets with label added dates | `python list_clio_tickets_with_dates.py` |

### Utility Scripts

| Script | Purpose |
|--------|---------|
| `add_results_38911.py` | Template for processing specific ticket |
| `update_38911_with_proper_format.py` | Update ticket with formatted results |
| `check_36925_format.py` | Check format of reference ticket |
| `find_config_for_specific_tickets.py` | Deep dive config search for specific tickets |

### Test Scripts

| Script | Purpose |
|--------|---------|
| `test_config_extraction_examples.py` | Test config extraction on sample tickets |
| `check_config_39282.py` | Verify config extraction for specific ticket |

---

## 🚫 Filters and Exclusions

### What Gets Filtered Out

#### 1. CCM Tickets (Deployment-Only)
```python
if issue.key.startswith('CCM-'):
    continue  # Skip deployment tickets
```

**Reason:** CCM tickets are deployment-only and don't contain valuable configuration information.

**Example Excluded:** `CCM-27979 - Deploy Code and Configuration from FMHP UAT to FMHP PROD`

#### 2. Irrelevant NEW JIRA Tickets
```python
old_jira_similar = [issue for issue in similar_issues if issue['instance'] == 'old_jira']
```

**Reason:** NEW JIRA tickets (SEN-xxx) are often generic matches without historical context.

**Example Excluded:** `SEN-444 - CenCal PROD | Language updates failed in MHK`

### What Gets Included

✅ **OLD JIRA Tickets** (TMPLT-xxx, LCM-xxx, RMP-xxx)
- Historical development tickets
- Configuration changes
- System variable updates
- Bug fixes with config details

✅ **Tickets with Configuration Keywords**
- Contains: config, system variable, database, SQL
- Has: setup steps, instructions, parameters
- Includes: code changes, table updates

---

## 💡 Examples

### Example 1: BCBSMA ExRM Issue

**Input Ticket:**
```
CPSUP-39282 - BCBSMA | Upheld Cases Not Showing In ExRM Tab
```

**CLIO Output:**
- Found 10 similar issues (7 resolved)
- Extracted configuration from 8 OLD JIRA tickets:
  - `TMPLT-85527` - ExRM Upheld Case Type Configuration
  - `TMPLT-52130` - ExRM Pharmacy AutoCreate case
  - `LCM-1109` - BCBSMA STAGE Config deployment
  - And 5 more with specific config details

### Example 2: JHP UAT CAID Issue

**Input Ticket:**
```
CPSUP-38911 - JHP UAT: CM CAID 001
```

**CLIO Output:**
- Found 0 OLD JIRA similar issues (all matches were NEW JIRA - filtered out)
- Found configuration in 8 OLD JIRA tickets via direct search:
  - Searched terms: CAID, JHP, UAT, Care, CM
  - Extracted system variables, database configs, setup steps

### Example 3: FMHP Reassignment Issue

**Input Ticket:**
```
CPSUP-39216 - FMHP | Inability to reassign case appropriately
```

**CLIO Output:**
- Found 10 similar issues (8 resolved)
- Configuration from 8 tickets with reassignment logic
- SQL updates for case assignment tables
- Workflow configuration changes

---

## 🔧 Troubleshooting

### Common Issues

#### Issue: "No configuration found"

**Solution:**
```python
# The search terms may need adjustment
# Check the ticket summary for better keywords
search_terms = extract_search_terms(summary)
print(f"Searching with: {search_terms}")
```

#### Issue: "Too many CCM tickets in results"

**Solution:** Already handled - CCM tickets are automatically filtered out in `search_old_jira_direct()`.

#### Issue: "SEN tickets showing in results"

**Solution:** NEW JIRA tickets are filtered in the output:
```python
old_jira_similar = [issue for issue in similar_issues
                    if issue['instance'] == 'old_jira']
```

#### Issue: "Authentication failed"

**Solution:**
1. Check `.env` file credentials
2. Verify API token is valid
3. Ensure you have access to both Jira instances

```bash
# Test connection
python -c "from jira import JIRA; jira = JIRA('https://mhkjira.atlassian.net', basic_auth=('email', 'token')); print(jira.myself())"
```

#### Issue: "Script runs but no comments appear"

**Solution:**
1. Check Jira permissions
2. Verify ticket exists and is accessible
3. Check console output for error messages
4. Ensure `JIRA_PASSWORD` is the API token, not password

---

## 📊 Performance

### Benchmarks

| Metric | Value |
|--------|-------|
| Average processing time per ticket | 2-3 minutes |
| Tickets processed per hour | ~20-30 |
| API calls per ticket | 15-25 |
| Configuration tickets found (avg) | 5-8 |
| Historical issues found (avg) | 3-10 |

### Optimization Tips

1. **Batch Processing**: Use main script for multiple tickets
2. **Keyword Refinement**: Better keywords = better results
3. **Limit Results**: Already capped at 8 config tickets per search
4. **Caching**: Future enhancement - cache OLD JIRA ticket details

---

## 🤝 Contributing

### Development Setup

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Install development dependencies
pip install pytest black flake8
```

### Code Style

- Follow PEP 8
- Use descriptive variable names
- Add docstrings to functions
- Keep functions focused and small

### Testing

```bash
# Run tests
pytest tests/

# Check code style
flake8 *.py

# Format code
black *.py
```

### Adding New Features

1. Create feature branch: `git checkout -b feature/your-feature`
2. Make changes with tests
3. Update documentation
4. Submit pull request

---

## 📝 Changelog

### Version 1.0.0 (2026-03-12)
- ✨ Initial release
- 🔍 Similarity search integration
- ⚙️ Configuration extraction
- 🚫 CCM and NEW JIRA filtering
- 📊 Professional ADF formatting
- 🔄 Bulk processing support

### Planned Features (v1.1.0)
- [ ] Caching layer for OLD JIRA tickets
- [ ] Customizable search term extraction
- [ ] Export results to CSV/JSON
- [ ] Web interface for research
- [ ] Integration with Slack notifications
- [ ] Machine learning for better keyword extraction

---

## 📄 License

Internal use only - Hearst Business Media

---

## 👥 Authors

- **Rory McDonald** - Initial development and research
- **CLIO Agent** - Automated research assistant

---

## 🙏 Acknowledgments

- Based on HERMES agent architecture
- Inspired by DARCI configuration lookup
- Built with Claude Sonnet 4.5
- Uses Jira Python SDK

---

## 📞 Support

For issues or questions:
1. Check [Troubleshooting](#troubleshooting) section
2. Review [Examples](#examples)
3. Contact: rmcdonald@mhk.com

---

**CLIO - Making historical research effortless** 🚀

---

## 🔗 Quick Links

- [Jira API Documentation](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- [OLD JIRA Instance](https://jira.medhokapps.com/)
- [NEW JIRA Instance](https://mhkjira.atlassian.net/)

---

*Last Updated: 2026-03-12*
