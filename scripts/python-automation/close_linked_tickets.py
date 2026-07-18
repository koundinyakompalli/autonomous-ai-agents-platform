"""
Close all tickets linked to a parent JIRA ticket
This script is useful for closing automatically created tickets from BCAT
"""
from jira import JIRA
import os
import sys
import argparse

# Fix encoding for Windows console
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')


class JiraTicketCloser:
    """Close JIRA tickets and their linked issues."""

    def __init__(self, server: str = None, email: str = None, api_token: str = None):
        """Initialize JIRA connection."""
        self.server = server or os.getenv('JIRA_SERVER') or "https://mhkjira.atlassian.net"
        self.email = email or os.getenv('JIRA_EMAIL') or "smulheron@mhk.com"
        self.api_token = api_token or os.getenv('JIRA_API_TOKEN')

        if not all([self.server, self.email, self.api_token]):
            raise ValueError(
                "Missing JIRA credentials. Set JIRA_SERVER, JIRA_EMAIL, "
                "and JIRA_API_TOKEN environment variables."
            )

        self.jira = JIRA(
            server=self.server,
            basic_auth=(self.email, self.api_token)
        )
        print(f"✓ Connected to {self.server}")

    def get_linked_tickets(self, parent_key: str):
        """Get all tickets linked to a parent ticket."""
        try:
            parent = self.jira.issue(parent_key)
            linked_tickets = []

            # Get issue links
            for link in parent.fields.issuelinks:
                if hasattr(link, 'outwardIssue'):
                    linked_tickets.append(link.outwardIssue.key)
                elif hasattr(link, 'inwardIssue'):
                    linked_tickets.append(link.inwardIssue.key)

            # Get subtasks
            if hasattr(parent.fields, 'subtasks') and parent.fields.subtasks:
                for subtask in parent.fields.subtasks:
                    linked_tickets.append(subtask.key)

            print(f"\n✓ Found {len(linked_tickets)} linked tickets for {parent_key}")
            return linked_tickets

        except Exception as e:
            print(f"✗ Error getting linked tickets: {e}")
            return []

    def get_close_transition(self, issue_key: str):
        """Find the transition ID for closing a ticket."""
        try:
            transitions = self.jira.transitions(issue_key)

            # Look for close/done transitions
            close_keywords = ['close', 'done', 'complete', 'resolved', 'resolve']

            for transition in transitions:
                transition_name = transition['name'].lower()
                if any(keyword in transition_name for keyword in close_keywords):
                    return transition['id'], transition['name']

            # If no close transition found, return None
            return None, None

        except Exception as e:
            print(f"  ✗ Error getting transitions for {issue_key}: {e}")
            return None, None

    def close_ticket(self, issue_key: str, comment: str = None):
        """Close a single ticket."""
        try:
            # Get the issue details
            issue = self.jira.issue(issue_key)
            current_status = issue.fields.status.name

            print(f"\n{issue_key}: {issue.fields.summary}")
            print(f"  Current status: {current_status}")

            # Check if already closed (but not resolved - resolved needs to move to closed)
            if current_status.lower() in ['closed', 'done', 'complete']:
                print(f"  ✓ Already closed/done")
                return True

            # Find close transition
            transition_id, transition_name = self.get_close_transition(issue_key)

            if not transition_id:
                print(f"  ⚠ No close transition available. Available transitions:")
                transitions = self.jira.transitions(issue_key)
                for t in transitions:
                    print(f"    - {t['name']}")
                return False

            # Transition the ticket with resolution
            try:
                self.jira.transition_issue(
                    issue_key,
                    transition_id,
                    fields={'resolution': {'name': 'Done'}}
                )
                print(f"  ✓ Closed via '{transition_name}' transition")
            except Exception as trans_error:
                # Try without resolution if it fails
                if 'resolution' in str(trans_error).lower():
                    # Try with different resolution values
                    for resolution in ['Done', 'Complete', 'Resolved', 'Fixed']:
                        try:
                            self.jira.transition_issue(
                                issue_key,
                                transition_id,
                                fields={'resolution': {'name': resolution}}
                            )
                            print(f"  ✓ Closed via '{transition_name}' transition (resolution: {resolution})")
                            break
                        except:
                            continue
                    else:
                        raise trans_error
                else:
                    raise trans_error

            # Add comment if provided
            if comment:
                self.jira.add_comment(issue_key, comment)
                print(f"  ✓ Added comment")

            return True

        except Exception as e:
            print(f"  ✗ Error closing {issue_key}: {e}")
            return False

    def close_linked_tickets(self, parent_key: str, dry_run: bool = False, comment: str = None):
        """Close all tickets linked to a parent ticket."""
        print(f"\n{'='*60}")
        print(f"Closing linked tickets for {parent_key}")
        if dry_run:
            print("DRY RUN MODE - No tickets will be closed")
        print(f"{'='*60}")

        # Get linked tickets
        linked_tickets = self.get_linked_tickets(parent_key)

        if not linked_tickets:
            print("\n⚠ No linked tickets found")
            return

        # Show what will be closed
        print(f"\nTickets to close: {', '.join(linked_tickets)}")

        if dry_run:
            print("\nDRY RUN - Would close the above tickets")
            return

        # Confirm before closing
        response = input(f"\nClose {len(linked_tickets)} tickets? (yes/no): ")
        if response.lower() not in ['yes', 'y']:
            print("Cancelled")
            return

        # Close each ticket
        closed_count = 0
        for ticket_key in linked_tickets:
            if self.close_ticket(ticket_key, comment):
                closed_count += 1

        print(f"\n{'='*60}")
        print(f"✓ Successfully closed {closed_count}/{len(linked_tickets)} tickets")
        print(f"{'='*60}\n")


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description='Close all tickets linked to a parent JIRA ticket',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Close all linked tickets (with confirmation)
  python close_linked_tickets.py CPSUP-40167

  # Dry run to see what would be closed
  python close_linked_tickets.py CPSUP-40167 --dry-run

  # Close with a comment
  python close_linked_tickets.py CPSUP-40167 --comment "Closing automatically created tickets"
        """
    )

    parser.add_argument('ticket', help='Parent ticket key (e.g., CPSUP-40167)')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be closed without closing')
    parser.add_argument('--comment', help='Add comment to closed tickets')
    parser.add_argument('--server', help='JIRA server URL')
    parser.add_argument('--email', help='JIRA email')
    parser.add_argument('--token', help='JIRA API token')

    args = parser.parse_args()

    # Initialize closer
    try:
        closer = JiraTicketCloser(
            server=args.server,
            email=args.email,
            api_token=args.token
        )
    except ValueError as e:
        print(f"Error: {e}")
        return

    # Close linked tickets
    try:
        closer.close_linked_tickets(
            parent_key=args.ticket,
            dry_run=args.dry_run,
            comment=args.comment
        )
    except Exception as e:
        print(f"\nError: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
