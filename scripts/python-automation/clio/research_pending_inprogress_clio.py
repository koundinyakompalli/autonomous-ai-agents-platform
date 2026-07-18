#!/usr/bin/env python3
"""
Research Pending and In Progress Clio tickets and post results as comments.
"""

import os
import sys
import json
import requests
from datetime import datetime
from jira import JIRA
from jira.exceptions import JIRAError
from dotenv import load_dotenv
from jira_similarity_search import JiraSimilaritySearcher

# Load environment variables
load_dotenv()


def create_simple_adf_comment(text_lines):
    """Create simple ADF comment from text lines (no emojis)."""
    content = []

    for line in text_lines:
        if not line.strip():
            continue

        # Remove emojis and special characters
        line = line.replace('✅', '[RESOLVED]')
        line = line.replace('⏳', '[OPEN]')
        line = line.replace('🏛️', '')
        line = line.replace('☁️', '')
        line = line.replace('🔍', '')

        if line.startswith('## '):
            content.append({
                "type": "heading",
                "attrs": {"level": 2},
                "content": [{"type": "text", "text": line[3:]}]
            })
        elif line.startswith('### '):
            content.append({
                "type": "heading",
                "attrs": {"level": 3},
                "content": [{"type": "text", "text": line[4:]}]
            })
        elif line.startswith('**') and '**' in line[2:]:
            # Bold text (simplified)
            text = line.replace('**', '')
            content.append({
                "type": "paragraph",
                "content": [{"type": "text", "text": text, "marks": [{"type": "strong"}]}]
            })
        elif line.startswith('---'):
            content.append({"type": "rule"})
        elif line.startswith('*') and line.endswith('*') and not line.startswith('**'):
            # Italic
            text = line.strip('*')
            content.append({
                "type": "paragraph",
                "content": [{"type": "text", "text": text, "marks": [{"type": "em"}]}]
            })
        else:
            # Check for markdown links [text](url)
            if '[' in line and '](' in line and ')' in line:
                parts = []
                i = 0
                current = ""
                while i < len(line):
                    if line[i] == '[':
                        if current:
                            parts.append({"type": "text", "text": current})
                            current = ""
                        end = line.find(']', i)
                        if end != -1 and line[end+1:end+2] == '(':
                            url_end = line.find(')', end+2)
                            if url_end != -1:
                                text = line[i+1:end]
                                url = line[end+2:url_end]
                                parts.append({
                                    "type": "text",
                                    "text": text,
                                    "marks": [{"type": "link", "attrs": {"href": url}}]
                                })
                                i = url_end + 1
                                continue
                    current += line[i]
                    i += 1

                if current:
                    parts.append({"type": "text", "text": current})

                if parts:
                    content.append({"type": "paragraph", "content": parts})
            else:
                content.append({
                    "type": "paragraph",
                    "content": [{"type": "text", "text": line}]
                })

    return {
        "body": {
            "type": "doc",
            "version": 1,
            "content": content
        }
    }


def has_existing_clio_comment(jira_url, jira_username, jira_api_token, issue_key):
    """Check if ticket already has a CLIO comment."""
    try:
        url = f'{jira_url}/rest/api/3/issue/{issue_key}/comment'
        response = requests.get(
            url,
            auth=(jira_username, jira_api_token)
        )

        if response.status_code == 200:
            comments_data = response.json()
            comments = comments_data.get('comments', [])

            # Check if any comment contains CLIO markers
            for comment in comments:
                # Check comment body for CLIO markers
                body = comment.get('body', {})
                content = body.get('content', [])

                # Convert content to text and check for CLIO markers
                for item in content:
                    if item.get('type') == 'heading':
                        heading_content = item.get('content', [])
                        for text_item in heading_content:
                            text = text_item.get('text', '')
                            if 'Historical Research from OLD JIRA' in text:
                                return True

                    if item.get('type') == 'paragraph':
                        para_content = item.get('content', [])
                        for text_item in para_content:
                            text = text_item.get('text', '')
                            if 'Automated search performed at' in text:
                                return True

        return False

    except Exception as e:
        print(f'      [WARNING] Could not check for existing comments: {e}')
        return False


