# Specter shared dev-account configuration
#
# This file is intentionally committed because the repo targets a single shared
# AWS account. GitHub Actions workflows and local Terraform runs both rely on
# these non-secret account-specific inputs. Do not place credentials or secret
# values in this file.

aws_region  = "us-east-2"
environment = "prod"
owner       = "platform-team"

existing_vpc_id                = "vpc-0f059e0a3942b2e62"
subnet_ids                     = ["subnet-0791c0e76fc4f0e81"]
existing_efs_id                = "fs-07db87df276aef225"
existing_efs_security_group_id = "sg-01376d060dc750c88"
existing_task_role_arn         = "arn:aws:iam::323960442001:role/AmazonBedrockExecutionRoleForFlows_YX9G86Z5WQ"
existing_rds_security_group_id = "sg-05688873549501754"
db_credentials_secret_name     = "document-ai-prod/database/credentials"
db_host                        = "document-ai-prod-mysql.cxtyszxlzcsj.us-east-2.rds.amazonaws.com"
db_port                        = "3306"
db_name                        = "Specter"

jira_base_url                 = "https://mhkjira.atlassian.net"
jira_username                 = "devai@mhk.com"
jira_token_secret_name        = "defectdef/prod/jira-token"
github_repo_token_secret_name = "specter/prod/github-repository-token"
jira_polling_interval_ms      = 60000
result_check_interval_ms      = 30000

enable_oneshot                      = true
qualifier_desired_count             = 5
oneshot_planner_desired_count       = 5
oneshot_reviewer_desired_count      = 5
oneshot_implementer_desired_count   = 5
oneshot_code_reviewer_desired_count = 5
oneshot_tester_desired_count        = 5

oneshot_autoscaling_max_capacity = {
  planner       = 15
  reviewer      = 15
  implementer   = 15
  code_reviewer = 15
  tester        = 15
}

oneshot_reviewer_enabled                  = true
oneshot_reviewer_bypass_reason            = ""
oneshot_code_reviewer_enabled             = true
oneshot_code_reviewer_bypass_reason       = ""
oneshot_trace_enabled                     = true
oneshot_trace_post_to_jira                = true
oneshot_implementation_plan_post_to_jira  = true
oneshot_verify_enabled                    = true
oneshot_verify_mode                       = "balanced"
oneshot_description_repo_directive_mode   = "select"
oneshot_github_repo_owners                = "mhk-repos"
oneshot_maven_builds_enabled              = false
oneshot_maven_password_secret_name        = "specter/prod/oneshot-maven-password"
oneshot_workspace_lease_ttl_seconds       = 2700
oneshot_workspace_lease_heartbeat_seconds = 30
oneshot_repo_cache_freshness_ttl_ms       = 300000
oneshot_workspace_local_storage_gib       = 50
oneshot_review_stages_block_on_exhaustion = false
oneshot_healthcare_guardrails_enabled     = true
oneshot_readiness_active_risk_categories  = ""
oneshot_reviewer_provider                 = "anthropic"
oneshot_reviewer_model_id                 = "us.anthropic.claude-opus-4-8"
oneshot_code_reviewer_provider            = "anthropic"
oneshot_code_reviewer_model_id            = "us.anthropic.claude-opus-4-8"
oneshot_openai_max_tool_iterations        = 50
oneshot_max_total_tokens                  = 50000000
oneshot_max_stage_tokens_planning         = 4000000
oneshot_max_stage_tokens_review           = 2000000
oneshot_max_stage_tokens_implementation   = 4000000
oneshot_max_stage_tokens_code_review      = 2000000
oneshot_max_stage_tokens_testing          = 2000000
oneshot_planner_model_id                  = "us.anthropic.claude-opus-4-8"
oneshot_planner_max_output_tokens         = 100000
oneshot_planner_max_repo_tool_calls       = 75
oneshot_planner_max_turns                 = 75
oneshot_implementer_model_id              = "us.anthropic.claude-sonnet-5"
oneshot_implementer_max_output_tokens     = 100000
oneshot_implementer_max_turns             = 500
oneshot_claude_code_max_output_tokens     = 50000
oneshot_max_thinking_tokens               = 2048
oneshot_planner_scout_enabled             = true
oneshot_otel_enabled                      = true
worker_pin_image_by_digest                = false
oneshot_pin_image_by_digest               = true
oneshot_prompt_source                     = "local"
oneshot_comment_asset_base_url            = "https://productFactory.mhkdevsandbox.com"
oneshot_dashboard_base_url                = "https://productFactory.mhkdevsandbox.com"

bedrock_model_id                     = "us.anthropic.claude-opus-4-6-v1"
qualifier_model_id                   = "us.anthropic.claude-sonnet-4-6"
oneshot_statistics_llm_model_id      = "us.anthropic.claude-sonnet-4-6"
bedrock_region                       = "us-east-2"
worker_claude_code_max_output_tokens = 50000
worker_max_thinking_tokens           = 2048

