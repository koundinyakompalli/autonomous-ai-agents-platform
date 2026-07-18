#!/usr/bin/env python3
"""
Combined research: Similar issues + Configuration info in one comment
"""

import os
import sys
import json
import requests
from dotenv import load_dotenv
from jira import JIRA

load_dotenv()


def search_old_jira_similar(search_terms):
    """Search old Jira with specific terms and return formatted results."""
    try:
        old_jira = JIRA(
            options={'server': 'https://jira.medhokapps.com'},
            basic_auth=('rmcdonald', 'medhok123')
        )

        all_results = []
        for term in search_terms:
            jql_query = f'text ~ "{term}"'
            issues = old_jira.search_issues(
                jql_query,
                maxResults=10,
                fields='key,summary,status,resolution,description'
            )

            for issue in issues:
                if issue.key not in [r['key'] for r in all_results]:
                    desc = ""
                    if hasattr(issue.fields, 'description') and issue.fields.description:
                        desc = str(issue.fields.description)[:200].replace('\n', ' ')
                        if len(str(issue.fields.description)) > 200:
                            desc += '...'

                    resolution = "Unresolved"
                    if hasattr(issue.fields, 'resolution') and issue.fields.resolution:
                        resolution = issue.fields.resolution.name

                    all_results.append({
                        'key': issue.key,
                        'summary': issue.fields.summary,
                        'status': issue.fields.status.name,
                        'resolution': resolution,
                        'description': desc
                    })

        return all_results[:10]
    except Exception as e:
        print(f"[ERROR] Similar issues search failed: {e}")
        return []


def get_config_info(ticket_keys):
    """Get configuration information from old Jira tickets."""
    try:
        old_jira = JIRA(
            options={'server': 'https://jira.medhokapps.com'},
            basic_auth=('rmcdonald', 'medhok123')
        )

        results = []
        for key in ticket_keys:
            try:
                issue = old_jira.issue(key, fields='key,summary,description,comment')

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

                results.append({
                    'key': key,
                    'summary': issue.fields.summary,
                    'description': desc,
                    'comments': comments
                })
            except Exception as e:
                print(f"[WARN] Could not fetch {key}: {e}")
                continue

        return results
    except Exception as e:
        print(f"[ERROR] Config search failed: {e}")
        return []


def extract_config_info(ticket_data):
    """Extract configuration and system variable information."""
    config_keywords = [
        'configuration', 'config:', 'sv:', 'system variable',
        'database config', 'added sv', 'config update',
        'configuration instructions', 'config change',
        'settings', 'parameter', 'table:', 'insert into',
        'update medhok', 'alter table', 'create table'
    ]

    config_info = []

    # Check description
    desc = ticket_data.get('description', '').lower()
    if any(keyword in desc for keyword in config_keywords):
        config_info.append({
            'source': 'Description',
            'content': ticket_data.get('description', '')[:500]
        })

    # Check comments
    for comment in ticket_data.get('comments', []):
        comment_lower = comment['body'].lower()
        if any(keyword in comment_lower for keyword in config_keywords):
            config_info.append({
                'source': f"Comment by {comment['author']}",
                'content': comment['body'][:500]
            })

    return config_info