def post_comment(jira_url, jira_username, jira_api_token, issue_key, comment_adf):
    """Post comment to Jira."""
    try:
        url = f'{jira_url}/rest/api/3/issue/{issue_key}/comment'
        headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }

        response = requests.post(
            url,
            headers=headers,
            auth=(jira_username, jira_api_token),
            data=json.dumps(comment_adf)
        )

        if response.status_code == 201:
            result = response.json()
            print(f'      [OK] Comment added (ID: {result.get("id")})')
            return True
        else:
            print(f'      [ERROR] Failed: {response.status_code}')
            print(f'      {response.text}')
            return False

    except Exception as e:
        print(f'      [ERROR] Error: {e}')
        return False


def extract_config_info(ticket_data):
    """Extract configuration and system variable information."""
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

    config_info = []

    # Check description
    desc = ticket_data.get('description', '')
    if desc:
        desc_lower = desc.lower()
        if any(keyword in desc_lower for keyword in config_keywords):
            if len(desc) > 100:  # Only if substantial
                config_info.append({
                    'source': 'Description',
                    'content': desc[:1500]
                })

    # Check comments
    for comment in ticket_data.get('comments', []):
        comment_body = comment['body']
        comment_lower = comment_body.lower()
        if any(keyword in comment_lower for keyword in config_keywords):
            if len(comment_body) > 100:  # Only if substantial
                config_info.append({
                    'source': f"Comment by {comment['author']}",
                    'content': comment_body[:1500]
                })

    return config_info


def get_ticket_details(old_jira, ticket_key):
    """Get full ticket details including comments from old jira."""
    try:
        issue = old_jira.issue(ticket_key, fields='key,summary,description,comment')

        desc = ""
        if hasattr(issue.fields, 'description') and issue.fields.description:
            desc = str(issue.fields.description)

        comments = []
        if hasattr(issue.fields, 'comment') and issue.fields.comment:
            for comment in issue.fields.comment.comments:
                comment_body = str(comment.body) if comment.body else ""
                author = comment.author.displayName if hasattr(comment.author, 'displayName') else 'Unknown'
                comments.append({
                    'author': author,
                    'body': comment_body
                })

        return {
            'key': ticket_key,
            'summary': issue.fields.summary,
            'description': desc,
            'comments': comments
        }
    except Exception as e:
        return None


def extract_search_terms(summary):
    """Extract key search terms from ticket summary, including client name and module."""
    # Extract client name (usually first word before | or -)
    client_name = None
    client_prefixes = ['Aultcare', 'BCBSMA', 'FMHP', 'JHP', 'IEHP', 'WD', 'BCBSRI', 'FHP', 'Molina', 'UPMC', 'BSC', 'CenCal']

    for prefix in client_prefixes:
        if prefix in summary:
            client_name = prefix
            break

    # Split summary and extract key terms
    terms = []

    # If we found a client name, prioritize it
    if client_name:
        terms.append(client_name)

    # Check for important combined phrases first (before splitting)
    summary_lower = summary.lower()
    important_phrases = [
        'discharge date', 'admit date', 'authorization number',
        'member auth details', 'auth details', 'date field',
        'effective date', 'termination date', 'end date', 'start date'
    ]
    for phrase in important_phrases:
        if phrase in summary_lower:
            # Add the capitalized version
            terms.append(' '.join(word.capitalize() for word in phrase.split()))

    # Check for specific modules/contexts (these are important even if short)
    module_terms = {
        'provider_portal': ['provider portal'],
        'epa': ['epa', 'e-pa', 'electronic prior authorization'],
        'pa': [' pa ', 'pa override', 'prior auth'],
        'decision_tree': ['decision tree', 'dt', 'dts'],
        'rx': ['rx', 'pharmacy', 'drug'],
        'authorization': ['authorization', 'auth '],
        'intake': ['intake', 'fax intake'],
        'appeal': ['appeal', 'appeals'],
        'grievance': ['grievance', 'grv'],
        'exrm': ['exrm', 'ex rm', 'external review'],
        'letter': ['letter', 'correspondence', 'mail merge', 'notification'],
        'workflow': ['workflow', 'global workflow'],
        'rfi': ['rfi', 'request for information'],
        'preview': ['preview', 'letter preview'],
        'case_management': ['case management', 'case creation', 'case auto'],
        'override': ['override', 'overrides'],
        'default_values': ['default value', 'default values', 'defaults']
    }

    summary_lower = summary.lower()

    # Add module-specific terms
    for module_key, module_variations in module_terms.items():
        for variation in module_variations:
            if variation in summary_lower:
                # Add the most specific term found
                if module_key == 'provider_portal':
                    terms.insert(0, 'Provider Portal')  # Put Provider Portal first (highest priority)
                elif module_key == 'epa':
                    terms.append('ePA')
                elif module_key == 'pa':
                    terms.append('PA')
                elif module_key == 'decision_tree':
                    terms.append('Decision Tree')
                elif module_key == 'rx':
                    if 'rx' in summary_lower:
                        terms.append('Rx')
                elif module_key == 'authorization':
                    terms.append('Authorization')
                elif module_key == 'letter':
                    terms.append('Letter')
                elif module_key == 'workflow':
                    terms.append('Workflow')
                elif module_key == 'rfi':
                    terms.append('RFI')
                elif module_key == 'preview':
                    terms.append('Preview')
                elif module_key == 'case_management':
                    terms.append('Case')
                elif module_key == 'override':
                    terms.append('Override')
                elif module_key == 'default_values':
                    terms.append('Default')
                break

    # Remove common prefixes for extracting other terms
    clean_summary = summary
    for prefix in client_prefixes + ['CONFIG', 'UAT', 'PROD', 'BC']:
        clean_summary = clean_summary.replace(prefix + ' | ', '').replace(prefix + ' - ', '').replace(prefix, '')

    # Extract meaningful terms (more than 3 chars, not common words)
    skip_words = ['the', 'and', 'for', 'with', 'from', 'issue', 'issues', 'aren', 'aren�t', 'aren\'t', 'observation']
    words = clean_summary.split()

    for word in words:
        clean_word = word.strip('|').strip('-').strip().strip(':').strip('.').strip(',')
        if len(clean_word) > 3 and clean_word.lower() not in skip_words:
            # Avoid duplicates
            if clean_word not in terms and clean_word.lower() not in [t.lower() for t in terms]:
                terms.append(clean_word)

    return {'client': client_name, 'terms': terms[:10]}