orchestrator_cpu           = "512"
orchestrator_memory        = "1024"
orchestrator_desired_count = 1

darci_cpu           = "2048"
darci_memory        = "4096"
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

harvey_cpu               = "512"
harvey_memory            = "1024"
harvey_desired_count     = 1
harvey_teams_secret_name = "specter/prod/harvey-teams-credentials"
harvey_certificate_arn   = "arn:aws:acm:us-east-2:323960442001:certificate/53bcdad7-3adc-4c90-b7c9-b8cfef4cdd3d"
harvey_alb_subnet_ids    = ["subnet-0791c0e76fc4f0e81", "subnet-04d65e25a325fb1aa"]

dashboard_cpu           = "512"
dashboard_memory        = "2048"
dashboard_desired_count = 1
dashboard_allowed_cidr_blocks = [
  "172.22.0.0/16",
  "172.109.133.2/32",
  "172.29.0.0/16",
  "3.228.81.40/32",
  "104.226.237.202/32",
  "198.19.0.0/16",
  "97.76.206.30/32",
]
dashboard_https_extra_cidr_blocks = [
  "18.213.143.200/32",
  "3.95.71.203/32",
  "34.204.115.110/32",
  "34.202.101.90/32",
  "100.25.97.218/32",
  "54.157.90.188/32",
  "3.81.178.205/32",
  "3.214.96.250/32",
  "3.229.168.21/32",
  "18.235.87.170/32",
  "3.216.156.220/32",
  "34.197.197.230/32",
  "100.28.22.43/32",
  "44.216.33.181/32",
  "18.205.147.176/32",
  "34.198.26.10/32",
  "3.229.0.129/32",
  "54.88.219.69/32",
  "52.204.28.2/32",
  "3.218.110.248/32",
  "54.88.22.28/32",
  "52.86.160.53/32",
  "50.17.6.217/32",
  "98.87.107.66/32",
]
dashboard_offshore_workstation_cidr_blocks = [
  "34.225.187.132/32",
]
dashboard_operator_id_header          = "x-amzn-oidc-identity"
dashboard_operator_name_header        = "x-amzn-oidc-identity"
dashboard_coreapp_preview_url         = "https://client-a-cp-dev-mhk-core.mhkdevsandbox.com/medhok/"
dashboard_enable_cognito_auth         = true
dashboard_cognito_user_pool_arn       = "arn:aws:cognito-idp:us-east-2:323960442001:userpool/us-east-2_iyPKSO5fv"
dashboard_cognito_user_pool_client_id = "2t10givpd9p8ka3v2vph9h2351"
dashboard_cognito_user_pool_domain    = "specter-dashboard-dev-auth"

