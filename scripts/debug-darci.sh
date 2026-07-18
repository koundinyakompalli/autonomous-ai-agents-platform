#!/bin/bash
# DARCI Real-Time Debugging Script
# Monitors DARCI CloudWatch logs with color-coded output

set -e

REGION="us-east-2"
LOG_GROUP="/ecs/specter/darci-worker"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI not found. Please install it first.${NC}"
    exit 1
fi

# Parse arguments
MODE="${1:-tail}"
FILTER="${2:-}"

show_usage() {
    echo "DARCI Debugging Tool"
    echo ""
    echo "Usage: $0 [mode] [filter]"
    echo ""
    echo "Modes:"
    echo "  tail          - Real-time tail (default)"
    echo "  errors        - Show only errors/warnings"
    echo "  task <ID>     - Filter by Jira task (e.g., MHK-12345)"
    echo "  tools         - Show tool executions"
    echo "  iterations    - Show iteration progress"
    echo "  phoenix       - Show Phoenix events"
    echo "  cost          - Show cost/token usage"
    echo "  status        - Check DARCI service status"
    echo "  insights      - Open CloudWatch Insights queries"
    echo ""
    echo "Examples:"
    echo "  $0 tail                    # Tail all logs"
    echo "  $0 errors                  # Show errors only"
    echo "  $0 task MHK-12345          # Filter by task"
    echo "  $0 tools                   # Watch tool executions"
    echo ""
}

check_service_status() {
    echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}          DARCI Service Status Check               ${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
    echo ""
    
    echo -e "${BLUE}Checking ECS service...${NC}"
    aws ecs describe-services \
        --cluster specter-cluster \
        --services DARCI \
        --region "$REGION" \
        --query 'services[0].{Status:status,Running:runningCount,Desired:desiredCount,Pending:pendingCount}' \
        --output table
    
    echo ""
    echo -e "${BLUE}Recent task status...${NC}"
    TASK_ARN=$(aws ecs list-tasks \
        --cluster specter-cluster \
        --service-name DARCI \
        --region "$REGION" \
        --query 'taskArns[0]' \
        --output text)
    
    if [ "$TASK_ARN" != "None" ] && [ -n "$TASK_ARN" ]; then
        aws ecs describe-tasks \
            --cluster specter-cluster \
            --tasks "$TASK_ARN" \
            --region "$REGION" \
            --query 'tasks[0].{LastStatus:lastStatus,HealthStatus:healthStatus,CreatedAt:createdAt}' \
            --output table
    else
        echo -e "${RED}No tasks running${NC}"
    fi
    
    echo ""
    echo -e "${BLUE}Recent errors (last 30 min)...${NC}"
    aws logs tail "$LOG_GROUP" \
        --region "$REGION" \
        --since 30m \
        --filter-pattern '{ $.level >= 50 }' \
        --format short 2>/dev/null | tail -10 || echo "No recent errors"
}

tail_logs() {
    local filter_pattern="$1"
    echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}          Tailing DARCI CloudWatch Logs            ${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}Log Group: $LOG_GROUP${NC}"
    echo -e "${YELLOW}Region: $REGION${NC}"
    
    if [ -n "$filter_pattern" ]; then
        echo -e "${YELLOW}Filter: $filter_pattern${NC}"
    fi
    
    echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}Streaming logs... (Press CTRL+C to stop)${NC}"
    echo ""
    
    if [ -n "$filter_pattern" ]; then
        aws logs tail "$LOG_GROUP" \
            --follow \
            --region "$REGION" \
            --filter-pattern "$filter_pattern" \
            --format short
    else
        aws logs tail "$LOG_GROUP" \
            --follow \
            --region "$REGION" \
            --format short
    fi
}

show_insights() {
    echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}        CloudWatch Insights Query Examples         ${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
    echo ""
    
    echo -e "${YELLOW}1. Average Task Duration:${NC}"
    echo "fields @timestamp, taskId, duration"
    echo "| filter msg like /Phoenix task complete/"
    echo "| stats avg(duration) as avgDuration, max(duration) as maxDuration"
    echo ""
    
    echo -e "${YELLOW}2. Tool Usage Statistics:${NC}"
    echo "fields @timestamp, tool, duration"
    echo "| filter tool != \"\""
    echo "| stats count() as calls, avg(duration) as avgDuration by tool"
    echo "| sort calls desc"
    echo ""
    
    echo -e "${YELLOW}3. Error Rate by Hour:${NC}"
    echo "fields @timestamp"
    echo "| filter level >= 50"
    echo "| stats count() as errors by bin(@timestamp, 1h)"
    echo ""
    
    echo -e "${YELLOW}4. Slow Tools (> 5 seconds):${NC}"
    echo "fields @timestamp, tool, duration"
    echo "| filter duration > 5000"
    echo "| sort duration desc"
    echo "| limit 20"
    echo ""
    
    echo -e "${BLUE}Open CloudWatch Insights:${NC}"
    echo "https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#logsV2:logs-insights"
}

# Main logic
case "$MODE" in
    help|--help|-h)
        show_usage
        ;;
    
    status)
        check_service_status
        ;;
    
    tail)
        tail_logs ""
        ;;
    
    errors)
        echo -e "${RED}Watching errors and warnings...${NC}"
        tail_logs '{ $.level >= 40 }'
        ;;
    
    task)
        if [ -z "$FILTER" ]; then
            echo -e "${RED}Error: Please provide a task ID${NC}"
            echo "Usage: $0 task MHK-12345"
            exit 1
        fi
        echo -e "${MAGENTA}Watching task: $FILTER${NC}"
        tail_logs "\"$FILTER\""
        ;;
    
    tools)
        echo -e "${GREEN}Watching tool executions...${NC}"
        tail_logs '"tool"'
        ;;
    
    iterations)
        echo -e "${BLUE}Watching iteration progress...${NC}"
        tail_logs '"iteration"'
        ;;
    
    phoenix)
        echo -e "${CYAN}Watching Phoenix events...${NC}"
        tail_logs '"Phoenix"'
        ;;
    
    cost)
        echo -e "${YELLOW}Watching cost and token usage...${NC}"
        tail_logs '"cost"'
        ;;
    
    insights)
        show_insights
        ;;
    
    *)
        echo -e "${RED}Unknown mode: $MODE${NC}"
        echo ""
        show_usage
        exit 1
        ;;
esac
