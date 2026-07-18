# Specter Shared Account Configuration
# DO NOT commit secrets to git - use for local deployment only

aws_region  = "us-east-2"
environment = "prod"
owner       = "platform-team"

existing_vpc_id                = "vpc-0f059e0a3942b2e62"
subnet_ids                     = ["subnet-0791c0e76fc4f0e81"]
existing_efs_id                = "fs-07db87df276aef225"
existing_efs_security_group_id = "sg-01376d060dc750c88"
existing_task_role_arn         = "arn:aws:iam::323960442001:role/AmazonBedrockExecutionRoleForFlows_YX9G86Z5WQ"
db_credentials_secret_name     = "document-ai-prod/database/credentials"
db_host                        = "document-ai-prod-mysql.cxtyszxlzcsj.us-east-2.rds.amazonaws.com"
db_port                        = "3306"
db_name                        = "Specter"

jira_base_url            = "https://mhkjira.atlassian.net"
jira_username            = "devai@mhk.com"
jira_polling_interval_ms = 60000
result_check_interval_ms = 30000

bedrock_model_id = "us.anthropic.claude-opus-4-6-v1"
bedrock_region   = "us-east-2"

orchestrator_cpu           = "512"
orchestrator_memory        = "1024"
orchestrator_desired_count = 1

darci_cpu           = "1024"
darci_memory        = "2048"
darci_desired_count = 1

scribe_cpu           = "512"
scribe_memory        = "1024"
scribe_desired_count = 1

prism_cpu           = "512"
prism_memory        = "1024"
prism_desired_count = 1

hermes_cpu           = "1024"
hermes_memory        = "2048"
hermes_desired_count = 1

sentry_cpu           = "512"
sentry_memory        = "1024"
sentry_desired_count = 1

beacon_cpu           = "512"
beacon_memory        = "1024"
beacon_desired_count = 1

bcat_planner_cpu           = "256"
bcat_planner_memory        = "512"
bcat_planner_desired_count = 1

bcat_executor_cpu           = "256"
bcat_executor_memory        = "512"
bcat_executor_desired_count = 1

veritas_cpu           = "1024"
veritas_memory        = "2048"
veritas_desired_count = 1

srlog_cpu           = "1024"
srlog_memory        = "2048"
srlog_desired_count = 1

worker_polling_interval_ms = 10000

# Harvey (Conversational Intake Agent - Teams Bot)
harvey_cpu             = "512"
harvey_memory          = "1024"
harvey_desired_count   = 1
harvey_certificate_arn = "arn:aws:acm:us-east-2:323960442001:certificate/53bcdad7-3adc-4c90-b7c9-b8cfef4cdd3d"
harvey_alb_subnet_ids  = ["subnet-0791c0e76fc4f0e81", "subnet-04d65e25a325fb1aa"]

dashboard_cpu           = "512"
dashboard_memory        = "2048"
dashboard_desired_count = 1

enable_watchdog                  = true
watchdog_mcp_image_tag           = "latest"
watchdog_prod_reader_secret_name = "/specter/dev/watchdog/prod-reader"
watchdog_prod_account_id         = "239350186085"
watchdog_evidence_bucket         = "specter-watchdog-evidence"
watchdog_investigator            = "llm_log_analysis"
watchdog_agentic_mcp_loop        = "disabled"
watchdog_claude_max_turns        = 3
watchdog_llm_max_output_tokens   = 1800
watchdog_claude_timeout_ms       = 240000

log_retention_days        = 30
enable_container_insights = true

s3_task_bucket   = "specter-tasks"
s3_result_bucket = "specter-results"