def search_old_jira_direct(old_jira, search_info):
    """Search old Jira directly by terms for CLIENT, CONFIG, and TMPLT tickets with configuration."""
    client_name = search_info.get('client')
    search_terms = search_info.get('terms', [])

    print(f"      Searching Old Jira (CLIENT/CONFIG/TMPLT) with terms: {', '.join(search_terms[:3])}...")
    if client_name:
        print(f"      Client filter: {client_name}")

    config_results = []
    seen_keys = set()

    # First, search for client-specific tickets if we have a client name
    if client_name:
        try:
            jql_query = f'text ~ "{client_name}"'
            issues = old_jira.search_issues(
                jql_query,
                maxResults=30,
                fields='key,summary'
            )

            for issue in issues:
                # Filter to only CLIENT, CONFIG, and TMPLT tickets
                if not (issue.key.startswith('CLIENT-') or
                       issue.key.startswith('CONFIG-') or
                       issue.key.startswith('TMPLT-')):
                    continue

                # Check if client name is in the summary
                if client_name.lower() not in issue.fields.summary.lower():
                    continue

                if issue.key not in seen_keys:
                    seen_keys.add(issue.key)
                    # Get full details to check for config
                    ticket_details = get_ticket_details(old_jira, issue.key)
                    if ticket_details:
                        config_info = extract_config_info(ticket_details)
                        if config_info:
                            config_results.append({
                                'key': issue.key,
                                'summary': issue.fields.summary,
                                'url': f'https://jira.medhokapps.com/browse/{issue.key}',
                                'config': config_info,
                                'relevance': 'high'  # Client-specific
                            })
        except Exception as e:
            pass

    # Priority search for Provider Portal combined with other key terms
    if 'Provider Portal' in search_terms:
        # Get other meaningful terms (skip generic ones)
        other_terms = [t for t in search_terms if t not in ['Provider Portal', 'Provider', client_name] and len(t) > 4]

        # Search Provider Portal + specific issue terms
        for term in other_terms[:3]:  # Try top 3 specific terms
            try:
                combined_term = f'Provider Portal {term}'
                jql_query = f'text ~ "{combined_term}"'
                issues = old_jira.search_issues(
                    jql_query,
                    maxResults=20,
                    fields='key,summary'
                )

                for issue in issues:
                    if not (issue.key.startswith('CLIENT-') or
                           issue.key.startswith('CONFIG-') or
                           issue.key.startswith('TMPLT-')):
                        continue

                    if issue.key not in seen_keys:
                        seen_keys.add(issue.key)
                        ticket_details = get_ticket_details(old_jira, issue.key)
                        if ticket_details:
                            config_info = extract_config_info(ticket_details)
                            if config_info:
                                config_results.append({
                                    'key': issue.key,
                                    'summary': issue.fields.summary,
                                    'url': f'https://jira.medhokapps.com/browse/{issue.key}',
                                    'config': config_info,
                                    'relevance': 'high'  # Combined term match
                                })
                                if len(config_results) >= 10:
                                    return config_results
            except Exception as e:
                continue

    # Then search for other relevant terms
    # For specific context-heavy searches, search combined with module
    context_terms = [t for t in search_terms if t in ['Letter', 'Preview', 'Workflow', 'RFI', 'Override', 'Default']]
    module_term = next((t for t in search_terms if t in ['Rx', 'ePA', 'Authorization', 'PA']), None)

    # Search combined terms first if we have both context and module
    if context_terms and module_term:
        for context in context_terms:
            combined_term = f'{module_term} {context}'
            try:
                jql_query = f'text ~ "{combined_term}"'
                issues = old_jira.search_issues(
                    jql_query,
                    maxResults=20,
                    fields='key,summary'
                )

                for issue in issues:
                    if not (issue.key.startswith('CLIENT-') or
                           issue.key.startswith('CONFIG-') or
                           issue.key.startswith('TMPLT-')):
                        continue

                    if issue.key not in seen_keys:
                        seen_keys.add(issue.key)
                        ticket_details = get_ticket_details(old_jira, issue.key)
                        if ticket_details:
                            config_info = extract_config_info(ticket_details)
                            if config_info:
                                config_results.append({
                                    'key': issue.key,
                                    'summary': issue.fields.summary,
                                    'url': f'https://jira.medhokapps.com/browse/{issue.key}',
                                    'config': config_info,
                                    'relevance': 'high'  # Combined term match
                                })
                                if len(config_results) >= 10:
                                    return config_results
            except Exception as e:
                continue

    # Then search individual terms (skip generic ones if we have enough results)
    for term in search_terms:
        if term == client_name:  # Skip client name, already searched
            continue

        # Skip generic module terms like "Rx" if we already have results from combined searches
        if term in ['Rx', 'Case'] and len(config_results) >= 5:
            continue

        try:
            # Search for the term in all tickets
            jql_query = f'text ~ "{term}"'
            issues = old_jira.search_issues(
                jql_query,
                maxResults=30,  # Get more results since we'll filter
                fields='key,summary'
            )

            for issue in issues:
                # Filter to only CLIENT, CONFIG, and TMPLT tickets
                if not (issue.key.startswith('CLIENT-') or
                       issue.key.startswith('CONFIG-') or
                       issue.key.startswith('TMPLT-')):
                    continue

                if issue.key not in seen_keys:
                    seen_keys.add(issue.key)
                    # Get full details to check for config
                    ticket_details = get_ticket_details(old_jira, issue.key)
                    if ticket_details:
                        config_info = extract_config_info(ticket_details)
                        if config_info:
                            # Calculate relevance based on how many search terms match
                            summary_lower = issue.fields.summary.lower()
                            desc_lower = ticket_details.get('description', '').lower()
                            combined_text = summary_lower + ' ' + desc_lower

                            term_match_count = sum(1 for t in search_terms if t.lower() in combined_text)
                            relevance = 'high' if term_match_count >= 3 else 'medium' if term_match_count >= 2 else 'low'

                            config_results.append({
                                'key': issue.key,
                                'summary': issue.fields.summary,
                                'url': f'https://jira.medhokapps.com/browse/{issue.key}',
                                'config': config_info,
                                'relevance': relevance
                            })
                            if len(config_results) >= 10:  # Limit to top 10
                                return config_results
        except Exception as e:
            continue

    # Sort by relevance (high first)
    config_results.sort(key=lambda x: 0 if x.get('relevance') == 'high' else 1)

    return config_results[:10]  # Return top 10


