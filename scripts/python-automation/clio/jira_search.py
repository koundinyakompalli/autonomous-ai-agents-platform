#!/usr/bin/env python3
"""
Jira Issue Search Script
Search Jira issues by description and return matching issue IDs with summaries.
"""

import argparse
import getpass
import json
import sys
import os
from typing import List, Dict, Optional
from jira import JIRA
from jira.exceptions import JIRAError
from dotenv import load_dotenv
from jira_instances import get_instance, get_instance_url, get_instance_username, get_instance_label, list_instances, get_password_env_key

# Load environment variables from .env file if it exists
load_dotenv()

# Default Jira server URL
DEFAULT_JIRA_URL = "https://jira.medhokapps.com"


class JiraSearcher:
    """Handle Jira authentication and search operations."""

    def __init__(self, jira_url: str, username: str, password: str):
        """
        Initialize Jira connection.

        Args:
            jira_url: URL of the Jira instance
            username: Jira username
            password: Jira password
        """
        self.jira_url = jira_url
        self.username = username
        self.jira = None

        # Verify HTTPS
        if not jira_url.startswith('https://'):
            print("⚠️  Warning: Not using HTTPS. Your credentials may be transmitted insecurely.",
                  file=sys.stderr)

        try:
            # Detect if this is an Atlassian Cloud instance
            is_cloud = 'atlassian.net' in jira_url.lower()

            # Initialize JIRA connection with appropriate options
            jira_options = {'server': jira_url}
            if is_cloud:
                jira_options['rest_api_version'] = '3'

            self.jira = JIRA(options=jira_options, basic_auth=(username, password))
            # Test connection by getting server info
            _ = self.jira.server_info()
        except JIRAError as e:
            if e.status_code == 401:
                raise ValueError("Authentication failed. Please check your username and password.")
            elif e.status_code == 403:
                raise ValueError("Access forbidden. You may not have permission to access this Jira instance.")
            else:
                raise ValueError(f"Failed to connect to Jira: {e.text}")
        except Exception as e:
            raise ValueError(f"Failed to connect to Jira: {str(e)}")

    def search_issues(self, search_term: str, max_results: int = 50, include_details: bool = False, jira_label: str = None) -> List[Dict]:
        """
        Search Jira issues by text in summary and description.

        Args:
            search_term: Text to search for
            max_results: Maximum number of results to return
            include_details: Include comments and attachments in results
            jira_label: Optional Jira label to filter by (e.g., "Clio")

        Returns:
            List of dictionaries containing issue information
        """
        # Build JQL query to search in both summary and description
        # Using text search which searches across multiple fields including comments
        if jira_label:
            # Add label filter to JQL query
            jql_query = f'labels = "{jira_label}" AND text ~ "{search_term}"'
        else:
            jql_query = f'text ~ "{search_term}"'

        try:
            issues = self.jira.search_issues(
                jql_query,
                maxResults=max_results,
                fields='key,summary,status,priority,assignee,created,updated,comment,attachment,labels'
            )

            results = []
            for issue in issues:
                # Get assignee name safely
                assignee = "Unassigned"
                if hasattr(issue.fields, 'assignee') and issue.fields.assignee:
                    assignee = issue.fields.assignee.displayName

                # Get priority safely
                priority = "None"
                if hasattr(issue.fields, 'priority') and issue.fields.priority:
                    priority = issue.fields.priority.name

                # Get labels safely
                labels = []
                if hasattr(issue.fields, 'labels') and issue.fields.labels:
                    labels = issue.fields.labels

                result = {
                    'key': issue.key,
                    'summary': issue.fields.summary,
                    'status': issue.fields.status.name,
                    'priority': priority,
                    'assignee': assignee,
                    'created': str(issue.fields.created),
                    'updated': str(issue.fields.updated),
                    'url': f"{self.jira_url}/browse/{issue.key}",
                    'labels': labels
                }

                # Add comments and attachments if requested
                if include_details:
                    # Configuration keywords to prioritize
                    config_keywords = [
                        'configuration instructions',
                        'config:',
                        'the configuration for',
                        'config update made',
                        'configuration update',
                        'system variable',
                        'sv:',
                        'added sv',
                        'database config',
                        'config changes'
                    ]

                    # Get matching comments
                    matching_comments = []
                    config_comments = []
                    if hasattr(issue.fields, 'comment') and issue.fields.comment:
                        for comment in issue.fields.comment.comments:
                            # Convert comment body to string (handles PropertyHolder in Atlassian Cloud)
                            comment_body_str = str(comment.body) if comment.body else ""
                            comment_body = comment_body_str.lower()
                            if search_term.lower() in comment_body:
                                # Truncate long comments
                                body_preview = comment_body_str[:300] + "..." if len(comment_body_str) > 300 else comment_body_str

                                # Check if this is a configuration-related comment
                                is_config = any(keyword in comment_body for keyword in config_keywords)

                                comment_data = {
                                    'author': comment.author.displayName if hasattr(comment.author, 'displayName') else 'Unknown',
                                    'created': str(comment.created),
                                    'body': body_preview,
                                    'is_config': is_config
                                }

                                if is_config:
                                    config_comments.append(comment_data)
                                else:
                                    matching_comments.append(comment_data)

                    # Prioritize config comments first, then regular comments
                    all_comments = config_comments + matching_comments
                    result['matching_comments'] = all_comments
                    result['comment_count'] = len(all_comments)
                    result['config_comment_count'] = len(config_comments)

                    # Get attachments
                    attachments = []
                    if hasattr(issue.fields, 'attachment') and issue.fields.attachment:
                        for attachment in issue.fields.attachment:
                            attachments.append({
                                'filename': attachment.filename,
                                'size': attachment.size,
                                'created': str(attachment.created)
                            })

                    result['attachments'] = attachments
                    result['attachment_count'] = len(attachments)

                results.append(result)

            # Sort results: prioritize tickets with config comments, then by updated date
            if include_details:
                results.sort(key=lambda x: (
                    -x.get('config_comment_count', 0),  # Config comments first (descending)
                    x.get('updated', '')  # Then by updated date
                ), reverse=True)

            return results

        except JIRAError as e:
            if "does not exist" in str(e) or "syntax error" in str(e).lower():
                raise ValueError(f"Invalid search query. JQL error: {e.text}")
            else:
                raise ValueError(f"Search failed: {e.text}")
        except Exception as e:
            raise ValueError(f"Search failed: {str(e)}")