def create_combined_adf_comment(search_terms, similar_issues, config_tickets):
    """Create combined ADF comment with both similar issues and config info."""
    content = []

    # Main header
    content.append({
        "type": "paragraph",
        "content": [{
            "type": "text",
            "text": "Research Results from Clio Label",
            "marks": [{"type": "strong"}]
        }]
    })

    # Introduction
    intro_text = f"Comprehensive research including similar historical issues and configuration information related to: {', '.join(search_terms)}"
    content.append({
        "type": "paragraph",
        "content": [{"type": "text", "text": intro_text}]
    })

    content.append({"type": "rule"})

    # ========== SECTION 1: SIMILAR ISSUES ==========
    content.append({
        "type": "heading",
        "attrs": {"level": 2},
        "content": [{"type": "text", "text": "Similar Historical Issues"}]
    })

    if not similar_issues:
        content.append({
            "type": "paragraph",
            "content": [{"type": "text", "text": "No similar issues found."}]
        })
    else:
        for result in similar_issues:
            # Ticket key with link
            content.append({
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": result['key'],
                        "marks": [{
                            "type": "link",
                            "attrs": {"href": f"https://jira.medhokapps.com/browse/{result['key']}"}
                        }]
                    },
                    {
                        "type": "text",
                        "text": f" - {result['summary']}"
                    }
                ]
            })

            # Details as bullet list
            bullet_items = []

            if result['description']:
                bullet_items.append({
                    "type": "listItem",
                    "content": [{
                        "type": "paragraph",
                        "content": [{
                            "type": "text",
                            "text": f"Issue: {result['description']}"
                        }]
                    }]
                })

            bullet_items.append({
                "type": "listItem",
                "content": [{
                    "type": "paragraph",
                    "content": [{
                        "type": "text",
                        "text": f"Status: {result['status']}"
                    }]
                }]
            })

            if result['resolution'] != 'Unresolved':
                bullet_items.append({
                    "type": "listItem",
                    "content": [{
                        "type": "paragraph",
                        "content": [{
                            "type": "text",
                            "text": f"Resolution: {result['resolution']}"
                        }]
                    }]
                })

            if bullet_items:
                content.append({
                    "type": "bulletList",
                    "content": bullet_items
                })

    content.append({"type": "rule"})

    # ========== SECTION 2: CONFIGURATION INFO ==========
    content.append({
        "type": "heading",
        "attrs": {"level": 2},
        "content": [{"type": "text", "text": "Configuration/System Variable Information"}]
    })

    if not config_tickets:
        content.append({
            "type": "paragraph",
            "content": [{
                "type": "text",
                "text": "No configuration or system variable information found."
            }]
        })
    else:
        for result in config_tickets:
            # Ticket header
            content.append({
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": f"{result['key']} - {result['summary']}",
                        "marks": [{"type": "strong"}]
                    }
                ]
            })

            content.append({
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": result['key'],
                        "marks": [{
                            "type": "link",
                            "attrs": {"href": f"https://jira.medhokapps.com/browse/{result['key']}"}
                        }]
                    }
                ]
            })

            # Add configuration entries
            for config in result['config_info']:
                content.append({
                    "type": "paragraph",
                    "content": [{
                        "type": "text",
                        "text": f"Source: {config['source']}",
                        "marks": [{"type": "em"}]
                    }]
                })

                config_text = config['content']
                if any(keyword in config_text.lower() for keyword in ['insert', 'update', 'alter', 'create', 'select']):
                    content.append({
                        "type": "codeBlock",
                        "content": [{
                            "type": "text",
                            "text": config_text[:1000]
                        }]
                    })
                else:
                    content.append({
                        "type": "paragraph",
                        "content": [{
                            "type": "text",
                            "text": config_text[:1000]
                        }]
                    })

    # Footer
    content.append({"type": "rule"})
    content.append({
        "type": "paragraph",
        "content": [{
            "type": "text",
            "text": "Comprehensive research performed by automated Clio similarity search agent",
            "marks": [{"type": "em"}]
        }]
    })

    return {
        "body": {
            "type": "doc",
            "version": 1,
            "content": content
        }
    }


def post_comment(issue_key, comment_adf):
    """Post comment to Jira."""
    jira_url = os.getenv('JIRA_URL', 'https://mhkjira.atlassian.net')
    jira_username = os.getenv('JIRA_USERNAME')
    jira_api_token = os.getenv('JIRA_PASSWORD')

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
            print(f'   [OK] Comment added (ID: {result.get("id")})')
            return True
        else:
            print(f'   [ERROR] Failed: {response.status_code}')
            print(f'   {response.text}')
            return False

    except Exception as e:
        print(f'   [ERROR] Error: {e}')
        return False


def main():
    """Main execution function."""
    print("=" * 80)
    print("COMBINED RESEARCH: SIMILAR ISSUES + CONFIGURATION INFO")
    print("=" * 80)

    # CPSUP-33473 configuration
    ticket_key = 'CPSUP-33473'
    summary = 'UUHIP - MTM HEDIS SLA Incorrect'
    search_terms = ['MTM HEDIS', 'UUHIP SLA', 'HEDIS SLA', 'MTM due date']
    config_ticket_keys = ['TMPLT-74790', 'RMP-425', 'CCM-44195']

    print(f"\nProcessing: [{ticket_key}]")
    print(f"Summary: {summary}")
    print()

    # Step 1: Get similar issues
    print("Step 1: Searching for similar historical issues...")
    similar_issues = search_old_jira_similar(search_terms)
    print(f"   Found {len(similar_issues)} similar issues")

    # Step 2: Get configuration info
    print("Step 2: Extracting configuration/system variable info...")
    ticket_details = get_config_info(config_ticket_keys)

    config_tickets = []
    for ticket_data in ticket_details:
        config_info = extract_config_info(ticket_data)
        if config_info:
            config_tickets.append({
                'key': ticket_data['key'],
                'summary': ticket_data['summary'],
                'config_info': config_info
            })
    print(f"   Found config info in {len(config_tickets)} tickets")

    # Step 3: Create combined comment
    print("\nStep 3: Creating combined comment...")
    comment_adf = create_combined_adf_comment(search_terms, similar_issues, config_tickets)

    # Step 4: Post to Jira
    print("Step 4: Posting to Jira...")
    success = post_comment(ticket_key, comment_adf)

    if success:
        print()
        print(f"[OK] Successfully posted combined research to {ticket_key}")
        print(f"     View: https://mhkjira.atlassian.net/browse/{ticket_key}")
    else:
        print()
        print(f"[ERROR] Failed to post to {ticket_key}")

    print()
    print("=" * 80)


if __name__ == '__main__':
    main()
