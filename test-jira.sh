#!/bin/bash
# Test JIRA API connectivity with token from Secrets Manager

set -e

echo "========================================="
echo "JIRA API Connection Test"
echo "========================================="
echo ""

# Get JIRA credentials
JIRA_BASE_URL="https://mhkjira.atlassian.net"
JIRA_USERNAME="koundinya.kompalli@mhk.com"
JIRA_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id "arn:aws:secretsmanager:us-east-2:323960442001:secret:defectdef/prod/jira-token" \
  --region us-east-2 \
  --query 'SecretString' \
  --output text)

echo "JIRA Base URL: $JIRA_BASE_URL"
echo "JIRA Username: $JIRA_USERNAME"
echo "JIRA Token: ${JIRA_TOKEN:0:20}..." # Show first 20 chars
echo ""

# Test 1: Get current user
echo "Test 1: Get current user..."
response=$(curl -s -w "\n%{http_code}" \
  -u "${JIRA_USERNAME}:${JIRA_TOKEN}" \
  -H "Accept: application/json" \
  "${JIRA_BASE_URL}/rest/api/3/myself")

http_code=$(echo "$response" | tail -n 1)
body=$(echo "$response" | sed '$d')

echo "HTTP Status: $http_code"
if [ "$http_code" = "200" ]; then
  echo "✅ Authentication successful!"
  echo "User: $(echo "$body" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('displayName', 'N/A'))")"
else
  echo "❌ Authentication failed!"
  echo "Response: $body"
  exit 1
fi
echo ""

# Test 2: Test JQL search endpoint
echo "Test 2: Test /rest/api/3/search/jql endpoint..."
JQL="project = MHK"
response=$(curl -s -w "\n%{http_code}" \
  -u "${JIRA_USERNAME}:${JIRA_TOKEN}" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{\"jql\":\"$JQL\",\"maxResults\":1,\"fields\":[\"summary\",\"status\"]}" \
  "${JIRA_BASE_URL}/rest/api/3/search/jql")

http_code=$(echo "$response" | tail -n 1)
body=$(echo "$response" | sed '$d')

echo "HTTP Status: $http_code"
if [ "$http_code" = "200" ]; then
  echo "✅ JQL search successful!"
  total=$(echo "$body" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('total', 0))" 2>/dev/null || echo "0")
  echo "Total issues found: $total"
else
  echo "⚠️  JQL search failed with status $http_code"
  echo "Response: $body"
fi
echo ""

# Test 3: Test standard search endpoint
echo "Test 3: Test /rest/api/3/search endpoint (standard)..."
response=$(curl -s -w "\n%{http_code}" \
  -u "${JIRA_USERNAME}:${JIRA_TOKEN}" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{\"jql\":\"$JQL\",\"maxResults\":1,\"fields\":[\"summary\",\"status\"]}" \
  "${JIRA_BASE_URL}/rest/api/3/search")

http_code=$(echo "$response" | tail -n 1)
body=$(echo "$response" | sed '$d')

echo "HTTP Status: $http_code"
if [ "$http_code" = "200" ]; then
  echo "✅ Standard search successful!"
  total=$(echo "$body" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('total', 0))" 2>/dev/null || echo "0")
  echo "Total issues found: $total"
else
  echo "⚠️  Standard search failed with status $http_code"
  echo "Response: $body"
fi
echo ""

echo "========================================="
echo "Test Complete"
echo "========================================="