enable_spec_factory = true
# Keep the compatibility/API service at one task until the v4 Valkey, durable
# event/token, and queue cutover is certified. The v4 implementation permits
# horizontal API scaling after that gate; this alarm protects rollback mode.
# Gate 4 routes the transactional outbox through the split SQS consumers after
# shadow receipts, heartbeats, DLQs, and quarantine were verified clean. Keep
# the compatibility worker off; the API remains available as the rollback
# execution path until Work Order T is accepted.
spec_factory_desired_count                                 = 2
spec_factory_runtime_subnet_ids                            = ["subnet-0791c0e76fc4f0e81", "subnet-04d65e25a325fb1aa"]
spec_factory_additional_efs_mount_target_subnet_ids        = ["subnet-04d65e25a325fb1aa"]
spec_factory_pin_image_by_digest                           = true
spec_factory_context_v4_repair_run_id                      = 7
spec_factory_otel_sidecar_image                            = "public.ecr.aws/cloudwatch-agent/cloudwatch-agent@sha256:25d74002c0d80d4e43de1ba753e7a8a25c1d5cd07a737aeb29cedbaffb596bd1"
compose_retention_cleanup_enabled                          = true
compose_cleanup_dry_run                                    = true
spec_factory_log_retention_days                            = 365
spec_factory_workflow_state_rate_limit_max                 = 120
spec_factory_single_replica_alarm_enabled                  = false
spec_factory_autoscaling_enabled                           = true
spec_factory_api_max_count                                 = 30
spec_factory_api_requests_per_target                       = 300
spec_factory_ecs_task_protection_enabled                   = true
spec_factory_ecs_task_protection_expires_minutes           = 30
spec_factory_ecs_task_protection_refresh_ms                = 300000
spec_factory_ecs_task_protection_request_timeout_ms        = 3000
spec_factory_worker_scale_in_enabled                       = true
spec_factory_durable_turns                                 = "on"
spec_factory_durable_events_required                       = true
spec_factory_worker_heartbeat_enabled                      = true
spec_factory_agent_task_worker_enabled                     = true
spec_factory_agent_task_worker_capabilities                = "source_distillation,context_merge,code_research,config_research,devops_research"
spec_factory_workspace_manager_enabled                     = true
spec_factory_artifact_store                                = "efs"
spec_factory_data_subnet_ids                               = ["subnet-06cb5b8b728c4a4f3", "subnet-043da206194edbfcf", "subnet-06323422d157a5322"]
spec_factory_valkey_enabled                                = true
spec_factory_rds_proxy_enabled                             = true
spec_factory_rds_direct_fallback_enabled                   = true
spec_factory_rds_proxy_db_instance_identifier              = "document-ai-prod-mysql"
spec_factory_db_secret_kms_key_arn                         = "arn:aws:kms:us-east-2:323960442001:key/be66696d-c0a3-45ea-9910-c5ea4544438f"
spec_factory_queue_dispatch_mode                           = "primary"
spec_factory_outbox_enabled                                = true
spec_factory_worker_desired_count                          = 0
spec_factory_turn_worker_desired_count                     = 2
spec_factory_context_worker_desired_count                  = 2
spec_factory_research_worker_desired_count                 = 2
spec_factory_conversion_worker_desired_count               = 2
spec_factory_draft_worker_desired_count                    = 2
spec_factory_relay_worker_desired_count                    = 2
spec_factory_retention_worker_desired_count                = 1
spec_factory_source_delete_undo_minutes                    = 10
spec_factory_source_delete_sweep_ms                        = 60000
spec_factory_source_delete_purge_limit                     = 50
spec_factory_research_executor                             = "claude_agent_sdk"
spec_factory_research_ingress_enabled                      = true
spec_factory_research_allowed_tools                        = "Read,rg,Glob"
spec_factory_research_allowed_bash_patterns                = ""
spec_factory_research_max_cost_usd                         = "3.0"
spec_factory_research_cost_ceiling_usd                     = "10.0"
spec_factory_research_tasks_per_24h                        = "10"
spec_factory_research_inflight_tasks_per_session           = "2"
spec_factory_enable_context_distillation                   = true
spec_factory_enable_context_distillation_llm               = true
spec_factory_enable_context_merge                          = true
spec_factory_enable_context_merge_llm                      = true
spec_factory_draft_workflow_v2_enabled                     = true
spec_factory_handoff_enriched                              = true
spec_factory_handoff_build_task_enabled                    = true
spec_factory_handoff_llm_synthesis                         = true
spec_factory_llm_gateway_enabled                           = true
spec_factory_llm_direct_bedrock_purposes                   = "chat_coordinator_fast,context_merge"
spec_factory_llm_model_chat_coordinator_fast               = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
spec_factory_llm_model_chat_coordinator_strong             = "us.anthropic.claude-sonnet-5"
spec_factory_llm_model_source_distillation                 = "us.anthropic.claude-sonnet-5"
spec_factory_llm_model_context_merge                       = "us.anthropic.claude-sonnet-5"
spec_factory_llm_model_critic_review                       = "us.anthropic.claude-sonnet-5"
spec_factory_llm_model_handoff_synthesis                   = "us.anthropic.claude-sonnet-5"
spec_factory_llm_model_conversation_summary                = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
spec_factory_llm_max_output_tokens_chat_coordinator_fast   = "10000"
spec_factory_llm_max_output_tokens_chat_coordinator_strong = "10000"
spec_factory_llm_max_output_tokens_source_distillation     = "10000"
spec_factory_llm_max_output_tokens_context_merge           = "10000"
spec_factory_llm_max_output_tokens_critic_review           = "10000"
spec_factory_llm_max_output_tokens_handoff_synthesis       = "10000"
spec_factory_llm_max_output_tokens_conversation_summary    = "10000"
spec_factory_chat_coordinator_enabled                      = true
spec_factory_coordinator_max_tasks_per_turn                = "1"
spec_factory_louise_jql                                    = "labels = \"louise-estimated\" AND labels not in (\"SPEC-FACTORY-STARTED\") ORDER BY updated DESC"
spec_factory_model_id                                      = "us.anthropic.claude-sonnet-5"
spec_factory_research_model_id                             = "us.anthropic.claude-sonnet-5"
compose_chat_model_id                                      = "us.anthropic.claude-sonnet-5"
compose_voxtral_model_id                                   = "mistral.voxtral-small-24b-2507"
compose_audio_segment_seconds                              = 300
spec_factory_repo_deep_dive_enabled                        = true
compose_upload_allowed_origins                             = ["https://productfactory.mhkdevsandbox.com", "http://localhost:5173", "http://127.0.0.1:5173"]

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
