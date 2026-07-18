#!/bin/bash
JIRA_BASE_URL="${JIRA_BASE_URL:-https://mhkjira.atlassian.net}"
JIRA_USERNAME="${JIRA_USERNAME:-koundinya.kompalli@mhk.com}"
: "${JIRA_TOKEN:?Set JIRA_TOKEN to the dedicated Jira API token before running this script.}"

echo "Testing Agent JQL Queries..."
echo "=============================="
echo ""

for agent in "DARCI" "SCRIBE" "PRISM" "HERMES"; do
  echo "Agent: $agent"
  JQL="assignee = \"koundinya.kompalli@mhk.com\" AND labels = $agent ORDER BY created DESC"
  echo "JQL: $JQL"
  
  response=$(curl -s -u "${JIRA_USERNAME}:${JIRA_TOKEN}" \
    -X POST \
    -H "Content-Type: application/json" \
    "${JIRA_BASE_URL}/rest/api/3/search/jql" \
    -d "{\"jql\":\"$JQL\",\"maxResults\":5,\"fields\":[\"summary\",\"status\"]}")
  
  total=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total',0))" 2>/dev/null || echo "ERROR")
  
  if [ "$total" = "ERROR" ]; then
    echo "  ❌ Query failed!"
    echo "$response" | python3 -m json.tool | head -20
  else
    echo "  ✅ Total issues: $total"
    if [ "$total" != "0" ]; then
      echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  Issues:', [f\"{i['key']}: {i['fields']['summary'][:50]}...\" for i in d.get('issues',[])])"
    fi
  fi
  echo ""
done