def process_ticket(searcher, jira_url, jira_username, jira_api_token, issue, old_jira):
    """Process a single ticket - search and post results."""
    issue_key = issue.key
    summary = issue.fields.summary

    print(f"\n   Processing: [{issue_key}]")
    print(f"   Summary: {summary}")

    # Extract search terms from summary
    search_term = summary

    # Search for similar issues
    print(f"   Searching for similar issues...")
    results = searcher.find_similar_issues(
        issue_summary=search_term,
        issue_description="",
        max_results=10
    )

    # Get results
    analysis = results.get('analysis', {})
    similar_issues = results.get('similar_issues', [])

    total = analysis.get('total_found', 0)
    resolved = analysis.get('resolved_count', 0)

    print(f"   Found: {total} similar issues ({resolved} resolved)")

    # Extract configuration from old jira issues (from similarity search)
    # Only process CLIENT, CONFIG, and TMPLT tickets
    print(f"   Extracting configuration from similar issues (CLIENT/CONFIG/TMPLT only)...")
    config_found = []
    config_keys = set()

    for similar in similar_issues:
        if similar['instance'] == 'old_jira':
            # Only process CLIENT, CONFIG, and TMPLT tickets
            ticket_key = similar['key']
            if not (ticket_key.startswith('CLIENT-') or ticket_key.startswith('CONFIG-') or ticket_key.startswith('TMPLT-')):
                continue

            ticket_details = get_ticket_details(old_jira, similar['key'])
            if ticket_details:
                config_info = extract_config_info(ticket_details)
                if config_info:
                    config_keys.add(similar['key'])
                    config_found.append({
                        'key': similar['key'],
                        'summary': similar['summary'],
                        'url': similar['url'],
                        'config': config_info
                    })

    # Additional search: Direct OLD JIRA search with key terms
    print(f"   Searching Old Jira directly for configuration...")
    search_info = extract_search_terms(summary)
    direct_config = search_old_jira_direct(old_jira, search_info)

    # Merge results (avoid duplicates)
    for item in direct_config:
        if item['key'] not in config_keys:
            config_found.append(item)
            config_keys.add(item['key'])

    if config_found:
        print(f"   Found configuration in {len(config_found)} ticket(s)")
    else:
        print(f"   No configuration information found")

    # Create comment text
    lines = []
    lines.append("## Historical Research from OLD JIRA")
    lines.append("")

    # Filter to only show CLIENT, CONFIG, and TMPLT tickets from OLD JIRA
    old_jira_similar = [
        issue for issue in similar_issues
        if issue['instance'] == 'old_jira' and
        (issue['key'].startswith('CLIENT-') or issue['key'].startswith('CONFIG-') or issue['key'].startswith('TMPLT-'))
    ]
    old_jira_resolved = sum(1 for issue in old_jira_similar if issue['resolution'] != 'Unresolved')

    if old_jira_similar:
        lines.append(f"**Total CLIENT/CONFIG/TMPLT Issues Found:** {len(old_jira_similar)}")
        lines.append(f"**Resolved:** {old_jira_resolved}")
        lines.append(f"**Unresolved:** {len(old_jira_similar) - old_jira_resolved}")
        lines.append("")
        lines.append("### Similar Historical Issues (CLIENT/CONFIG/TMPLT tickets):")
        lines.append("")
        for i, issue_item in enumerate(old_jira_similar[:10], 1):
            resolution_marker = "[RESOLVED]" if issue_item['resolution'] != 'Unresolved' else "[OPEN]"

            lines.append(f"{i}. {resolution_marker} **[{issue_item['key']}]({issue_item['url']})** - {issue_item['summary']}")
            lines.append(f"   - **Status:** {issue_item['status']} | **Resolution:** {issue_item['resolution']}")
            lines.append(f"   - **Updated:** {issue_item['updated'][:10]}")
            lines.append("")
    else:
        lines.append("*No related CLIENT/CONFIG/TMPLT tickets found in similarity search. Configuration search below may still find relevant tickets.*")
        lines.append("")

    # Add Configuration Instructions section
    if config_found:
        lines.append("---")
        lines.append("")
        lines.append("## Configuration Instructions Found")
        lines.append("")
        lines.append("The following tickets contain configuration information. Review these tickets for setup details:")
        lines.append("")

        for item in config_found:
            lines.append(f"**[{item['key']}]({item['url']}) - {item['summary']}**")
            # Just list where config was found, not the full content
            config_sources = [c['source'] for c in item['config']]
            lines.append(f"   - Configuration found in: {', '.join(set(config_sources))}")
            lines.append("")

    lines.append("---")
    lines.append(f"*Automated search performed at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*")

    # Check if ticket already has a CLIO comment
    print(f"   Checking for existing CLIO comments...")
    if has_existing_clio_comment(jira_url, jira_username, jira_api_token, issue_key):
        print(f"   [SKIP] Ticket already has a CLIO comment - skipping duplicate")
        return True

    # Create ADF comment
    comment_adf = create_simple_adf_comment(lines)

    # Post to Jira
    print(f"   Posting comment...")
    success = post_comment(jira_url, jira_username, jira_api_token, issue_key, comment_adf)

    return success