def format_text_output(results: List[Dict]) -> str:
    """Format search results as readable text."""
    if not results:
        return "No matching issues found."

    output = [f"\nFound {len(results)} matching issue(s):\n"]
    output.append("=" * 80)

    for issue in results:
        output.append(f"\n[{issue['key']}] {issue['summary']}")
        output.append(f"  Status: {issue['status']} | Priority: {issue['priority']} | Assignee: {issue['assignee']}")
        output.append(f"  URL: {issue['url']}")

        # Display labels if present
        if 'labels' in issue and issue['labels']:
            labels_str = ', '.join(issue['labels'])
            output.append(f"  Labels: {labels_str}")

        # Display matching comments if present
        if 'matching_comments' in issue and issue['matching_comments']:
            config_count = issue.get('config_comment_count', 0)
            if config_count > 0:
                output.append(f"  >> [CONFIG] Configuration Comments ({config_count}):")
            else:
                output.append(f"  >> Matching Comments ({issue['comment_count']}):")

            for i, comment in enumerate(issue['matching_comments'][:5], 1):  # Show max 5 comments
                config_marker = "[CONFIG] " if comment.get('is_config', False) else ""
                output.append(f"    {i}. {config_marker}By {comment['author']} on {comment['created'][:10]}")
                output.append(f"       {comment['body']}")
            if issue['comment_count'] > 5:
                output.append(f"    ... and {issue['comment_count'] - 5} more comment(s)")

        # Display attachments if present
        if 'attachments' in issue and issue['attachments']:
            output.append(f"  >> Attachments ({issue['attachment_count']}):")
            for attachment in issue['attachments'][:5]:  # Show max 5 attachments
                size_kb = attachment['size'] / 1024
                output.append(f"    - {attachment['filename']} ({size_kb:.1f} KB)")
            if issue['attachment_count'] > 5:
                output.append(f"    ... and {issue['attachment_count'] - 5} more attachment(s)")

        output.append("-" * 80)

    return "\n".join(output)


