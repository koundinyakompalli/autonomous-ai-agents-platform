#!/usr/bin/env python3
"""
Jira Similarity Search Module
Search both old and new Jira instances for similar historical issues.
Can be used standalone or imported into other scripts.
"""

import os
import sys
from typing import List, Dict, Optional
from datetime import datetime
from jira import JIRA
from jira.exceptions import JIRAError
from dotenv import load_dotenv

# Load environment variables
load_dotenv()


class JiraSimilaritySearcher:
    """Search for similar issues across multiple Jira instances."""

    def __init__(self):
        """Initialize connections to both Jira instances."""
        self.old_jira = None
        self.new_jira = None
        self.old_jira_url = "https://jira.medhokapps.com"
        self.new_jira_url = os.getenv('JIRA_URL', 'https://mhkjira.atlassian.net')

    def connect_old_jira(self, username: str = 'rmcdonald', password: str = 'medhok123'):
        """Connect to old Jira instance (jira.medhokapps.com)."""
        try:
            self.old_jira = JIRA(
                options={'server': self.old_jira_url},
                basic_auth=(username, password)
            )
            return True
        except Exception as e:
            print(f"⚠️ Warning: Could not connect to old Jira: {e}", file=sys.stderr)
            return False

    def connect_new_jira(self, username: str = None, api_token: str = None):
        """Connect to new Jira instance (Atlassian Cloud)."""
        try:
            username = username or os.getenv('JIRA_USERNAME')
            api_token = api_token or os.getenv('JIRA_PASSWORD')

            if not username or not api_token:
                print("⚠️ Warning: JIRA_USERNAME or JIRA_PASSWORD not set", file=sys.stderr)
                return False

            self.new_jira = JIRA(
                options={
                    'server': self.new_jira_url,
                    'rest_api_version': '3'
                },
                basic_auth=(username, api_token)
            )
            return True
        except Exception as e:
            print(f"⚠️ Warning: Could not connect to new Jira: {e}", file=sys.stderr)
            return False

    def search_old_jira(self, search_term: str, max_results: int = 20) -> List[Dict]:
        """
        Search old Jira for similar issues.

        Args:
            search_term: Term to search for
            max_results: Maximum number of results

        Returns:
            List of issue dictionaries
        """
        if not self.old_jira:
            if not self.connect_old_jira():
                return []

        results = []
        try:
            jql_query = f'text ~ "{search_term}"'
            issues = self.old_jira.search_issues(
                jql_query,
                maxResults=max_results,
                fields='key,summary,status,resolution,description,created,updated,assignee'
            )

            for issue in issues:
                # Get description preview
                desc_preview = ""
                if hasattr(issue.fields, 'description') and issue.fields.description:
                    desc = str(issue.fields.description)
                    desc_preview = desc[:200].replace('\n', ' ')
                    if len(desc) > 200:
                        desc_preview += '...'

                # Get resolution
                resolution = "Unresolved"
                if hasattr(issue.fields, 'resolution') and issue.fields.resolution:
                    resolution = issue.fields.resolution.name

                # Get assignee
                assignee = "Unassigned"
                if hasattr(issue.fields, 'assignee') and issue.fields.assignee:
                    assignee = issue.fields.assignee.displayName

                results.append({
                    'key': issue.key,
                    'summary': issue.fields.summary,
                    'status': issue.fields.status.name,
                    'resolution': resolution,
                    'description_preview': desc_preview,
                    'created': str(issue.fields.created),
                    'updated': str(issue.fields.updated),
                    'assignee': assignee,
                    'url': f"{self.old_jira_url}/browse/{issue.key}",
                    'instance': 'old_jira'
                })

        except Exception as e:
            print(f"⚠️ Error searching old Jira: {e}", file=sys.stderr)

        return results

    def search_new_jira(self, search_term: str, max_results: int = 20,
                        label: str = None) -> List[Dict]:
        """
        Search new Jira (Atlassian Cloud) for similar issues.

        Args:
            search_term: Term to search for
            max_results: Maximum number of results
            label: Optional label to filter by (e.g., "Clio")

        Returns:
            List of issue dictionaries
        """
        if not self.new_jira:
            if not self.connect_new_jira():
                return []

        results = []
        try:
            # Build JQL query
            if label:
                jql_query = f'labels = "{label}" AND text ~ "{search_term}"'
            else:
                jql_query = f'text ~ "{search_term}"'

            issues = self.new_jira.search_issues(
                jql_query,
                maxResults=max_results,
                fields='key,summary,status,resolution,description,created,updated,assignee,comment'
            )

            for issue in issues:
                # Get description preview
                desc_preview = ""
                if hasattr(issue.fields, 'description') and issue.fields.description:
                    desc = str(issue.fields.description)
                    desc_preview = desc[:200].replace('\n', ' ')
                    if len(desc) > 200:
                        desc_preview += '...'

                # Get resolution
                resolution = "Unresolved"
                if hasattr(issue.fields, 'resolution') and issue.fields.resolution:
                    resolution = issue.fields.resolution.name

                # Get assignee
                assignee = "Unassigned"
                if hasattr(issue.fields, 'assignee') and issue.fields.assignee:
                    assignee = issue.fields.assignee.displayName

                # Get comment count
                comment_count = 0
                if hasattr(issue.fields, 'comment') and issue.fields.comment:
                    comment_count = len(issue.fields.comment.comments)

                results.append({
                    'key': issue.key,
                    'summary': issue.fields.summary,
                    'status': issue.fields.status.name,
                    'resolution': resolution,
                    'description_preview': desc_preview,
                    'created': str(issue.fields.created),
                    'updated': str(issue.fields.updated),
                    'assignee': assignee,
                    'comment_count': comment_count,
                    'url': f"{self.new_jira_url}/browse/{issue.key}",
                    'instance': 'new_jira'
                })

        except Exception as e:
            print(f"⚠️ Error searching new Jira: {e}", file=sys.stderr)

        return results

    def search_all(self, search_term: str, max_results_per_instance: int = 10,
                   new_jira_label: str = None) -> Dict[str, List[Dict]]:
        """
        Search both Jira instances for similar issues.

        Args:
            search_term: Term to search for
            max_results_per_instance: Max results per instance
            new_jira_label: Optional label for new Jira (e.g., "Clio")

        Returns:
            Dictionary with 'old_jira' and 'new_jira' keys containing results
        """
        results = {
            'old_jira': self.search_old_jira(search_term, max_results_per_instance),
            'new_jira': self.search_new_jira(search_term, max_results_per_instance, new_jira_label)
        }

        return results

    def find_similar_issues(self, issue_summary: str, issue_description: str = "",
                           max_results: int = 10) -> Dict:
        """
        Find similar historical issues based on summary and description.

        Args:
            issue_summary: Summary/title of the issue
            issue_description: Description of the issue
            max_results: Maximum number of results to return

        Returns:
            Dictionary with similarity search results and analysis
        """
        # Extract key terms from summary and description
        search_terms = self._extract_search_terms(issue_summary, issue_description)

        all_results = []

        # Search using different term combinations
        for term in search_terms[:3]:  # Use top 3 search terms
            results = self.search_all(term, max_results_per_instance=5)
            all_results.extend(results.get('old_jira', []))
            all_results.extend(results.get('new_jira', []))

        # Deduplicate by key
        unique_results = {}
        for result in all_results:
            key = result['key']
            if key not in unique_results:
                unique_results[key] = result

        # Sort by relevance (resolved issues first, then by updated date)
        sorted_results = sorted(
            unique_results.values(),
            key=lambda x: (
                0 if x['resolution'] != 'Unresolved' else 1,
                x['updated']
            ),
            reverse=True
        )[:max_results]

        # Analyze results
        analysis = self._analyze_results(sorted_results)

        return {
            'search_terms': search_terms,
            'similar_issues': sorted_results,
            'analysis': analysis
        }

    def _extract_search_terms(self, summary: str, description: str) -> List[str]:
        """Extract key search terms from summary and description."""
        # Common words to exclude
        stop_words = {'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at',
                     'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was',
                     'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do',
                     'does', 'did', 'will', 'would', 'should', 'could', 'may',
                     'might', 'must', 'can', 'this', 'that', 'these', 'those'}

        # Combine summary and description
        text = f"{summary} {description}".lower()

        # Extract words (3+ characters, not in stop words)
        words = [w.strip('.,!?;:()[]{}') for w in text.split()]
        words = [w for w in words if len(w) >= 3 and w not in stop_words]

        # Get unique words maintaining order
        seen = set()
        unique_words = []
        for word in words:
            if word not in seen:
                seen.add(word)
                unique_words.append(word)

        # Return phrases if found, otherwise individual words
        search_terms = []

        # Look for common technical phrases
        if 'error' in unique_words or 'exception' in unique_words:
            search_terms.append('error')
        if 'save' in unique_words or 'saving' in unique_words:
            search_terms.append('save')
        if 'database' in unique_words or 'db' in unique_words:
            search_terms.append('database')
        if 'template' in unique_words:
            search_terms.append('template')
        if 'referral' in unique_words:
            search_terms.append('referral')
        if 'care plan' in text or 'careplan' in text:
            search_terms.append('care plan')

        # Add remaining unique words (up to 5 total terms)
        for word in unique_words:
            if word not in search_terms and len(search_terms) < 5:
                search_terms.append(word)

        return search_terms if search_terms else unique_words[:5]

    def _analyze_results(self, results: List[Dict]) -> Dict:
        """Analyze similarity search results."""
        if not results:
            return {
                'total_found': 0,
                'resolved_count': 0,
                'most_recent': None,
                'recommendation': 'No similar issues found in historical data.'
            }

        resolved = [r for r in results if r['resolution'] != 'Unresolved']
        unresolved = [r for r in results if r['resolution'] == 'Unresolved']

        most_recent = results[0] if results else None

        recommendation = ""
        if resolved:
            recommendation = f"Found {len(resolved)} resolved similar issue(s). Review these for potential solutions."
        elif unresolved:
            recommendation = f"Found {len(unresolved)} unresolved similar issue(s). This may be a recurring problem."

        return {
            'total_found': len(results),
            'resolved_count': len(resolved),
            'unresolved_count': len(unresolved),
            'most_recent': most_recent,
            'recommendation': recommendation,
            'old_jira_count': len([r for r in results if r['instance'] == 'old_jira']),
            'new_jira_count': len([r for r in results if r['instance'] == 'new_jira'])
        }

    def format_results_markdown(self, similarity_results: Dict) -> str:
        """Format similarity search results as markdown."""
        lines = []

        lines.append("## Historical Similar Issues")
        lines.append("")

        analysis = similarity_results.get('analysis', {})
        lines.append(f"**Total Found:** {analysis.get('total_found', 0)}")
        lines.append(f"**Resolved:** {analysis.get('resolved_count', 0)}")
        lines.append(f"**Unresolved:** {analysis.get('unresolved_count', 0)}")
        lines.append(f"**Old Jira:** {analysis.get('old_jira_count', 0)}")
        lines.append(f"**New Jira:** {analysis.get('new_jira_count', 0)}")
        lines.append("")
        lines.append(f"**Recommendation:** {analysis.get('recommendation', 'N/A')}")
        lines.append("")

        similar_issues = similarity_results.get('similar_issues', [])
        if similar_issues:
            lines.append("### Similar Issues Found:")
            lines.append("")

            for i, issue in enumerate(similar_issues[:10], 1):
                instance_label = "🏛️ Old Jira" if issue['instance'] == 'old_jira' else "☁️ New Jira"
                resolution_emoji = "✅" if issue['resolution'] != 'Unresolved' else "⏳"

                lines.append(f"{i}. {resolution_emoji} **[{issue['key']}]({issue['url']})** - {issue['summary']}")
                lines.append(f"   - **Instance:** {instance_label}")
                lines.append(f"   - **Status:** {issue['status']} | **Resolution:** {issue['resolution']}")
                lines.append(f"   - **Updated:** {issue['updated'][:10]}")
                if issue.get('description_preview'):
                    lines.append(f"   - **Description:** {issue['description_preview']}")
                lines.append("")
        else:
            lines.append("*No similar issues found.*")

        lines.append("---")
        lines.append(f"*Search performed: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*")

        return "\n".join(lines)

    def format_results_text(self, similarity_results: Dict) -> str:
        """Format similarity search results as plain text."""
        lines = []

        lines.append("=" * 80)
        lines.append("HISTORICAL SIMILAR ISSUES")
        lines.append("=" * 80)
        lines.append("")

        analysis = similarity_results.get('analysis', {})
        lines.append(f"Total Found:    {analysis.get('total_found', 0)}")
        lines.append(f"Resolved:       {analysis.get('resolved_count', 0)}")
        lines.append(f"Unresolved:     {analysis.get('unresolved_count', 0)}")
        lines.append(f"Old Jira:       {analysis.get('old_jira_count', 0)}")
        lines.append(f"New Jira:       {analysis.get('new_jira_count', 0)}")
        lines.append("")
        lines.append(f"Recommendation: {analysis.get('recommendation', 'N/A')}")
        lines.append("")

        similar_issues = similarity_results.get('similar_issues', [])
        if similar_issues:
            lines.append("SIMILAR ISSUES FOUND:")
            lines.append("-" * 80)

            for i, issue in enumerate(similar_issues[:10], 1):
                instance_label = "[OLD JIRA]" if issue['instance'] == 'old_jira' else "[NEW JIRA]"
                resolution_marker = "[RESOLVED]" if issue['resolution'] != 'Unresolved' else "[OPEN]"

                lines.append(f"\n{i}. {resolution_marker} {instance_label} {issue['key']}")
                lines.append(f"   {issue['summary']}")
                lines.append(f"   Status: {issue['status']} | Resolution: {issue['resolution']}")
                lines.append(f"   Updated: {issue['updated'][:10]}")
                lines.append(f"   URL: {issue['url']}")
                if issue.get('description_preview'):
                    lines.append(f"   Description: {issue['description_preview']}")
        else:
            lines.append("No similar issues found.")

        lines.append("")
        lines.append("=" * 80)
        lines.append(f"Search performed: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append("=" * 80)

        return "\n".join(lines)


def main():
    """Example usage of the JiraSimilaritySearcher."""
    import argparse

    parser = argparse.ArgumentParser(description='Search for similar issues across Jira instances')
    parser.add_argument('-s', '--summary', required=True, help='Issue summary/title')
    parser.add_argument('-d', '--description', default='', help='Issue description')
    parser.add_argument('-m', '--max-results', type=int, default=10, help='Max results (default: 10)')
    parser.add_argument('-f', '--format', choices=['text', 'markdown'], default='text',
                       help='Output format (default: text)')

    args = parser.parse_args()

    # Create searcher and find similar issues
    searcher = JiraSimilaritySearcher()
    results = searcher.find_similar_issues(
        args.summary,
        args.description,
        args.max_results
    )

    # Format and display results
    if args.format == 'markdown':
        output = searcher.format_results_markdown(results)
    else:
        output = searcher.format_results_text(results)

    print(output)


if __name__ == '__main__':
    main()