def main():
    """Main execution function."""
    print("=" * 80)
    print("RESEARCH ACTIVE CLIO TICKETS (EXCLUDING RESOLVED/DONE/CANCELED)")
    print("=" * 80)
    print()

    # Get credentials from environment
    jira_url = os.getenv('JIRA_URL', 'https://mhkjira.atlassian.net')
    jira_username = os.getenv('JIRA_USERNAME')
    jira_api_token = os.getenv('JIRA_PASSWORD')

    if not jira_username or not jira_api_token:
        print("[ERROR] JIRA_USERNAME or JIRA_PASSWORD not set in .env file")
        sys.exit(1)

    print(f"Connecting to: {jira_url}")
    print(f"Username: {jira_username}")
    print()

    try:
        # Connect to Jira
        jira = JIRA(
            options={
                'server': jira_url,
                'rest_api_version': '3'
            },
            basic_auth=(jira_username, jira_api_token)
        )

        # JQL query for all Clio tickets EXCEPT Resolved, Done, or Canceled
        jql_query = 'labels = "Clio" AND status NOT IN (Resolved, Done, Canceled)'

        print(f"JQL Query: {jql_query}")
        print()
        print("Searching for Clio tickets (excluding Resolved, Done, Canceled)...")
        print("-" * 80)

        # Search issues
        issues = jira.search_issues(
            jql_query,
            maxResults=50,
            fields='key,summary,status,priority,assignee,created,updated,labels,description'
        )

        if not issues:
            print()
            print("No active Clio tickets found (all are Resolved, Done, or Canceled).")
            print()
            print("=" * 80)
            return

        print()
        print(f"Found {len(issues)} ticket(s) to process")
        print()

        # Initialize similarity searcher
        searcher = JiraSimilaritySearcher()

        # Connect to old Jira for configuration extraction
        print("Connecting to old Jira for configuration extraction...")
        old_jira = JIRA(
            options={'server': 'https://jira.medhokapps.com'},
            basic_auth=('rmcdonald', 'medhok123')
        )
        print("Connected to old Jira")
        print()

        # Process each ticket
        success_count = 0
        fail_count = 0

        for i, issue in enumerate(issues, 1):
            print(f"\n{i}. [{issue.key}] {issue.fields.summary}")
            print(f"   Status: {issue.fields.status.name}")
            print("   " + "-" * 75)

            try:
                success = process_ticket(searcher, jira_url, jira_username, jira_api_token, issue, old_jira)
                if success:
                    success_count += 1
                    print(f"   [OK] Successfully processed {issue.key}")
                    print(f"   View: https://mhkjira.atlassian.net/browse/{issue.key}")
                else:
                    fail_count += 1
                    print(f"   [ERROR] Failed to process {issue.key}")
            except Exception as e:
                fail_count += 1
                print(f"   [ERROR] Exception processing {issue.key}: {e}")

        # Summary
        print()
        print("=" * 80)
        print("SUMMARY")
        print("=" * 80)
        print(f"Total tickets found: {len(issues)}")
        print(f"Successfully processed: {success_count}")
        print(f"Failed: {fail_count}")
        print()
        print("=" * 80)

    except JIRAError as e:
        print(f"[ERROR] Jira Error: {e.status_code}")
        print(f"   {e.text}")
        sys.exit(1)
    except Exception as e:
        print(f"[ERROR] Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