def format_json_output(results: List[Dict]) -> str:
    """Format search results as JSON."""
    return json.dumps(results, indent=2)


def format_simple_output(results: List[Dict]) -> str:
    """Format search results as simple key: summary list."""
    if not results:
        return "No matching issues found."

    output = [f"\nFound {len(results)} matching issue(s):\n"]
    for issue in results:
        output.append(f"{issue['key']}: {issue['summary']}")

    return "\n".join(output)


def main():
    """Main execution function."""
    parser = argparse.ArgumentParser(
        description='Search Jira issues by description and return matching IDs with summaries.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  %(prog)s --search "database migration" --username your.email@company.com
  %(prog)s -s "API error" -u user@example.com -m 10
  %(prog)s -s "login bug" -u user@example.com -f json
  %(prog)s -s "retrigger" --include-details  # Include matching comments and attachments

Search Tips:
  - Use quotes for exact phrases: "error message"
  - Use wildcards: migrat* matches migration, migrate, migrating
  - Use AND/OR operators: "database" AND "error"
  - Use --include-details to see matching comments and attachment names
        '''
    )

    parser.add_argument(
        '-s', '--search',
        required=True,
        help='Search term to find in issue summaries, descriptions, and comments'
    )

    parser.add_argument(
        '-u', '--username',
        default=os.getenv('JIRA_USERNAME'),
        help='Jira username (or set JIRA_USERNAME environment variable)'
    )

    parser.add_argument(
        '-m', '--max-results',
        type=int,
        default=50,
        help='Maximum number of results to return (default: 50)'
    )

    parser.add_argument(
        '-f', '--format',
        choices=['text', 'json', 'simple'],
        default='text',
        help='Output format (default: text)'
    )

    parser.add_argument(
        '--include-details',
        action='store_true',
        help='Include matching comments and attachments in results'
    )

    parser.add_argument(
        '--jira-url',
        default=os.getenv('JIRA_URL', DEFAULT_JIRA_URL),
        help=f'Jira server URL (default: {DEFAULT_JIRA_URL} or JIRA_URL env var)'
    )

    parser.add_argument(
        '-i', '--instance',
        choices=['clio'],
        default='clio',
        help='Jira instance label: clio (MedHOK Jira - jira.medhokapps.com)'
    )

    args = parser.parse_args()

    # Get instance configuration if --instance is used
    instance_config = get_instance(args.instance)

    # Use instance URL if --jira-url not explicitly provided
    if args.jira_url == os.getenv('JIRA_URL', DEFAULT_JIRA_URL):
        jira_url = instance_config['url']
    else:
        jira_url = args.jira_url

    # Get username if not provided, use instance default
    username = args.username
    if not username:
        username = instance_config['username']
    if not username:
        print("❌ Error: JIRA username not provided. Set JIRA_USERNAME environment variable or use -u flag.", file=sys.stderr)
        sys.exit(1)

    # Get password securely - use instance-specific env var
    password_key = get_password_env_key(args.instance)
    password = os.getenv(password_key)
    if not password:
        print(f"❌ Error: JIRA password not provided. Set {password_key} environment variable.", file=sys.stderr)
        sys.exit(1)

    try:
        # Initialize searcher and connect to Jira
        searcher = JiraSearcher(jira_url, username, password)

        # Get Jira label to filter by (if configured)
        jira_label = get_instance_label(args.instance)

        # Perform search
        results = searcher.search_issues(args.search, args.max_results, args.include_details, jira_label)

        # Format and display results
        if args.format == 'json':
            output = format_json_output(results)
        elif args.format == 'simple':
            output = format_simple_output(results)
        else:  # text
            output = format_text_output(results)

        print(output)

        # Exit with appropriate code
        sys.exit(0 if results else 1)

    except ValueError as e:
        print(f"\n❌ Error: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n\nSearch cancelled by user.", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
