# Variables for Specter Infrastructure
# Designed to reuse existing MedHok AWS infrastructure

# General Configuration
variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-2"
}

variable "environment" {
  description = "Deployment label used for tags and resource naming"
  type        = string
  default     = "shared"
}

variable "owner" {
  description = "Owner/Team responsible for this infrastructure"
  type        = string
  default     = "platform-team"
}

# ============================================================================
# EXISTING INFRASTRUCTURE (REUSED)
# ============================================================================

# Existing VPC (same as RDS)
variable "existing_vpc_id" {
  description = "ID of existing VPC to reuse"
  type        = string
}

# Subnets for ECS tasks
variable "subnet_ids" {
  description = "Subnet IDs for ECS tasks (private subnets in VPC)"
  type        = list(string)
}

# Existing EFS
variable "existing_efs_id" {
  description = "ID of existing EFS file system"
  type        = string
}

variable "existing_efs_security_group_id" {
  description = "Security group ID for EFS"
  type        = string
}

# Existing ECS Task Role (has Bedrock permissions already)
variable "existing_task_role_arn" {
  description = "ARN of existing ECS task role with Bedrock access"
  type        = string
}

variable "existing_rds_security_group_id" {
  description = "Security group ID for the existing Specter RDS instance"
  type        = string
}

# Existing RDS MySQL
variable "db_credentials_secret_name" {
  description = "Secrets Manager secret name containing RDS credentials"
  type        = string
}

variable "db_host" {
  description = "RDS MySQL host"
  type        = string
}

variable "db_port" {
  description = "RDS MySQL port"
  type        = string
  default     = "3306"
}

variable "db_name" {
  description = "Database name for Specter"
  type        = string
  default     = "Specter"
}

# ============================================================================
# APPLICATION CONFIGURATION
# ============================================================================

# JIRA Configuration
variable "jira_base_url" {
  description = "JIRA base URL"
  type        = string
  default     = "https://medhokapps.atlassian.net"
}

variable "jira_username" {
  description = "JIRA username for API access"
  type        = string
  default     = "koundinya.kompalli@mhk.com"
}

variable "jira_token_secret_name" {
  description = "Secrets Manager secret name containing the shared JIRA API token"
  type        = string
}

variable "github_repo_token_secret_name" {
  description = "Secrets Manager secret name containing the shared GitHub repository token used for worker git clones"
  type        = string
}

variable "github_write_token_secret_name" {
  description = "Secrets Manager secret name containing the write-capable GitHub token used by OneShot implementer for branch push and draft PR creation"
  type        = string
  default     = "specter/prod/github-write-token"
}

variable "github_app_credentials_secret_name" {
  description = "Secrets Manager secret name containing GitHub App credentials for OneShot branch push and PR creation"
  type        = string
  default     = "specter/prod/github-app/oneshot"
}

variable "github_app_webhook_secret_name" {
  description = "Secrets Manager secret name containing the GitHub App webhook secret for OneShot slash-command intake"
  type        = string
  default     = "specter/prod/github-app/oneshot-webhook-secret"
}

variable "openai_reviewer_api_key_secret_name" {
  description = "Secrets Manager secret name containing the OpenAI API key used by the OneShot reviewer"
  type        = string
  default     = "specter/prod/openai-reviewer-api-key"
}

variable "oneshot_deploy_webhook_secret_name" {
  description = "Secrets Manager secret name containing the shared webhook secret used by the core-app preview deploy workflow callback"
  type        = string
  default     = "specter/prod/oneshot-deploy-webhook-secret"
}

variable "oneshot_maven_artifactory_host" {
  description = "Artifactory host injected into OneShot Maven-capable workers for repo-local .m2/settings.xml"
  type        = string
  default     = ""
}

variable "oneshot_maven_builds_enabled" {
  description = "Whether OneShot implementer/tester workers may run Maven builds/tests. Disable when Artifactory is unavailable so Maven proof is skipped as unverified instead of failing runs."
  type        = bool
  default     = true
}

variable "oneshot_maven_user" {
  description = "Optional plaintext Artifactory username injected into OneShot Maven-capable workers when oneshot_maven_user_secret_name is not set"
  type        = string
  default     = ""
}

variable "oneshot_maven_user_secret_name" {
  description = "Optional Secrets Manager secret name containing the Maven/Artifactory username for OneShot Maven-capable workers"
  type        = string
  default     = ""
}

variable "oneshot_maven_user_secret_json_key" {
  description = "Optional JSON key inside oneshot_maven_user_secret_name that contains the Maven/Artifactory username"
  type        = string
  default     = ""
}

variable "oneshot_maven_password_secret_name" {
  description = "Optional Secrets Manager secret name containing the Maven/Artifactory password for OneShot Maven-capable workers"
  type        = string
  default     = ""
}

variable "oneshot_maven_password_secret_json_key" {
  description = "Optional JSON key inside oneshot_maven_password_secret_name that contains the Maven/Artifactory password"
  type        = string
  default     = ""
}

variable "oneshot_maven_cli_opts" {
  description = "Maven CLI options exposed to OneShot Maven-capable workers for shell-based validation commands"
  type        = string
  default     = "-s .m2/settings.xml --batch-mode"
}

variable "oneshot_maven_opts" {
  description = "Maven JVM/system options exposed to OneShot Maven-capable workers"
  type        = string
  default     = "-Dmaven.repo.local=/tmp/oneshot/maven-repository -Dmaven.wagon.http.ssl.insecure=true -Dmaven.wagon.http.ssl.allowall=true -Daether.connector.https.securityMode=insecure"
}

variable "jira_polling_interval_ms" {
  description = "Orchestrator JIRA polling interval in milliseconds"
  type        = number
  default     = 60000
}

variable "result_check_interval_ms" {
  description = "Orchestrator result check interval in milliseconds"
  type        = number
  default     = 30000
}

# Bedrock Configuration
variable "bedrock_model_id" {
  description = "Bedrock model ID to use"
  type        = string
  default     = "us.anthropic.claude-opus-4-6-v1"
}

variable "bedrock_region" {
  description = "Region for Bedrock API calls"
  type        = string
  default     = "us-east-2"
}

variable "worker_claude_code_max_output_tokens" {
  description = "Global Claude Code SDK output token cap for generic Specter workers"
  type        = number
  default     = 50000

  validation {
    condition     = var.worker_claude_code_max_output_tokens > 0
    error_message = "worker_claude_code_max_output_tokens must be positive."
  }
}

variable "worker_max_thinking_tokens" {
  description = "Global Claude Code SDK thinking token budget for generic Specter workers"
  type        = number
  default     = 2048

  validation {
    condition     = var.worker_max_thinking_tokens > 0
    error_message = "worker_max_thinking_tokens must be positive."
  }
}

variable "enable_teams_notifier" {
  description = "When true, deploys the Lambda that forwards oneshot SNS alerts to a Microsoft Teams channel via an incoming webhook URL stored in Secrets Manager."
  type        = bool
  default     = true
}

variable "teams_webhook_secret_name" {
  description = "Secrets Manager secret name containing the Microsoft Teams incoming webhook URL for oneshot alerts. Secret value must be the raw URL string."
  type        = string
  default     = "specter/prod/teams-webhook-url"
}

# ============================================================================
# ECS CONFIGURATION
# ============================================================================

# Orchestrator
variable "orchestrator_cpu" {
  description = "CPU units for orchestrator (256, 512, 1024, 2048)"
  type        = string
  default     = "512"
}

variable "orchestrator_memory" {
  description = "Memory for orchestrator in MB"
  type        = string
  default     = "1024"
}

variable "orchestrator_desired_count" {
  description = "Number of orchestrator instances"
  type        = number
  default     = 1
}

# DARCI Worker
variable "darci_cpu" {
  description = "CPU units for DARCI worker"
  type        = string
  default     = "1024"
}

variable "darci_memory" {
  description = "Memory for DARCI worker in MB"
  type        = string
  default     = "2048"
}

variable "darci_desired_count" {
  description = "Number of DARCI worker instances"
  type        = number
  default     = 1
}

# SCRIBE Worker
variable "scribe_cpu" {
  description = "CPU units for SCRIBE worker"
  type        = string
  default     = "512"
}

variable "scribe_memory" {
  description = "Memory for SCRIBE worker in MB"
  type        = string
  default     = "1024"
}

variable "scribe_desired_count" {
  description = "Number of SCRIBE worker instances"
  type        = number
  default     = 1
}

# PRISM Worker
variable "prism_cpu" {
  description = "CPU units for PRISM worker"
  type        = string
  default     = "512"
}

variable "prism_memory" {
  description = "Memory for PRISM worker in MB"
  type        = string
  default     = "1024"
}

variable "prism_desired_count" {
  description = "Number of PRISM worker instances"
  type        = number
  default     = 1
}

# HERMES Worker
variable "hermes_cpu" {
  description = "CPU units for HERMES worker"
  type        = string
  default     = "512"
}

variable "hermes_memory" {
  description = "Memory for HERMES worker in MB"
  type        = string
  default     = "1024"
}

variable "hermes_desired_count" {
  description = "Number of HERMES worker instances"
  type        = number
  default     = 1
}

# SENTRY Worker
variable "sentry_cpu" {
  description = "CPU units for SENTRY worker"
  type        = string
  default     = "512"
}

variable "sentry_memory" {
  description = "Memory for SENTRY worker in MB"
  type        = string
  default     = "1024"
}

variable "sentry_desired_count" {
  description = "Number of SENTRY worker instances"
  type        = number
  default     = 1
}

# BEACON Worker
variable "beacon_cpu" {
  description = "CPU units for BEACON worker"
  type        = string
  default     = "512"
}

variable "beacon_memory" {
  description = "Memory for BEACON worker in MB"
  type        = string
  default     = "1024"
}

variable "beacon_desired_count" {
  description = "Number of BEACON worker instances"
  type        = number
  default     = 1
}

# BCAT-PLANNER Worker
variable "bcat_planner_cpu" {
  description = "CPU units for BCAT-PLANNER worker (no AI model — lightweight)"
  type        = string
  default     = "256"
}

variable "bcat_planner_memory" {
  description = "Memory for BCAT-PLANNER worker in MB"
  type        = string
  default     = "512"
}

variable "bcat_planner_desired_count" {
  description = "Number of BCAT-PLANNER worker instances"
  type        = number
  default     = 1
}

# BCAT-EXECUTOR Worker
variable "bcat_executor_cpu" {
  description = "CPU units for BCAT-EXECUTOR worker (no AI model — lightweight)"
  type        = string
  default     = "256"
}

variable "bcat_executor_memory" {
  description = "Memory for BCAT-EXECUTOR worker in MB"
  type        = string
  default     = "512"
}

variable "bcat_executor_desired_count" {
  description = "Number of BCAT-EXECUTOR worker instances"
  type        = number
  default     = 1
}

# SRLOG Worker
variable "srlog_cpu" {
  description = "CPU units for SRLOG worker (log file downloads + Claude SDK analysis)"
  type        = string
  default     = "1024"
}

variable "srlog_memory" {
  description = "Memory for SRLOG worker in MB (needs headroom for log file buffers)"
  type        = string
  default     = "2048"
}

variable "srlog_desired_count" {
  description = "Number of SRLOG worker instances"
  type        = number
  default     = 1
}

# VERITAS Worker
variable "veritas_cpu" {
  description = "CPU units for VERITAS worker (needs Claude SDK)"
  type        = string
  default     = "512"
}

variable "veritas_memory" {
  description = "Memory for VERITAS worker in MB"
  type        = string
  default     = "1024"
}

variable "veritas_desired_count" {
  description = "Number of VERITAS worker instances"
  type        = number
  default     = 1
}

variable "additional_worker_agents" {
  description = "Additional worker agents managed through governed onboarding workflows"
  type = map(object({
    cpu           = string
    memory        = string
    desired_count = number
  }))
  default = {}
}

# ============================================================================
# ONESHOT CONFIGURATION
# ============================================================================

variable "enable_oneshot" {
  description = "Enable OneShot queues, consumer services, and the QUALIFIER worker wiring"
  type        = bool
  default     = false
}

variable "oneshot_target_repo_field_id" {
  description = "Optional Jira field id/name carrying the authoritative Target Repo value for RepoRouter"
  type        = string
  default     = ""
}

variable "oneshot_description_repo_directive_mode" {
  description = "How OneShot handles explicit repository directives found in Jira descriptions: shadow logs only, select applies them, off disables them"
  type        = string
  default     = "select"

  validation {
    condition     = contains(["select", "shadow", "off"], var.oneshot_description_repo_directive_mode)
    error_message = "oneshot_description_repo_directive_mode must be one of: select, shadow, off."
  }
}

variable "oneshot_github_repo_owners" {
  description = "Comma-separated GitHub owners/orgs used when OneShot resolves explicit bare repository names from Jira descriptions"
  type        = string
  default     = "mhk-repos"
}

variable "qualifier_cpu" {
  description = "CPU units for QUALIFIER worker"
  type        = string
  default     = "512"
}

variable "qualifier_memory" {
  description = "Memory for QUALIFIER worker in MB"
  type        = string
  default     = "1024"
}

variable "qualifier_desired_count" {
  description = "Number of QUALIFIER worker instances"
  type        = number
  default     = 0
}

variable "qualifier_model_id" {
  description = "Bedrock model or inference profile ID used by the QUALIFIER worker. Leave empty to use bedrock_model_id."
  type        = string
  default     = ""
}

variable "oneshot_planner_cpu" {
  description = "CPU units for the OneShot planner service"
  type        = string
  default     = "1024"
}

variable "oneshot_planner_memory" {
  description = "Memory for the OneShot planner service in MB"
  type        = string
  default     = "2048"
}

variable "oneshot_planner_desired_count" {
  description = "Number of OneShot planner ECS tasks"
  type        = number
  default     = 0
}

variable "oneshot_reviewer_cpu" {
  description = "CPU units for the OneShot reviewer service"
  type        = string
  default     = "1024"
}

variable "oneshot_reviewer_memory" {
  description = "Memory for the OneShot reviewer service in MB"
  type        = string
  default     = "2048"
}

variable "oneshot_reviewer_desired_count" {
  description = "Number of OneShot reviewer ECS tasks"
  type        = number
  default     = 0
}

variable "oneshot_implementer_cpu" {
  description = "CPU units for the OneShot implementer service"
  type        = string
  default     = "2048"
}

variable "oneshot_implementer_memory" {
  description = "Memory for the OneShot implementer service in MB"
  type        = string
  default     = "4096"
}

variable "oneshot_implementer_desired_count" {
  description = "Number of OneShot implementer ECS tasks"
  type        = number
  default     = 0
}

variable "oneshot_code_reviewer_cpu" {
  description = "CPU units for the OneShot code reviewer service"
  type        = string
  default     = "1024"
}

variable "oneshot_code_reviewer_memory" {
  description = "Memory for the OneShot code reviewer service in MB"
  type        = string
  default     = "2048"
}

variable "oneshot_code_reviewer_desired_count" {
  description = "Number of OneShot code reviewer ECS tasks"
  type        = number
  default     = 0
}

variable "oneshot_openai_max_tool_iterations" {
  description = "Maximum OpenAI repo-tool continuation iterations for OneShot review stages"
  type        = number
  default     = 50

  validation {
    condition     = var.oneshot_openai_max_tool_iterations >= 0 && floor(var.oneshot_openai_max_tool_iterations) == var.oneshot_openai_max_tool_iterations
    error_message = "oneshot_openai_max_tool_iterations must be a non-negative integer."
  }
}

variable "oneshot_tester_cpu" {
  description = "CPU units for the OneShot tester service"
  type        = string
  default     = "2048"
}

variable "oneshot_tester_memory" {
  description = "Memory for the OneShot tester service in MB"
  type        = string
  default     = "4096"
}

variable "oneshot_tester_desired_count" {
  description = "Number of OneShot tester ECS tasks"
  type        = number
  default     = 0
}

variable "oneshot_workspace_lease_ttl_seconds" {
  description = "TTL for OneShot workspace MySQL leases; must exceed 4x the max single git command duration"
  type        = number
  default     = 2700
}

variable "oneshot_workspace_lease_heartbeat_seconds" {
  description = "Heartbeat cadence for OneShot workspace MySQL leases"
  type        = number
  default     = 30
}

variable "oneshot_repo_cache_freshness_ttl_ms" {
  description = "Maximum age for cached repo branch-head data before new run creation forces a fetch"
  type        = number
  default     = 300000
}

variable "oneshot_build_test_ephemeral_storage_gib" {
  description = "Optional Fargate ephemeral storage size in GiB for Build/Test-like OneShot tasks; null keeps AWS default"
  type        = number
  default     = null
}

variable "oneshot_workspace_local_storage_gib" {
  description = "Optional Fargate ephemeral storage size in GiB for all OneShot local worktree tasks; null keeps AWS default"
  type        = number
  default     = null
}

variable "oneshot_max_verification_loops" {
  description = "Maximum OneShot verification loops (code review + test) before escalation/failure"
  type        = number
  default     = 3
}

variable "oneshot_artifact_prefix" {
  description = "Artifact prefix used for OneShot S3 objects"
  type        = string
  default     = "oneshot"
}

variable "oneshot_image_tag" {
  description = "Image tag to deploy for the OneShot ECS services when digest pinning is disabled"
  type        = string
  default     = "latest"
}

variable "oneshot_pin_image_by_digest" {
  description = "Whether to resolve the OneShot image tag to an immutable ECR digest at deploy time"
  type        = bool
  default     = false
}

variable "worker_image_tag" {
  description = "Image tag to deploy for worker ECS services when digest pinning is disabled"
  type        = string
  default     = "latest"
}

variable "worker_pin_image_by_digest" {
  description = "Whether to resolve worker image tags to immutable ECR digests at deploy time"
  type        = bool
  default     = false
}

variable "oneshot_max_review_loops" {
  description = "Maximum OneShot review loops before escalation"
  type        = number
  default     = 3
}

variable "oneshot_review_stages_block_on_exhaustion" {
  description = "When true, Validate and Review become hard gates again after refinement/reviewer attempts are exhausted. Default false keeps them advisory soft gates."
  type        = bool
  default     = false
}

variable "oneshot_healthcare_guardrails_enabled" {
  description = "Whether OneShot planner/implementer/reviewer/code-review/tester prompt composers append healthcare guardrails."
  type        = bool
  default     = false
}

variable "oneshot_readiness_active_risk_categories" {
  description = "Comma-separated readiness risk categories that should affect PR readiness. Leave empty for observe-only classifier rollout; use all after the bake period if every category should be active."
  type        = string
  default     = ""
}

variable "oneshot_planner_model_id" {
  description = "Optional Bedrock model or inference profile ID used only by the OneShot planner. Leave empty to use bedrock_model_id/ANTHROPIC_MODEL."
  type        = string
  default     = ""
}

variable "oneshot_planner_max_output_tokens" {
  description = "Claude final-output token cap for OneShot planner calls. Does not apply to planner scout calls."
  type        = number
  default     = 100000

  validation {
    condition     = var.oneshot_planner_max_output_tokens > 0
    error_message = "oneshot_planner_max_output_tokens must be greater than zero."
  }
}

variable "oneshot_implementer_max_output_tokens" {
  description = "Claude final-output token cap for OneShot implementer calls."
  type        = number
  default     = 100000

  validation {
    condition     = var.oneshot_implementer_max_output_tokens > 0
    error_message = "oneshot_implementer_max_output_tokens must be greater than zero."
  }
}

variable "oneshot_planner_claude_permission_mode" {
  description = "Claude SDK permission mode for OneShot planner and planner scout read-only calls"
  type        = string
  default     = "default"

  validation {
    condition     = contains(["default", "acceptEdits", "bypassPermissions"], var.oneshot_planner_claude_permission_mode)
    error_message = "oneshot_planner_claude_permission_mode must be one of: default, acceptEdits, bypassPermissions."
  }
}

variable "oneshot_planner_claude_tool_visibility" {
  description = "Claude SDK tool visibility mode for OneShot planner and planner scout calls"
  type        = string
  default     = "restricted"

  validation {
    condition     = contains(["restricted", "legacyAllowedToolsOnly"], var.oneshot_planner_claude_tool_visibility)
    error_message = "oneshot_planner_claude_tool_visibility must be one of: restricted, legacyAllowedToolsOnly."
  }
}

variable "oneshot_planner_claude_tool_guard" {
  description = "Claude SDK canUseTool guard mode for OneShot planner and planner scout calls"
  type        = string
  default     = "enabled"

  validation {
    condition     = contains(["enabled", "disabledWhenRestricted"], var.oneshot_planner_claude_tool_guard)
    error_message = "oneshot_planner_claude_tool_guard must be one of: enabled, disabledWhenRestricted."
  }
}

variable "oneshot_planner_tool_sprawl_guard" {
  description = "Enable planner-only Claude SDK Read/Glob/Grep sprawl guard"
  type        = bool
  default     = true
}

variable "oneshot_planner_skills_enabled" {
  description = "Whether the OneShot planner loads the bundled Claude plugin Skills"
  type        = bool
  default     = true
}

variable "oneshot_planner_subagents_enabled" {
  description = "Whether the OneShot planner exposes SDK-native read-only subagents"
  type        = bool
  default     = true
}

variable "oneshot_planner_subagent_max_turns" {
  description = "Maximum Claude SDK turns for each OneShot planner SDK-native subagent"
  type        = number
  default     = 16

  validation {
    condition     = var.oneshot_planner_subagent_max_turns > 0
    error_message = "oneshot_planner_subagent_max_turns must be positive."
  }
}

variable "oneshot_planner_plugin_path" {
  description = "Optional local planner Claude plugin path. Leave empty to use the bundled OneShot planner plugin."
  type        = string
  default     = ""
}

variable "oneshot_planner_scout_enabled" {
  description = "Whether the OneShot planner runs the default-on LLM workplan and read-only Haiku harness scout pass"
  type        = bool
  default     = true
}

variable "oneshot_planner_scout_model_id" {
  description = "Bedrock model or inference profile ID used by OneShot planner scout fallback calls"
  type        = string
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "oneshot_planner_max_repo_tool_calls" {
  description = "Maximum planner Read/Glob/Grep repo-inspection tool calls before forcing structured plan output"
  type        = number
  default     = 18

  validation {
    condition     = var.oneshot_planner_max_repo_tool_calls > 0
    error_message = "oneshot_planner_max_repo_tool_calls must be positive."
  }
}

variable "oneshot_planner_max_turns" {
  description = "Maximum Claude SDK turns for OneShot planner attempts"
  type        = number
  default     = 40

  validation {
    condition     = var.oneshot_planner_max_turns > 0
    error_message = "oneshot_planner_max_turns must be positive."
  }
}

variable "oneshot_implementer_max_turns" {
  description = "Maximum Claude SDK turns for OneShot implementation attempts"
  type        = number
  default     = 180

  validation {
    condition     = var.oneshot_implementer_max_turns > 0
    error_message = "oneshot_implementer_max_turns must be positive."
  }
}

variable "oneshot_implementer_model_id" {
  description = "Bedrock model or inference profile ID used by OneShot implementation attempts"
  type        = string
  default     = "us.anthropic.claude-sonnet-5"

  validation {
    condition     = trimspace(var.oneshot_implementer_model_id) != ""
    error_message = "oneshot_implementer_model_id must not be empty."
  }
}

variable "oneshot_claude_code_max_output_tokens" {
  description = "Global Claude Code SDK output token cap for OneShot Anthropic stages"
  type        = number
  default     = 50000

  validation {
    condition     = var.oneshot_claude_code_max_output_tokens > 0
    error_message = "oneshot_claude_code_max_output_tokens must be positive."
  }
}

variable "oneshot_max_thinking_tokens" {
  description = "Global Claude Code SDK thinking token budget for OneShot Anthropic stages"
  type        = number
  default     = 2048

  validation {
    condition     = var.oneshot_max_thinking_tokens > 0
    error_message = "oneshot_max_thinking_tokens must be positive."
  }
}

variable "oneshot_reviewer_enabled" {
  description = "Whether the OneShot reviewer actively reviews plans or auto-approves them"
  type        = bool
  default     = true
}

variable "oneshot_reviewer_bypass_reason" {
  description = "Reason logged when the OneShot reviewer is disabled in production"
  type        = string
  default     = ""
}

variable "oneshot_code_reviewer_enabled" {
  description = "Whether the OneShot code reviewer actively reviews implementations or auto-approves them"
  type        = bool
  default     = true
}

variable "oneshot_trace_enabled" {
  description = "Whether OneShot planning generates TRACE test-case artifacts before plan review"
  type        = bool
  default     = true
}

variable "oneshot_docs_synthesis_enabled" {
  description = "Whether OneShot documentation generation uses LLM synthesis (with structural evidence validation and human-review fallback) instead of the deterministic assembler. Staged rollout: default off; set true to enable in an environment after validating output quality."
  type        = bool
  default     = false
}

variable "oneshot_trace_post_to_jira" {
  description = "Whether OneShot planning posts TRACE CSV attachment/comment output back to Jira"
  type        = bool
  default     = true
}

variable "oneshot_implementation_plan_post_to_jira" {
  description = "Whether OneShot posts the reviewed implementation plan back to Jira when implementation is queued"
  type        = bool
  default     = true
}

variable "oneshot_verify_enabled" {
  description = "Whether OneShot planning reviews TRACE output with VERIFY before plan review"
  type        = bool
  default     = true
}

variable "oneshot_verify_mode" {
  description = "VERIFY scoring profile for OneShot TRACE review"
  type        = string
  default     = "balanced"

  validation {
    condition     = contains(["balanced", "strict", "lenient"], var.oneshot_verify_mode)
    error_message = "oneshot_verify_mode must be one of: balanced, strict, lenient."
  }
}

variable "oneshot_code_reviewer_bypass_reason" {
  description = "Reason logged when the OneShot code reviewer is disabled in production"
  type        = string
  default     = ""
}

variable "oneshot_reviewer_provider" {
  description = "LLM provider used by the OneShot plan reviewer ('openai' for gpt-5.4, 'anthropic' for a Bedrock Claude model)"
  type        = string
  default     = "openai"
  validation {
    condition     = contains(["openai", "anthropic"], var.oneshot_reviewer_provider)
    error_message = "oneshot_reviewer_provider must be 'openai' or 'anthropic'."
  }
}

variable "oneshot_reviewer_model_id" {
  description = "Bedrock inference profile ID when oneshot_reviewer_provider='anthropic' (e.g. us.anthropic.claude-opus-4-6-v1). Ignored for 'openai'."
  type        = string
  default     = ""
}

variable "oneshot_code_reviewer_provider" {
  description = "LLM provider used by the OneShot code reviewer ('openai' for gpt-5.4, 'anthropic' for a Bedrock Claude model)"
  type        = string
  default     = "openai"
  validation {
    condition     = contains(["openai", "anthropic"], var.oneshot_code_reviewer_provider)
    error_message = "oneshot_code_reviewer_provider must be 'openai' or 'anthropic'."
  }
}

variable "oneshot_code_reviewer_model_id" {
  description = "Bedrock inference profile ID when oneshot_code_reviewer_provider='anthropic' (e.g. us.anthropic.claude-opus-4-6-v1). Ignored for 'openai'."
  type        = string
  default     = ""
}

variable "oneshot_max_total_tokens" {
  description = "Maximum cumulative runaway token budget per OneShot run"
  type        = number
  default     = 50000000
}

variable "oneshot_max_stage_tokens_planning" {
  description = "Maximum token budget per OneShot planning stage version"
  type        = number
  default     = 4000000
}

variable "oneshot_max_stage_tokens_review" {
  description = "Maximum token budget per OneShot review stage version"
  type        = number
  default     = 2000000
}

variable "oneshot_max_stage_tokens_implementation" {
  description = "Maximum token budget per OneShot implementation stage version"
  type        = number
  default     = 4000000
}

variable "oneshot_max_stage_tokens_code_review" {
  description = "Maximum token budget per OneShot code review stage version"
  type        = number
  default     = 2000000
}

variable "oneshot_max_stage_tokens_testing" {
  description = "Maximum token budget per OneShot testing stage version"
  type        = number
  default     = 2000000
}

variable "oneshot_reconcile_stale_minutes" {
  description = "How long queued OneShot runs can remain stale before reconciliation should republish them"
  type        = number
  default     = 10
}

variable "oneshot_otel_enabled" {
  description = "Enable OpenTelemetry tracing and metrics for OneShot consumers"
  type        = bool
  default     = true
}

variable "oneshot_otel_exporter_endpoint" {
  description = "OTLP HTTP endpoint for traces and metrics (e.g., http://localhost:4318 for a sidecar collector)"
  type        = string
  default     = "http://localhost:4318"
}

variable "oneshot_otel_sidecar_image" {
  description = "Container image for the ECS OTLP sidecar used by OneShot and QUALIFIER telemetry"
  type        = string
  default     = "public.ecr.aws/cloudwatch-agent/cloudwatch-agent:latest"
}

variable "oneshot_otel_metrics_namespace" {
  description = "CloudWatch namespace used for OneShot OpenTelemetry metrics"
  type        = string
  default     = "Specter/OneShot"
}

variable "oneshot_queue_age_alarm_threshold_seconds" {
  description = "Alarm threshold for the age of the oldest visible OneShot queue message"
  type        = number
  default     = 900
}

variable "oneshot_queue_depth_alarm_threshold" {
  description = "Alarm threshold for visible messages on a OneShot primary queue"
  type        = number
  default     = 10
}

variable "oneshot_consumer_cpu_alarm_threshold" {
  description = "CPU utilization percentage that triggers consumer health alarm (sustained 10 min)"
  type        = number
  default     = 80
}

variable "oneshot_consumer_memory_alarm_threshold" {
  description = "Memory utilization percentage that triggers consumer health alarm (sustained 10 min)"
  type        = number
  default     = 85
}

variable "oneshot_alarm_topic_arn" {
  description = "Optional SNS topic ARN for OneShot CloudWatch alarm actions"
  type        = string
  default     = ""
}

variable "enable_sdk_stall_alarms" {
  description = "Create CloudWatch metric filters + alarms for Claude SDK stall/timeout log events ([SDK_TIMEOUT], [SDK_STALLED_NO_TOOLS], [SDK_STALLED_POST_TOOLS], [SDK_IDLE_ABORT]) across all agent log groups. Alarms route to the oneshot_alerts SNS topic (Teams)."
  type        = bool
  default     = true
}

variable "oneshot_autoscaling_max_capacity" {
  description = "Per-stage maximum task count for oneshot consumer auto-scaling (keys: planner, reviewer, implementer, code_reviewer, tester)"
  type        = map(number)
  default = {
    planner       = 5
    reviewer      = 5
    implementer   = 5
    code_reviewer = 5
    tester        = 5
  }
}

variable "oneshot_prompt_source" {
  description = "Prompt source for OneShot consumers: local or s3"
  type        = string
  default     = "local"
  validation {
    condition     = contains(["local", "s3"], var.oneshot_prompt_source)
    error_message = "oneshot_prompt_source must be either \"local\" or \"s3\"."
  }
}

variable "oneshot_prompt_bucket" {
  description = "Optional S3 bucket for OneShot prompts when oneshot_prompt_source = s3"
  type        = string
  default     = ""
}

variable "oneshot_prompt_manifest_key" {
  description = "Manifest key for OneShot prompts when oneshot_prompt_source = s3"
  type        = string
  default     = "oneshot/manifest.json"
}

variable "oneshot_prompt_manifest_version_id" {
  description = "Exact S3 VersionId for the OneShot prompt manifest when oneshot_prompt_source = s3"
  type        = string
  default     = ""
}

variable "oneshot_comment_asset_base_url" {
  description = "Public base URL used to build external OneShot Jira comment asset links such as the hosted logo image"
  type        = string
  default     = ""
}

variable "oneshot_dashboard_base_url" {
  description = "Public base URL used to build deep links back to the OneShot dashboard run view"
  type        = string
  default     = ""
}

# ============================================================================
# HARVEY CONFIGURATION
# ============================================================================

variable "harvey_cpu" {
  description = "CPU units for Harvey (512 — lightweight, just LLM API calls)"
  type        = string
  default     = "512"
}

variable "harvey_memory" {
  description = "Memory for Harvey in MB"
  type        = string
  default     = "1024"
}

variable "harvey_desired_count" {
  description = "Number of Harvey instances (1 is safe — atomic claim design)"
  type        = number
  default     = 1
}

variable "harvey_teams_secret_name" {
  description = "Secrets Manager secret name containing Teams Bot credentials (app_id, app_password)"
  type        = string
}

variable "harvey_result_poll_interval_ms" {
  description = "Harvey result delivery poll interval in milliseconds"
  type        = number
  default     = 15000
}

variable "harvey_certificate_arn" {
  description = "ACM certificate ARN for HTTPS on Harvey ALB (required by Bot Framework)"
  type        = string
  # No default — must be provided. Bot Framework requires HTTPS.
}

variable "harvey_alb_subnet_ids" {
  description = "Public subnet IDs for the Harvey ALB (must be public for Bot Framework callbacks)"
  type        = list(string)
  # Defaults to same subnets as ECS tasks; override with public subnets if different.
  default = []
}

# Dashboard
variable "dashboard_cpu" {
  description = "CPU units for dashboard (256, 512, 1024)"
  type        = string
  default     = "512"
}

variable "dashboard_memory" {
  description = "Memory (MB) for dashboard"
  type        = string
  default     = "1024"
}

variable "dashboard_desired_count" {
  description = "Number of dashboard ECS tasks"
  type        = number
  default     = 1
}

variable "oneshot_statistics_llm_model_id" {
  description = "Bedrock model or inference profile ID used by the OneShot Statistics tab LLM summary. Leave empty to use bedrock_model_id."
  type        = string
  default     = ""
}

variable "oneshot_multi_repo_enabled" {
  description = "Enable multi-repo splitting in the QUALIFIER worker. When true, QUALIFIER can propose multi_repo repoSelection and create per-repo child runs under a shared run group."
  type        = bool
  default     = true
}

variable "dashboard_allowed_cidr_blocks" {
  description = "CIDR blocks allowed to reach the dashboard ALB on HTTP/HTTPS"
  type        = list(string)
  default = [
    "172.22.0.0/16",
    "172.109.133.2/32",
    "172.29.0.0/16",
    "3.228.81.40/32",
    "104.226.237.202/32",
    "198.19.0.0/16",
    "97.76.206.30/32",
  ]

  validation {
    condition = length(var.dashboard_allowed_cidr_blocks) > 0 && alltrue([
      for cidr in var.dashboard_allowed_cidr_blocks : can(cidrhost(cidr, 0))
    ])
    error_message = "dashboard_allowed_cidr_blocks must contain at least one valid CIDR block."
  }
}

variable "dashboard_https_extra_cidr_blocks" {
  description = "Additional CIDR blocks allowed to reach the dashboard ALB on HTTPS only"
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.dashboard_https_extra_cidr_blocks : can(cidrhost(cidr, 0))
    ])
    error_message = "dashboard_https_extra_cidr_blocks must contain valid CIDR blocks."
  }
}

variable "dashboard_offshore_workstation_cidr_blocks" {
  description = "Offshore workstation CIDR blocks allowed to reach the dashboard ALB on HTTPS only"
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.dashboard_offshore_workstation_cidr_blocks : can(cidrhost(cidr, 0))
    ])
    error_message = "dashboard_offshore_workstation_cidr_blocks must contain valid CIDR blocks."
  }
}

variable "dashboard_operator_id_header" {
  description = "Trusted upstream header name carrying the authenticated operator identifier for dashboard write actions"
  type        = string
  default     = "x-amzn-oidc-identity"
}

variable "dashboard_operator_name_header" {
  description = "Trusted upstream header name carrying the authenticated operator display name for dashboard write actions"
  type        = string
  default     = "x-amzn-oidc-identity"
}

variable "dashboard_coreapp_preview_url" {
  description = "URL of the shared single-slot core-app preview environment shown on the OneShot dashboard"
  type        = string
  default     = "https://client-a-cp-dev-mhk-core.mhkdevsandbox.com/medhok/"
}

variable "dashboard_enable_cognito_auth" {
  description = "Enable Cognito authentication on the dashboard ALB HTTPS listener"
  type        = bool
  default     = false
}

variable "dashboard_cognito_user_pool_arn" {
  description = "Cognito User Pool ARN for dashboard ALB authentication"
  type        = string
  default     = null
}

variable "dashboard_cognito_user_pool_client_id" {
  description = "Cognito User Pool App Client ID for dashboard ALB authentication"
  type        = string
  default     = null
}

variable "dashboard_cognito_user_pool_domain" {
  description = "Cognito hosted UI domain prefix for dashboard ALB authentication"
  type        = string
  default     = null
}

variable "enable_spec_factory" {
  description = "Enable Spec Factory ECS service and Dashboard ALB path routing"
  type        = bool
  default     = false
}

variable "spec_factory_cpu" {
  description = "CPU units for the Spec Factory task (shared by the Node app + markitdown/ffmpeg sidecar). 1024 gives ffmpeg enough to transcode media without starving the app."
  type        = string
  default     = "1024"
}

variable "spec_factory_memory" {
  description = "Total task memory (MB), shared by the Node app + the markitdown sidecar. Must exceed app reservation + sidecar hard cap. The sidecar holds the full media upload + base64 segments in RAM, so 1024 OOM-killed the whole task on large media."
  type        = string
  default     = "3072"
}

variable "spec_factory_app_memory_reservation" {
  description = "Soft memory floor (MB) reserved for the essential Node app container so the sidecar cannot starve it."
  type        = number
  default     = 768
}

variable "compose_markitdown_memory" {
  description = "Hard memory cap (MB) for the non-essential markitdown/ffmpeg sidecar. On overrun ECS OOM-kills ONLY the sidecar (the task + app survive; conversion is marked failed and retried) instead of taking down the whole task. Worst-case sidecar peak is ~upload + ~1.33x base64; keep this above it."
  type        = number
  default     = 1024
}

variable "spec_factory_ephemeral_storage_gib" {
  description = "Fargate ephemeral storage size in GiB for Spec Factory local repo worktrees"
  type        = number
  default     = 80

  validation {
    condition     = var.spec_factory_ephemeral_storage_gib >= 21 && var.spec_factory_ephemeral_storage_gib <= 200
    error_message = "spec_factory_ephemeral_storage_gib must be between 21 and 200."
  }
}

variable "spec_factory_desired_count" {
  description = "Desired Spec Factory API task count. Keep at one until shared event fanout is enabled; the v4 rollout raises this after Valkey certification."
  type        = number
  default     = 0
}

variable "spec_factory_runtime_subnet_ids" {
  description = "Subnets used only by Spec Factory API and worker tasks. Empty falls back to subnet_ids. Horizontal scaling requires public subnets in the configured VPC across at least two availability zones until the private-runtime network migration lands."
  type        = list(string)
  default     = []
}

variable "spec_factory_additional_efs_mount_target_subnet_ids" {
  description = "Spec Factory runtime subnets whose availability zones need Terraform-managed mount targets for the existing shared EFS filesystem. Do not include an availability zone that already has an EFS mount target."
  type        = list(string)
  default     = []
}

variable "spec_factory_log_retention_days" {
  description = "CloudWatch Logs retention for Spec Factory. Security policy requires at least one year."
  type        = number
  default     = 365

  validation {
    condition = contains([
      365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653
    ], var.spec_factory_log_retention_days)
    error_message = "spec_factory_log_retention_days must be a CloudWatch-supported retention value of at least 365 days."
  }
}

variable "spec_factory_workflow_state_rate_limit_max" {
  description = "Maximum workflow-state reads per actor and session in each 60-second window on one API replica."
  type        = number
  default     = 120

  validation {
    condition     = var.spec_factory_workflow_state_rate_limit_max > 0 && floor(var.spec_factory_workflow_state_rate_limit_max) == var.spec_factory_workflow_state_rate_limit_max
    error_message = "spec_factory_workflow_state_rate_limit_max must be a positive integer."
  }
}

variable "spec_factory_outbox_enabled" {
  description = "Run the Spec Factory transactional outbox relay. Keep false until migration 070 is applied."
  type        = bool
  default     = false
}

variable "spec_factory_artifact_store" {
  description = "Authoritative Spec Factory artifact store. s3 uses immutable content-addressed objects; efs is rollback-only."
  type        = string
  default     = "efs"

  validation {
    condition     = contains(["s3", "efs"], var.spec_factory_artifact_store)
    error_message = "spec_factory_artifact_store must be s3 or efs."
  }
}

variable "spec_factory_queue_dispatch_mode" {
  description = "Spec Factory SQS dispatch mode: shadow validates envelopes without side effects; primary executes consumers."
  type        = string
  default     = "shadow"

  validation {
    condition     = contains(["shadow", "primary"], var.spec_factory_queue_dispatch_mode)
    error_message = "spec_factory_queue_dispatch_mode must be shadow or primary."
  }
}

variable "spec_factory_worker_desired_count" {
  description = "Desired count for the optional Spec Factory worker-mode ECS service. Defaults to 0 until durable turns/agent tasks are ready for split-mode rollout."
  type        = number
  default     = 0
}

variable "spec_factory_turn_worker_desired_count" {
  description = "Desired count for dedicated durable turn workers."
  type        = number
  default     = 0
}

variable "spec_factory_context_worker_desired_count" {
  description = "Desired count for source-distillation and context-merge workers."
  type        = number
  default     = 0
}

variable "spec_factory_draft_worker_desired_count" {
  description = "Desired count for durable draft-stage, approval, Jira-publish, and OneShot-submit workers."
  type        = number
  default     = 0
}

variable "spec_factory_relay_worker_desired_count" {
  description = "Desired count for transactional outbox relay workers."
  type        = number
  default     = 0
}

variable "spec_factory_retention_worker_desired_count" {
  description = "Desired count for retention, repair, and artifact-GC workers."
  type        = number
  default     = 0
}

variable "spec_factory_research_worker_desired_count" {
  description = "Desired count for the optional Spec Factory research-worker ECS service. Defaults to 0; enable only with SPEC_FACTORY_RESEARCH_EXECUTOR and workspace manager rollout gates."
  type        = number
  default     = 0
}

variable "spec_factory_conversion_worker_desired_count" {
  description = "Desired count for the optional Spec Factory conversion-worker ECS service. Defaults to 0; this role includes the compose-markitdown sidecar."
  type        = number
  default     = 0
}

variable "spec_factory_single_replica_alarm_enabled" {
  description = "Rollback-only alarm for the legacy single-replica topology. Disable after canonical Valkey fanout and DB tokens are enabled."
  type        = bool
  default     = false
}

variable "spec_factory_autoscaling_enabled" {
  description = "Enable ECS Application Auto Scaling for the API and queue-backed worker services."
  type        = bool
  default     = false
}

variable "spec_factory_api_max_count" {
  type        = number
  description = "Maximum number of Spec Factory API tasks."
  default     = 30
}

variable "spec_factory_api_requests_per_target" {
  type        = number
  description = "ALB requests per minute per Spec Factory API task used by target-tracking autoscaling."
  default     = 300

  validation {
    condition     = var.spec_factory_api_requests_per_target > 0
    error_message = "spec_factory_api_requests_per_target must be positive."
  }
}

variable "spec_factory_ecs_task_protection_enabled" {
  type        = bool
  description = "Use the ECS agent endpoint to protect queue workers while an acquired SQS receipt is executing."
  default     = false
}

variable "spec_factory_ecs_task_protection_expires_minutes" {
  type        = number
  description = "ECS task scale-in protection lifetime. Active workers renew it before expiry."
  default     = 30

  validation {
    condition = (
      var.spec_factory_ecs_task_protection_expires_minutes >= 1 &&
      var.spec_factory_ecs_task_protection_expires_minutes <= 2880
    )
    error_message = "spec_factory_ecs_task_protection_expires_minutes must be from 1 to 2880."
  }
}

variable "spec_factory_ecs_task_protection_refresh_ms" {
  type        = number
  description = "Refresh interval for active ECS task scale-in protection."
  default     = 300000

  validation {
    condition     = var.spec_factory_ecs_task_protection_refresh_ms >= 10000
    error_message = "spec_factory_ecs_task_protection_refresh_ms must be at least 10000."
  }
}

variable "spec_factory_ecs_task_protection_request_timeout_ms" {
  type        = number
  description = "Timeout for an ECS agent task-protection request."
  default     = 3000

  validation {
    condition = (
      var.spec_factory_ecs_task_protection_request_timeout_ms >= 100 &&
      var.spec_factory_ecs_task_protection_request_timeout_ms <= 30000
    )
    error_message = "spec_factory_ecs_task_protection_request_timeout_ms must be from 100 to 30000."
  }
}

variable "spec_factory_worker_scale_in_enabled" {
  type        = bool
  description = "Allow queue-backlog target tracking to scale workers in. Requires ECS task protection."
  default     = false
}

variable "spec_factory_worker_max_counts" {
  description = "Maximum ECS task count by split Spec Factory runtime mode."
  type        = map(number)
  default = {
    worker            = 10
    turn-worker       = 100
    context-worker    = 100
    research-worker   = 50
    conversion-worker = 30
    draft-worker      = 40
    relay-worker      = 8
    retention-worker  = 2
  }
}

variable "spec_factory_target_backlog_per_task" {
  description = "Target visible SQS messages per ECS worker task by runtime mode."
  type        = map(number)
  default = {
    turn-worker       = 4
    context-worker    = 2
    research-worker   = 1
    conversion-worker = 1
    draft-worker      = 1
    relay-worker      = 8
  }
}

variable "spec_factory_data_subnet_ids" {
  description = "Private subnets in at least two availability zones for Spec Factory Valkey, RDS Proxy, and optional Aurora. Empty falls back to subnet_ids and must still pass the data-plane subnet checks."
  type        = list(string)
  default     = []
}

variable "spec_factory_valkey_enabled" {
  description = "Provision a Multi-AZ Valkey replication group for low-latency canonical event fanout."
  type        = bool
  default     = false
}

variable "spec_factory_valkey_node_type" {
  type        = string
  description = "ElastiCache node type for Spec Factory Valkey fanout."
  default     = "cache.r7g.large"
}

variable "spec_factory_rds_proxy_enabled" {
  description = "Provision and route Spec Factory through RDS Proxy. Requires an existing DB instance identifier or the optional Aurora cluster."
  type        = bool
  default     = false
}

variable "spec_factory_rds_direct_fallback_enabled" {
  description = "Keep the existing direct-RDS task security-group path during the RDS Proxy canary so ECS can roll back to the previous task definition. Disable only after proxy certification."
  type        = bool
  default     = true
}

variable "spec_factory_db_secret_kms_key_arn" {
  description = "Optional customer-managed KMS key ARN for the DB secret used by RDS Proxy. Empty means no explicit kms:Decrypt grant."
  type        = string
  default     = ""
}

variable "spec_factory_rds_proxy_db_instance_identifier" {
  description = "Existing RDS DB instance identifier registered behind the optional Spec Factory RDS Proxy."
  type        = string
  default     = ""
}

variable "spec_factory_aurora_enabled" {
  description = "Provision a dedicated Multi-AZ Aurora MySQL cluster for a separately approved migration."
  type        = bool
  default     = false
}

variable "spec_factory_aurora_instance_class" {
  type        = string
  description = "Aurora writer/reader instance class."
  default     = "db.r7g.large"
}

variable "spec_factory_aurora_instance_count" {
  type        = number
  description = "Aurora instance count including writer."
  default     = 2
}

variable "spec_factory_image_tag" {
  description = "Immutable source commit tag used to resolve Spec Factory image digests."
  type        = string
  default     = "latest"
}

variable "spec_factory_pin_image_by_digest" {
  description = "Resolve role-specific ECR tags at plan time and pin ECS task definitions to their sha256 digests."
  type        = bool
  default     = false
}

variable "spec_factory_legacy_runtime" {
  description = "Legacy runtime gate. Set disabled only after certification and with digest-pinned images, SQS primary dispatch, and S3 artifacts."
  type        = string
  default     = "enabled"

  validation {
    condition     = contains(["enabled", "disabled"], var.spec_factory_legacy_runtime)
    error_message = "spec_factory_legacy_runtime must be enabled or disabled."
  }
}

variable "spec_factory_certification_id" {
  description = "Accepted Work Order T certification id (sfv4-<sha256>). Required before disabling the legacy runtime."
  type        = string
  default     = ""

  validation {
    condition     = var.spec_factory_certification_id == "" || can(regex("^sfv4-[a-f0-9]{64}$", var.spec_factory_certification_id))
    error_message = "spec_factory_certification_id must be empty or sfv4- followed by a 64-character lowercase SHA-256 digest."
  }
}

variable "spec_factory_context_v4_repair_run_id" {
  description = "Accepted, error-free context_rebuild_v4 repair run id required before legacy removal."
  type        = number
  default     = 0
}

variable "spec_factory_sqs_heartbeat_seconds" {
  description = "How often active Spec Factory SQS consumers extend message visibility."
  type        = number
  default     = 60
}

variable "spec_factory_outbox_retention_days" {
  description = "Retention for published/dead outbox rows after recovery evidence is no longer needed."
  type        = number
  default     = 14
}

variable "spec_factory_queue_receipt_retention_days" {
  description = "Retention for completed/failed SQS receipt-fence rows."
  type        = number
  default     = 7
}

variable "spec_factory_repair_reconcile_limit" {
  description = "Maximum context-v4 repair items reconciled per retention sweep."
  type        = number
  default     = 100
}

variable "spec_factory_immutable_artifact_orphan_grace_hours" {
  description = "Minimum age before an unreferenced immutable artifact can be deleted as a crash orphan."
  type        = number
  default     = 24
}

variable "spec_factory_immutable_artifact_gc_limit" {
  description = "Maximum immutable S3 objects inspected per retention sweep."
  type        = number
  default     = 5000
}

variable "spec_factory_draft_workflow_v2_enabled" {
  description = "Enable durable draft workflow stage runs after migrations 071-072 are applied."
  type        = bool
  default     = false
}

variable "spec_factory_draft_workflow_concurrency" {
  description = "Concurrent durable draft stages per draft-worker task."
  type        = number
  default     = 2
}

variable "spec_factory_worker_health_alarm_enabled" {
  description = "When true, provisions per-role running-task health alarms for optional split-mode Spec Factory worker services whose desired count is greater than 0."
  type        = bool
  default     = true
}

variable "spec_factory_alarm_topic_arn" {
  description = "Optional SNS topic ARN for Spec Factory CloudWatch alarm actions. Empty falls back to the shared OneShot alarm actions."
  type        = string
  default     = ""
}

variable "spec_factory_otel_enabled" {
  description = "Enable OpenTelemetry metrics and traces for every Spec Factory API and worker task via a CloudWatch Agent sidecar."
  type        = bool
  default     = true
}

variable "spec_factory_otel_sidecar_image" {
  description = "CloudWatch Agent image used as the Spec Factory OTLP sidecar."
  type        = string
  default     = "public.ecr.aws/cloudwatch-agent/cloudwatch-agent:latest"
}

variable "spec_factory_otel_sidecar_memory" {
  description = "Hard memory cap in MB for the non-essential Spec Factory CloudWatch Agent sidecar."
  type        = number
  default     = 256

  validation {
    condition     = var.spec_factory_otel_sidecar_memory >= 128
    error_message = "spec_factory_otel_sidecar_memory must be at least the 128 MB soft reservation."
  }
}

variable "spec_factory_otel_metrics_namespace" {
  description = "CloudWatch custom-metric namespace for Spec Factory OpenTelemetry metrics."
  type        = string
  default     = "Specter/SpecFactory"
}

variable "spec_factory_latency_alarms_enabled" {
  description = "Provision percentile alarms for Spec Factory queue, coordinator, and provider SLO streams."
  type        = bool
  default     = true
}

variable "spec_factory_turn_queue_p95_alarm_threshold_ms" {
  description = "Interactive durable-turn queue p95 alarm threshold in milliseconds."
  type        = number
  default     = 5000
}

variable "spec_factory_draft_queue_p95_alarm_threshold_ms" {
  description = "Draft-generation queue p95 alarm threshold in milliseconds."
  type        = number
  default     = 15000
}

variable "spec_factory_coordinator_p95_alarm_threshold_ms" {
  description = "Chat coordinator decision p95 alarm threshold in milliseconds."
  type        = number
  default     = 10000
}

variable "spec_factory_provider_p95_alarm_threshold_ms" {
  description = "LLM provider call p95 alarm threshold in milliseconds."
  type        = number
  default     = 30000
}

variable "spec_factory_durable_turns" {
  description = "SPEC_FACTORY_DURABLE_TURNS runtime selector for Spec Factory. Keep off until the durable-turn rollout reaches shadow/drain/on."
  type        = string
  default     = "off"

  validation {
    condition     = contains(["off", "shadow", "drain", "on"], var.spec_factory_durable_turns)
    error_message = "spec_factory_durable_turns must be one of: off, shadow, drain, on."
  }
}

variable "spec_factory_durable_events_required" {
  description = "Require a durable compose_session_events id before live fanout of original SSE frames. False keeps the shipped best-effort durable store behavior."
  type        = bool
  default     = false
}

variable "spec_factory_sse_durable_poll_ms" {
  description = "API-side durable SSE event polling interval in milliseconds for cross-replica replay-to-live bridging."
  type        = string
  default     = "1000"

  validation {
    condition     = trimspace(var.spec_factory_sse_durable_poll_ms) != "" && can(tonumber(var.spec_factory_sse_durable_poll_ms)) && tonumber(var.spec_factory_sse_durable_poll_ms) > 0 && floor(tonumber(var.spec_factory_sse_durable_poll_ms)) == tonumber(var.spec_factory_sse_durable_poll_ms)
    error_message = "spec_factory_sse_durable_poll_ms must be a positive integer."
  }
}

variable "spec_factory_worker_heartbeat_enabled" {
  description = "Opt the primary all-local Spec Factory process into spec_factory_worker_heartbeats writes. Split worker modes always heartbeat regardless of this value."
  type        = bool
  default     = false
}

variable "spec_factory_worker_heartbeat_ms" {
  description = "Worker heartbeat interval in milliseconds for spec_factory_worker_heartbeats writes."
  type        = string
  default     = "15000"

  validation {
    condition     = trimspace(var.spec_factory_worker_heartbeat_ms) != "" && can(tonumber(var.spec_factory_worker_heartbeat_ms)) && tonumber(var.spec_factory_worker_heartbeat_ms) > 0 && floor(tonumber(var.spec_factory_worker_heartbeat_ms)) == tonumber(var.spec_factory_worker_heartbeat_ms)
    error_message = "spec_factory_worker_heartbeat_ms must be a positive integer."
  }
}

variable "spec_factory_processor_poll_ms" {
  description = "Spec Factory Louise-board processor poll interval in milliseconds."
  type        = string
  default     = "5000"

  validation {
    condition     = trimspace(var.spec_factory_processor_poll_ms) != "" && can(tonumber(var.spec_factory_processor_poll_ms)) && tonumber(var.spec_factory_processor_poll_ms) > 0 && floor(tonumber(var.spec_factory_processor_poll_ms)) == tonumber(var.spec_factory_processor_poll_ms)
    error_message = "spec_factory_processor_poll_ms must be a positive integer."
  }
}

variable "spec_factory_turn_lease_ms" {
  description = "Durable turn worker lease TTL in milliseconds."
  type        = string
  default     = "300000"

  validation {
    condition     = trimspace(var.spec_factory_turn_lease_ms) != "" && can(tonumber(var.spec_factory_turn_lease_ms)) && tonumber(var.spec_factory_turn_lease_ms) > 0 && floor(tonumber(var.spec_factory_turn_lease_ms)) == tonumber(var.spec_factory_turn_lease_ms)
    error_message = "spec_factory_turn_lease_ms must be a positive integer."
  }
}

variable "spec_factory_turn_lease_heartbeat_ms" {
  description = "Optional durable turn lease heartbeat interval in milliseconds. Empty uses the service default of half the turn lease."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_turn_lease_heartbeat_ms) == "" || try(tonumber(var.spec_factory_turn_lease_heartbeat_ms) > 0 && floor(tonumber(var.spec_factory_turn_lease_heartbeat_ms)) == tonumber(var.spec_factory_turn_lease_heartbeat_ms), false)
    error_message = "spec_factory_turn_lease_heartbeat_ms must be empty or a positive integer."
  }
}

variable "spec_factory_turn_worker_batch_size" {
  description = "Maximum durable turn jobs a turn worker drains per poll."
  type        = string
  default     = "25"

  validation {
    condition     = trimspace(var.spec_factory_turn_worker_batch_size) != "" && can(tonumber(var.spec_factory_turn_worker_batch_size)) && tonumber(var.spec_factory_turn_worker_batch_size) > 0 && floor(tonumber(var.spec_factory_turn_worker_batch_size)) == tonumber(var.spec_factory_turn_worker_batch_size)
    error_message = "spec_factory_turn_worker_batch_size must be a positive integer."
  }
}

variable "spec_factory_turn_worker_concurrency" {
  description = "Maximum number of distinct-session turns executed concurrently per turn worker."
  type        = string
  default     = "8"

  validation {
    condition     = trimspace(var.spec_factory_turn_worker_concurrency) != "" && can(tonumber(var.spec_factory_turn_worker_concurrency)) && tonumber(var.spec_factory_turn_worker_concurrency) > 0 && floor(tonumber(var.spec_factory_turn_worker_concurrency)) == tonumber(var.spec_factory_turn_worker_concurrency)
    error_message = "spec_factory_turn_worker_concurrency must be a positive integer."
  }
}

variable "spec_factory_turn_worker_poll_ms" {
  description = "Durable turn worker drain poll interval in milliseconds."
  type        = string
  default     = "1000"

  validation {
    condition     = trimspace(var.spec_factory_turn_worker_poll_ms) != "" && can(tonumber(var.spec_factory_turn_worker_poll_ms)) && tonumber(var.spec_factory_turn_worker_poll_ms) > 0 && floor(tonumber(var.spec_factory_turn_worker_poll_ms)) == tonumber(var.spec_factory_turn_worker_poll_ms)
    error_message = "spec_factory_turn_worker_poll_ms must be a positive integer."
  }
}

variable "spec_factory_turn_lease_recovery_limit" {
  description = "Maximum expired durable turn leases recovered per worker drain."
  type        = string
  default     = "100"

  validation {
    condition     = trimspace(var.spec_factory_turn_lease_recovery_limit) != "" && can(tonumber(var.spec_factory_turn_lease_recovery_limit)) && tonumber(var.spec_factory_turn_lease_recovery_limit) > 0 && floor(tonumber(var.spec_factory_turn_lease_recovery_limit)) == tonumber(var.spec_factory_turn_lease_recovery_limit)
    error_message = "spec_factory_turn_lease_recovery_limit must be a positive integer."
  }
}

variable "spec_factory_turn_clarification_expiry_limit" {
  description = "Maximum expired awaiting_user_input durable turns abandoned per worker drain."
  type        = string
  default     = "100"

  validation {
    condition     = trimspace(var.spec_factory_turn_clarification_expiry_limit) != "" && can(tonumber(var.spec_factory_turn_clarification_expiry_limit)) && tonumber(var.spec_factory_turn_clarification_expiry_limit) > 0 && floor(tonumber(var.spec_factory_turn_clarification_expiry_limit)) == tonumber(var.spec_factory_turn_clarification_expiry_limit)
    error_message = "spec_factory_turn_clarification_expiry_limit must be a positive integer."
  }
}

variable "spec_factory_agent_task_worker_enabled" {
  description = "Enables the Compose agent-task worker loop inside all-local and worker/research-worker Spec Factory runtimes."
  type        = bool
  default     = false
}

variable "spec_factory_agent_task_lease_ms" {
  description = "Agent-task worker lease TTL in milliseconds. Must be at least spec_factory_research_max_runtime_seconds * 1000 when the research executor is enabled."
  type        = string
  default     = "900000"

  validation {
    condition     = trimspace(var.spec_factory_agent_task_lease_ms) != "" && can(tonumber(var.spec_factory_agent_task_lease_ms)) && tonumber(var.spec_factory_agent_task_lease_ms) > 0 && floor(tonumber(var.spec_factory_agent_task_lease_ms)) == tonumber(var.spec_factory_agent_task_lease_ms)
    error_message = "spec_factory_agent_task_lease_ms must be a positive integer."
  }
}

variable "spec_factory_agent_task_worker_batch_size" {
  description = "Maximum agent tasks a worker drains per poll."
  type        = string
  default     = "25"

  validation {
    condition     = trimspace(var.spec_factory_agent_task_worker_batch_size) != "" && can(tonumber(var.spec_factory_agent_task_worker_batch_size)) && tonumber(var.spec_factory_agent_task_worker_batch_size) > 0 && floor(tonumber(var.spec_factory_agent_task_worker_batch_size)) == tonumber(var.spec_factory_agent_task_worker_batch_size)
    error_message = "spec_factory_agent_task_worker_batch_size must be a positive integer."
  }
}

variable "spec_factory_agent_task_worker_poll_ms" {
  description = "Agent-task worker drain poll interval in milliseconds."
  type        = string
  default     = "1000"

  validation {
    condition     = trimspace(var.spec_factory_agent_task_worker_poll_ms) != "" && can(tonumber(var.spec_factory_agent_task_worker_poll_ms)) && tonumber(var.spec_factory_agent_task_worker_poll_ms) > 0 && floor(tonumber(var.spec_factory_agent_task_worker_poll_ms)) == tonumber(var.spec_factory_agent_task_worker_poll_ms)
    error_message = "spec_factory_agent_task_worker_poll_ms must be a positive integer."
  }
}

variable "spec_factory_agent_task_lease_recovery_limit" {
  description = "Maximum expired agent-task leases recovered per worker drain."
  type        = string
  default     = "100"

  validation {
    condition     = trimspace(var.spec_factory_agent_task_lease_recovery_limit) != "" && can(tonumber(var.spec_factory_agent_task_lease_recovery_limit)) && tonumber(var.spec_factory_agent_task_lease_recovery_limit) > 0 && floor(tonumber(var.spec_factory_agent_task_lease_recovery_limit)) == tonumber(var.spec_factory_agent_task_lease_recovery_limit)
    error_message = "spec_factory_agent_task_lease_recovery_limit must be a positive integer."
  }
}

variable "spec_factory_agent_task_worker_capabilities" {
  description = "Optional comma-separated capability filter for the agent-task worker. Empty lets the service derive safe defaults from enabled feature flags."
  type        = string
  default     = ""
}

variable "spec_factory_workspace_manager_enabled" {
  description = "Enables the Spec Factory workspace manager abstraction in the primary all-local/API task. Split worker task definitions force this on because non-all-local modes require it."
  type        = bool
  default     = false
}

variable "spec_factory_research_executor" {
  description = "SPEC_FACTORY_RESEARCH_EXECUTOR runtime selector. Use claude_agent_sdk only after research worker, redaction, lease, and budget gates are ready."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "claude_agent_sdk"], var.spec_factory_research_executor)
    error_message = "spec_factory_research_executor must be one of: none, claude_agent_sdk."
  }
}

variable "spec_factory_research_ingress_enabled" {
  description = "Enables authenticated POST /sessions/:sessionId/research/code ingress. Kept separate from spec_factory_research_executor so workers can be staged before user traffic."
  type        = bool
  default     = false
}

variable "spec_factory_research_allowed_tools" {
  description = "Comma-separated Claude SDK tools exposed to the research executor. Bash remains fail-closed unless spec_factory_research_allowed_bash_patterns is set."
  type        = string
  default     = "Read,Grep,Glob"
}

variable "spec_factory_research_allowed_bash_patterns" {
  description = "Comma-separated anchored Bash command regexes for the research executor. Empty disables Bash even if Bash appears in spec_factory_research_allowed_tools."
  type        = string
  default     = ""
}

variable "spec_factory_research_model_id" {
  description = "Optional Bedrock model override for Claude SDK research executor runs. Empty falls back to spec_factory_model_id."
  type        = string
  default     = ""
}

variable "spec_factory_research_timeout_ms" {
  description = "Claude SDK research runner timeout in milliseconds. The effective timeout is also capped by spec_factory_research_max_runtime_seconds."
  type        = string
  default     = "600000"

  validation {
    condition     = trimspace(var.spec_factory_research_timeout_ms) != "" && can(tonumber(var.spec_factory_research_timeout_ms)) && tonumber(var.spec_factory_research_timeout_ms) > 0 && floor(tonumber(var.spec_factory_research_timeout_ms)) == tonumber(var.spec_factory_research_timeout_ms)
    error_message = "spec_factory_research_timeout_ms must be a positive integer."
  }
}

variable "spec_factory_research_max_runtime_seconds" {
  description = "Per-task research executor runtime cap in seconds."
  type        = string
  default     = "600"

  validation {
    condition     = trimspace(var.spec_factory_research_max_runtime_seconds) != "" && can(tonumber(var.spec_factory_research_max_runtime_seconds)) && tonumber(var.spec_factory_research_max_runtime_seconds) > 0 && floor(tonumber(var.spec_factory_research_max_runtime_seconds)) == tonumber(var.spec_factory_research_max_runtime_seconds)
    error_message = "spec_factory_research_max_runtime_seconds must be a positive integer."
  }
}

variable "spec_factory_research_distillation_enabled" {
  description = "Enqueue source_distillation tasks after generated research artifact/source writes succeed."
  type        = bool
  default     = false
}

variable "spec_factory_research_max_turns" {
  description = "Optional Claude SDK max-turn cap for generated research tasks. Empty keeps the executor default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_research_max_turns) == "" || try(tonumber(var.spec_factory_research_max_turns) > 0 && floor(tonumber(var.spec_factory_research_max_turns)) == tonumber(var.spec_factory_research_max_turns), false)
    error_message = "spec_factory_research_max_turns must be empty or a positive integer."
  }
}

variable "spec_factory_research_tool_budget" {
  description = "Optional total repository-tool budget for generated research tasks. Empty keeps the executor default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_research_tool_budget) == "" || try(tonumber(var.spec_factory_research_tool_budget) > 0 && floor(tonumber(var.spec_factory_research_tool_budget)) == tonumber(var.spec_factory_research_tool_budget), false)
    error_message = "spec_factory_research_tool_budget must be empty or a positive integer."
  }
}

variable "spec_factory_research_max_cost_usd" {
  description = "Optional per-task Claude SDK budget cap for generated research tasks. Empty keeps the executor default of 3.0 USD."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_research_max_cost_usd) == "" || try(tonumber(var.spec_factory_research_max_cost_usd) > 0, false)
    error_message = "spec_factory_research_max_cost_usd must be empty or a positive number."
  }
}

variable "spec_factory_research_cost_ceiling_usd" {
  description = "Optional per-session rolling manual/coordinator research cost ceiling in USD. Empty leaves research enqueue fail-closed until a rollout sets a value."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_research_cost_ceiling_usd) == "" || try(tonumber(var.spec_factory_research_cost_ceiling_usd) >= 0, false)
    error_message = "spec_factory_research_cost_ceiling_usd must be empty or a non-negative number."
  }
}

variable "spec_factory_research_tasks_per_24h" {
  description = "Optional per-session rolling 24h cap on manual/coordinator research task creation. Empty means no explicit task-count cap."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_research_tasks_per_24h) == "" || try(tonumber(var.spec_factory_research_tasks_per_24h) >= 0 && floor(tonumber(var.spec_factory_research_tasks_per_24h)) == tonumber(var.spec_factory_research_tasks_per_24h), false)
    error_message = "spec_factory_research_tasks_per_24h must be empty or a non-negative integer."
  }
}

variable "spec_factory_research_inflight_tasks_per_session" {
  description = "Per-session cap on queued/running manual/coordinator research tasks."
  type        = string
  default     = "3"

  validation {
    condition     = trimspace(var.spec_factory_research_inflight_tasks_per_session) != "" && can(tonumber(var.spec_factory_research_inflight_tasks_per_session)) && tonumber(var.spec_factory_research_inflight_tasks_per_session) >= 0 && floor(tonumber(var.spec_factory_research_inflight_tasks_per_session)) == tonumber(var.spec_factory_research_inflight_tasks_per_session)
    error_message = "spec_factory_research_inflight_tasks_per_session must be a non-negative integer."
  }
}

variable "spec_factory_research_global_cost_ceiling_usd" {
  description = "Optional global rolling coordinator research cost ceiling in USD. Empty disables the global cost ceiling."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_research_global_cost_ceiling_usd) == "" || try(tonumber(var.spec_factory_research_global_cost_ceiling_usd) >= 0, false)
    error_message = "spec_factory_research_global_cost_ceiling_usd must be empty or a non-negative number."
  }
}

variable "spec_factory_research_global_inflight_tasks" {
  description = "Optional global cap on queued/running coordinator research tasks. Empty disables the global in-flight cap."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_research_global_inflight_tasks) == "" || try(tonumber(var.spec_factory_research_global_inflight_tasks) >= 0 && floor(tonumber(var.spec_factory_research_global_inflight_tasks)) == tonumber(var.spec_factory_research_global_inflight_tasks), false)
    error_message = "spec_factory_research_global_inflight_tasks must be empty or a non-negative integer."
  }
}

variable "spec_factory_research_global_tasks_per_24h" {
  description = "Optional global rolling 24h cap on coordinator research task creation. Empty disables the global task-count cap."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_research_global_tasks_per_24h) == "" || try(tonumber(var.spec_factory_research_global_tasks_per_24h) >= 0 && floor(tonumber(var.spec_factory_research_global_tasks_per_24h)) == tonumber(var.spec_factory_research_global_tasks_per_24h), false)
    error_message = "spec_factory_research_global_tasks_per_24h must be empty or a non-negative integer."
  }
}

variable "spec_factory_enable_context_distillation" {
  description = "Enqueue source_distillation tasks after converted operator-added sources complete conversion."
  type        = bool
  default     = false
}

variable "spec_factory_enable_context_distillation_llm" {
  description = "Run source_distillation through the LLM Gateway instead of the deterministic extractor."
  type        = bool
  default     = false
}

variable "spec_factory_context_distillation_max_cost_usd" {
  description = "Optional per-call cost cap for LLM-assisted source distillation. Empty leaves the executor unset."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_context_distillation_max_cost_usd) == "" || try(tonumber(var.spec_factory_context_distillation_max_cost_usd) > 0, false)
    error_message = "spec_factory_context_distillation_max_cost_usd must be empty or a positive number."
  }
}

variable "spec_factory_context_distillation_timeout_ms" {
  description = "Optional timeout in milliseconds for LLM-assisted source distillation. Empty keeps the gateway default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_context_distillation_timeout_ms) == "" || try(tonumber(var.spec_factory_context_distillation_timeout_ms) > 0 && floor(tonumber(var.spec_factory_context_distillation_timeout_ms)) == tonumber(var.spec_factory_context_distillation_timeout_ms), false)
    error_message = "spec_factory_context_distillation_timeout_ms must be empty or a positive integer."
  }
}

variable "spec_factory_enable_context_merge" {
  description = "Enable the Context Merger agent-task processor."
  type        = bool
  default     = false
}

variable "spec_factory_enable_context_merge_llm" {
  description = "Run Context Merger semantic synthesis through the LLM Gateway."
  type        = bool
  default     = false
}

variable "spec_factory_context_merge_max_cost_usd" {
  description = "Optional per-call cost cap for LLM-assisted context merge. Empty leaves the executor unset."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_context_merge_max_cost_usd) == "" || try(tonumber(var.spec_factory_context_merge_max_cost_usd) > 0, false)
    error_message = "spec_factory_context_merge_max_cost_usd must be empty or a positive number."
  }
}

variable "spec_factory_context_merge_timeout_ms" {
  description = "Optional timeout in milliseconds for LLM-assisted context merge. Empty keeps the gateway default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_context_merge_timeout_ms) == "" || try(tonumber(var.spec_factory_context_merge_timeout_ms) > 0 && floor(tonumber(var.spec_factory_context_merge_timeout_ms)) == tonumber(var.spec_factory_context_merge_timeout_ms), false)
    error_message = "spec_factory_context_merge_timeout_ms must be empty or a positive integer."
  }
}

variable "spec_factory_llm_gateway_enabled" {
  description = "Route direct Spec Factory LLM calls through the Phase 8 LLM Gateway."
  type        = bool
  default     = false
}

variable "spec_factory_llm_direct_bedrock_purposes" {
  description = "Comma-separated LLM Gateway purposes routed directly through Bedrock Converse instead of the Claude Agent SDK."
  type        = string
  default     = ""

  validation {
    condition = alltrue([
      for purpose in split(",", var.spec_factory_llm_direct_bedrock_purposes) :
      trimspace(purpose) == "" || contains([
        "chat_coordinator_fast",
        "chat_coordinator_strong",
        "source_distillation",
        "context_merge",
        "critic_review",
        "handoff_synthesis",
        "conversation_summary",
      ], trimspace(purpose))
    ])
    error_message = "spec_factory_llm_direct_bedrock_purposes contains an unsupported LLM purpose."
  }
}

variable "spec_factory_llm_prompt_logging" {
  description = "LLM Gateway prompt/response artifact logging mode."
  type        = string
  default     = "redacted"

  validation {
    condition     = contains(["none", "redacted", "full"], var.spec_factory_llm_prompt_logging)
    error_message = "spec_factory_llm_prompt_logging must be one of: none, redacted, full."
  }
}

variable "spec_factory_llm_audit_artifact_base" {
  description = "Optional filesystem root for redacted/full LLM prompt and response audit artifacts. Empty records usage rows with null artifact URIs."
  type        = string
  default     = ""
}

variable "spec_factory_llm_secure_debug" {
  description = "Explicit non-production gate required for full LLM prompt logging."
  type        = bool
  default     = false
}

variable "spec_factory_prompt_registry_source" {
  description = "Prompt registry source for LLM Gateway calls."
  type        = string
  default     = "static"

  validation {
    condition     = contains(["static", "db"], var.spec_factory_prompt_registry_source)
    error_message = "spec_factory_prompt_registry_source must be one of: static, db."
  }
}

variable "spec_factory_llm_max_attempts" {
  description = "Maximum LLM Gateway provider attempts for transient errors."
  type        = string
  default     = "3"

  validation {
    condition     = trimspace(var.spec_factory_llm_max_attempts) != "" && can(tonumber(var.spec_factory_llm_max_attempts)) && tonumber(var.spec_factory_llm_max_attempts) > 0 && floor(tonumber(var.spec_factory_llm_max_attempts)) == tonumber(var.spec_factory_llm_max_attempts)
    error_message = "spec_factory_llm_max_attempts must be a positive integer."
  }
}

variable "spec_factory_llm_retry_base_ms" {
  description = "Linear retry backoff base in milliseconds for LLM Gateway transient retries."
  type        = string
  default     = "25"

  validation {
    condition     = trimspace(var.spec_factory_llm_retry_base_ms) != "" && can(tonumber(var.spec_factory_llm_retry_base_ms)) && tonumber(var.spec_factory_llm_retry_base_ms) >= 0 && floor(tonumber(var.spec_factory_llm_retry_base_ms)) == tonumber(var.spec_factory_llm_retry_base_ms)
    error_message = "spec_factory_llm_retry_base_ms must be a non-negative integer."
  }
}

variable "spec_factory_llm_session_cost_ceiling_usd" {
  description = "Optional LLM Gateway pre-flight session cost ceiling in USD. Empty disables the session ceiling."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_llm_session_cost_ceiling_usd) == "" || try(tonumber(var.spec_factory_llm_session_cost_ceiling_usd) >= 0, false)
    error_message = "spec_factory_llm_session_cost_ceiling_usd must be empty or a non-negative number."
  }
}

variable "spec_factory_llm_global_daily_cost_ceiling_usd" {
  description = "Optional LLM Gateway pre-flight global UTC-day cost ceiling in USD. Empty disables the global daily ceiling."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_llm_global_daily_cost_ceiling_usd) == "" || try(tonumber(var.spec_factory_llm_global_daily_cost_ceiling_usd) >= 0, false)
    error_message = "spec_factory_llm_global_daily_cost_ceiling_usd must be empty or a non-negative number."
  }
}

variable "spec_factory_llm_model_allowlist" {
  description = "Optional comma-separated Bedrock model allowlist for LLM Gateway calls. Empty permits the resolved model."
  type        = string
  default     = ""
}

variable "spec_factory_llm_model_chat_coordinator_fast" {
  description = "Optional model override for chat_coordinator_fast LLM Gateway calls."
  type        = string
  default     = ""
}

variable "spec_factory_llm_model_chat_coordinator_strong" {
  description = "Optional model override for chat_coordinator_strong LLM Gateway calls."
  type        = string
  default     = ""
}

variable "spec_factory_llm_model_source_distillation" {
  description = "Optional model override for source_distillation LLM Gateway calls."
  type        = string
  default     = ""
}

variable "spec_factory_llm_model_context_merge" {
  description = "Optional model override for context_merge LLM Gateway calls."
  type        = string
  default     = ""
}

variable "spec_factory_llm_model_critic_review" {
  description = "Optional model override for critic_review LLM Gateway calls."
  type        = string
  default     = ""
}

variable "spec_factory_llm_model_handoff_synthesis" {
  description = "Optional model override for handoff_synthesis LLM Gateway calls."
  type        = string
  default     = ""
}

variable "spec_factory_llm_model_conversation_summary" {
  description = "Optional model override for conversation_summary LLM Gateway calls."
  type        = string
  default     = ""
}

variable "spec_factory_llm_max_output_tokens" {
  description = "Optional global LLM Gateway max output token cap. Empty leaves provider defaults in place."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_llm_max_output_tokens) == "" || try(tonumber(var.spec_factory_llm_max_output_tokens) > 0 && floor(tonumber(var.spec_factory_llm_max_output_tokens)) == tonumber(var.spec_factory_llm_max_output_tokens), false)
    error_message = "spec_factory_llm_max_output_tokens must be empty or a positive integer."
  }
}

variable "spec_factory_llm_max_output_tokens_chat_coordinator_fast" {
  description = "Optional output-token cap for chat_coordinator_fast LLM Gateway calls. Empty falls back to the global cap or provider default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_llm_max_output_tokens_chat_coordinator_fast) == "" || try(tonumber(var.spec_factory_llm_max_output_tokens_chat_coordinator_fast) > 0 && floor(tonumber(var.spec_factory_llm_max_output_tokens_chat_coordinator_fast)) == tonumber(var.spec_factory_llm_max_output_tokens_chat_coordinator_fast), false)
    error_message = "spec_factory_llm_max_output_tokens_chat_coordinator_fast must be empty or a positive integer."
  }
}

variable "spec_factory_llm_max_output_tokens_chat_coordinator_strong" {
  description = "Optional output-token cap for chat_coordinator_strong LLM Gateway calls. Empty falls back to the global cap or provider default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_llm_max_output_tokens_chat_coordinator_strong) == "" || try(tonumber(var.spec_factory_llm_max_output_tokens_chat_coordinator_strong) > 0 && floor(tonumber(var.spec_factory_llm_max_output_tokens_chat_coordinator_strong)) == tonumber(var.spec_factory_llm_max_output_tokens_chat_coordinator_strong), false)
    error_message = "spec_factory_llm_max_output_tokens_chat_coordinator_strong must be empty or a positive integer."
  }
}

variable "spec_factory_llm_max_output_tokens_source_distillation" {
  description = "Optional output-token cap for source_distillation LLM Gateway calls. Empty falls back to the global cap or provider default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_llm_max_output_tokens_source_distillation) == "" || try(tonumber(var.spec_factory_llm_max_output_tokens_source_distillation) > 0 && floor(tonumber(var.spec_factory_llm_max_output_tokens_source_distillation)) == tonumber(var.spec_factory_llm_max_output_tokens_source_distillation), false)
    error_message = "spec_factory_llm_max_output_tokens_source_distillation must be empty or a positive integer."
  }
}

variable "spec_factory_llm_max_output_tokens_context_merge" {
  description = "Optional output-token cap for context_merge LLM Gateway calls. Empty falls back to the global cap or provider default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_llm_max_output_tokens_context_merge) == "" || try(tonumber(var.spec_factory_llm_max_output_tokens_context_merge) > 0 && floor(tonumber(var.spec_factory_llm_max_output_tokens_context_merge)) == tonumber(var.spec_factory_llm_max_output_tokens_context_merge), false)
    error_message = "spec_factory_llm_max_output_tokens_context_merge must be empty or a positive integer."
  }
}

variable "spec_factory_llm_max_output_tokens_critic_review" {
  description = "Optional output-token cap for critic_review LLM Gateway calls. Empty falls back to the global cap or provider default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_llm_max_output_tokens_critic_review) == "" || try(tonumber(var.spec_factory_llm_max_output_tokens_critic_review) > 0 && floor(tonumber(var.spec_factory_llm_max_output_tokens_critic_review)) == tonumber(var.spec_factory_llm_max_output_tokens_critic_review), false)
    error_message = "spec_factory_llm_max_output_tokens_critic_review must be empty or a positive integer."
  }
}

variable "spec_factory_llm_max_output_tokens_handoff_synthesis" {
  description = "Optional output-token cap for handoff_synthesis LLM Gateway calls. Empty falls back to the global cap or provider default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_llm_max_output_tokens_handoff_synthesis) == "" || try(tonumber(var.spec_factory_llm_max_output_tokens_handoff_synthesis) > 0 && floor(tonumber(var.spec_factory_llm_max_output_tokens_handoff_synthesis)) == tonumber(var.spec_factory_llm_max_output_tokens_handoff_synthesis), false)
    error_message = "spec_factory_llm_max_output_tokens_handoff_synthesis must be empty or a positive integer."
  }
}

variable "spec_factory_llm_max_output_tokens_conversation_summary" {
  description = "Optional output-token cap for conversation_summary LLM Gateway calls. Empty falls back to the global cap or provider default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_llm_max_output_tokens_conversation_summary) == "" || try(tonumber(var.spec_factory_llm_max_output_tokens_conversation_summary) > 0 && floor(tonumber(var.spec_factory_llm_max_output_tokens_conversation_summary)) == tonumber(var.spec_factory_llm_max_output_tokens_conversation_summary), false)
    error_message = "spec_factory_llm_max_output_tokens_conversation_summary must be empty or a positive integer."
  }
}

variable "spec_factory_chat_coordinator_enabled" {
  description = "Enable Phase 9 Chat Coordinator routing when spec_factory_llm_gateway_enabled is also true."
  type        = bool
  default     = false
}

variable "spec_factory_coordinator_max_tasks_per_turn" {
  description = "Coordinator dispatch fan-out ceiling per turn."
  type        = string
  default     = "3"

  validation {
    condition     = trimspace(var.spec_factory_coordinator_max_tasks_per_turn) != "" && can(tonumber(var.spec_factory_coordinator_max_tasks_per_turn)) && tonumber(var.spec_factory_coordinator_max_tasks_per_turn) > 0 && floor(tonumber(var.spec_factory_coordinator_max_tasks_per_turn)) == tonumber(var.spec_factory_coordinator_max_tasks_per_turn)
    error_message = "spec_factory_coordinator_max_tasks_per_turn must be a positive integer."
  }
}

variable "spec_factory_enable_critic" {
  description = "Enable non-blocking critic review scheduling when the LLM Gateway is enabled. Worker executor registration follows the worker capability allowlist independently."
  type        = bool
  default     = false
}

variable "spec_factory_critic_max_cost_usd" {
  description = "Optional per-call cost cap for critic_review LLM Gateway calls. Empty leaves the executor unset."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_critic_max_cost_usd) == "" || try(tonumber(var.spec_factory_critic_max_cost_usd) > 0, false)
    error_message = "spec_factory_critic_max_cost_usd must be empty or a positive number."
  }
}

variable "spec_factory_critic_timeout_ms" {
  description = "Optional timeout in milliseconds for critic_review LLM Gateway calls. Empty keeps the gateway default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_critic_timeout_ms) == "" || try(tonumber(var.spec_factory_critic_timeout_ms) > 0 && floor(tonumber(var.spec_factory_critic_timeout_ms)) == tonumber(var.spec_factory_critic_timeout_ms), false)
    error_message = "spec_factory_critic_timeout_ms must be empty or a positive integer."
  }
}

variable "spec_factory_handoff_enriched" {
  description = "Enable bounded Compose handoff summary enrichment plus deterministic handoff artifacts."
  type        = bool
  default     = false
}

variable "spec_factory_handoff_build_task_enabled" {
  description = "Route Compose handoff artifact/evidence/draft generation through a queued handoff_build task. Worker executor registration follows the worker capability allowlist independently."
  type        = bool
  default     = false
}

variable "spec_factory_handoff_llm_synthesis" {
  description = "Enable LLM-authored handoff narrative fields in the queued handoff_build executor."
  type        = bool
  default     = false
}

variable "spec_factory_handoff_synthesis_max_cost_usd" {
  description = "Optional per-call cost cap for handoff_synthesis LLM Gateway calls. Empty leaves the executor unset."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_handoff_synthesis_max_cost_usd) == "" || try(tonumber(var.spec_factory_handoff_synthesis_max_cost_usd) > 0, false)
    error_message = "spec_factory_handoff_synthesis_max_cost_usd must be empty or a positive number."
  }
}

variable "spec_factory_handoff_synthesis_timeout_ms" {
  description = "Optional timeout in milliseconds for handoff_synthesis LLM Gateway calls. Empty keeps the gateway default."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.spec_factory_handoff_synthesis_timeout_ms) == "" || try(tonumber(var.spec_factory_handoff_synthesis_timeout_ms) > 0 && floor(tonumber(var.spec_factory_handoff_synthesis_timeout_ms)) == tonumber(var.spec_factory_handoff_synthesis_timeout_ms), false)
    error_message = "spec_factory_handoff_synthesis_timeout_ms must be empty or a positive integer."
  }
}

variable "spec_factory_admin_ids" {
  description = "Comma-separated OIDC actor ids whose ActorContext roles include admin."
  type        = string
  default     = ""
}

variable "spec_factory_louise_jql" {
  description = "JQL used by Spec Factory to find Louise-estimated tickets"
  type        = string
  default     = "labels = \"louise-estimated\" AND labels not in (\"SPEC-FACTORY-STARTED\") ORDER BY updated DESC"
}

variable "spec_factory_jira_project_key" {
  description = "Jira project key used when Spec Factory publishes generated epics/stories."
  type        = string
  default     = "CPDEV"

  validation {
    condition     = trimspace(var.spec_factory_jira_project_key) != ""
    error_message = "spec_factory_jira_project_key must not be empty."
  }
}

variable "spec_factory_jira_epic_issue_type" {
  description = "Jira issue type used for generated Spec Factory epics."
  type        = string
  default     = "Epic"

  validation {
    condition     = trimspace(var.spec_factory_jira_epic_issue_type) != ""
    error_message = "spec_factory_jira_epic_issue_type must not be empty."
  }
}

variable "spec_factory_jira_child_issue_type" {
  description = "Jira issue type used for generated Spec Factory child work items."
  type        = string
  default     = "Story"

  validation {
    condition     = trimspace(var.spec_factory_jira_child_issue_type) != ""
    error_message = "spec_factory_jira_child_issue_type must not be empty."
  }
}

variable "spec_factory_model_id" {
  description = "Bedrock model id used by Spec Factory draft generation"
  type        = string
  default     = "us.anthropic.claude-opus-4-8"
}

variable "spec_factory_qualifier_timeout_ms" {
  description = "Claude SDK timeout in milliseconds for Spec Factory qualification runs."
  type        = string
  default     = "300000"

  validation {
    condition     = trimspace(var.spec_factory_qualifier_timeout_ms) != "" && can(tonumber(var.spec_factory_qualifier_timeout_ms)) && tonumber(var.spec_factory_qualifier_timeout_ms) > 0 && floor(tonumber(var.spec_factory_qualifier_timeout_ms)) == tonumber(var.spec_factory_qualifier_timeout_ms)
    error_message = "spec_factory_qualifier_timeout_ms must be a positive integer."
  }
}

variable "spec_factory_draft_timeout_ms" {
  description = "Claude SDK timeout in milliseconds for Spec Factory draft generation."
  type        = string
  default     = "1200000"

  validation {
    condition     = trimspace(var.spec_factory_draft_timeout_ms) != "" && can(tonumber(var.spec_factory_draft_timeout_ms)) && tonumber(var.spec_factory_draft_timeout_ms) > 0 && floor(tonumber(var.spec_factory_draft_timeout_ms)) == tonumber(var.spec_factory_draft_timeout_ms)
    error_message = "spec_factory_draft_timeout_ms must be a positive integer."
  }
}

variable "compose_chat_model_id" {
  description = "Bedrock model or inference profile ID used by the Spec Factory Compose chat/clarification agent. Keep separate from spec_factory_model_id so draft generation can stay on the heavier model."
  type        = string
  default     = "us.anthropic.claude-sonnet-5"
}

variable "compose_max_queued_turns" {
  description = "Maximum running plus queued Compose turns per session before the API returns queue_full."
  type        = number
  default     = 3

  validation {
    condition     = var.compose_max_queued_turns >= 0 && floor(var.compose_max_queued_turns) == var.compose_max_queued_turns
    error_message = "compose_max_queued_turns must be a non-negative integer."
  }
}

variable "compose_max_upload_bytes" {
  description = "Maximum raw upload size accepted by Compose before presigned upload creation."
  type        = number
  default     = 524288000

  validation {
    condition     = var.compose_max_upload_bytes > 0 && floor(var.compose_max_upload_bytes) == var.compose_max_upload_bytes
    error_message = "compose_max_upload_bytes must be a positive integer."
  }
}

variable "compose_chat_timeout_ms" {
  description = "Claude SDK timeout in milliseconds for Compose chat turns."
  type        = number
  default     = 300000

  validation {
    condition     = var.compose_chat_timeout_ms > 0 && floor(var.compose_chat_timeout_ms) == var.compose_chat_timeout_ms
    error_message = "compose_chat_timeout_ms must be a positive integer."
  }
}

variable "compose_chat_max_prompt_tokens" {
  description = "Estimated prompt-token cap for Compose chat prompt assembly."
  type        = number
  default     = 150000

  validation {
    condition     = var.compose_chat_max_prompt_tokens > 0 && floor(var.compose_chat_max_prompt_tokens) == var.compose_chat_max_prompt_tokens
    error_message = "compose_chat_max_prompt_tokens must be a positive integer."
  }
}

variable "compose_retry_base_ms" {
  description = "Base backoff in milliseconds for transient Compose chat-turn retries."
  type        = number
  default     = 1000

  validation {
    condition     = var.compose_retry_base_ms >= 0 && floor(var.compose_retry_base_ms) == var.compose_retry_base_ms
    error_message = "compose_retry_base_ms must be a non-negative integer."
  }
}

variable "compose_workspace_validate_on_startup" {
  description = "When true, validate COMPOSE_WORKSPACE_BASE on all-local startup. Split runtime modes always validate regardless of this flag."
  type        = bool
  default     = false
}

variable "compose_voxtral_model_id" {
  description = "Bedrock model id for Compose audio/video transcription; invoked directly with no inference profile prefix"
  type        = string
  default     = "mistral.voxtral-small-24b-2507"
}

variable "compose_audio_segment_seconds" {
  description = "Max seconds of audio per Voxtral request; ffmpeg segments longer media into chunks of this size. Bounds the segment's audio-token cost against Voxtral's ~32k context window (300s ≈ 13.2k tokens). Byte size is bounded separately by the mp3 bitrate below."
  type        = number
  default     = 300
}

variable "compose_voxtral_max_request_bytes" {
  description = "Maximum serialized Voxtral InvokeModel request body size in bytes; guards the endpoint's body-buffer limit before the Bedrock call."
  type        = number
  default     = 8000000

  validation {
    condition     = var.compose_voxtral_max_request_bytes > 0 && floor(var.compose_voxtral_max_request_bytes) == var.compose_voxtral_max_request_bytes
    error_message = "compose_voxtral_max_request_bytes must be a positive integer."
  }
}

variable "compose_repo_grounding_enabled" {
  description = "Whether the Compose clarification agent attaches selected/identified code repos as read-only checkouts and greps them live. Off => legacy metadata-only repositories.md."
  type        = bool
  default     = true
}

variable "compose_max_grounded_repos" {
  description = "Max code repos attached to a Compose clarification turn (operator-selected prioritized over auto-identified)."
  type        = number
  default     = 3
}

variable "compose_repo_grounding_tool_budget" {
  description = "Max repo grep/Read tool calls the Compose agent may make per turn; bounds latency/tokens on large repos."
  type        = number
  default     = 40
}

variable "compose_repo_grounding_timeout_ms" {
  description = "Clone/scan budget per turn for Compose repo grounding, separate from the chat-turn timeout (cache hit is fast; covers a cold/stale refresh + scan)."
  type        = number
  default     = 120000
}

variable "compose_audio_mp3_bitrate" {
  description = "ffmpeg mp3 bitrate for transcription segments (e.g. \"64k\"). Segments are emitted as 16kHz mono mp3 (not wav) so a 300s segment is ~3.2MB base64 instead of ~12.8MB — WAV exceeded the Voxtral endpoint request-body limit. 64k is ample for 16kHz speech."
  type        = string
  default     = "64k"
}

variable "compose_convert_timeout_ms" {
  description = "Timeout in milliseconds for document conversion sidecar calls."
  type        = number
  default     = 300000

  validation {
    condition     = var.compose_convert_timeout_ms > 0 && floor(var.compose_convert_timeout_ms) == var.compose_convert_timeout_ms
    error_message = "compose_convert_timeout_ms must be a positive integer."
  }
}

variable "compose_extract_audio_timeout_ms" {
  description = "Timeout for the ffmpeg audio-extraction sidecar call per media source. Separate from (and longer than) the document-conversion timeout; aligns with the sidecar ffmpeg budget."
  type        = number
  default     = 600000
}

variable "compose_transcribe_segment_timeout_ms" {
  description = "Per-segment Voxtral transcription timeout. Bounds each Bedrock call independently so long, healthy media is not failed by one cumulative budget."
  type        = number
  default     = 120000
}

variable "compose_conversion_lease_ms" {
  description = "Lease held while converting a source. Must exceed the worst-case total wall clock (extract + every segment near its timeout) so an expired lease cannot be reclaimed and double-processed mid-transcription."
  type        = number
  default     = 2400000
}

variable "compose_conversion_poll_ms" {
  description = "Compose conversion worker drain poll interval in milliseconds."
  type        = number
  default     = 5000

  validation {
    condition     = var.compose_conversion_poll_ms > 0 && floor(var.compose_conversion_poll_ms) == var.compose_conversion_poll_ms
    error_message = "compose_conversion_poll_ms must be a positive integer."
  }
}

variable "compose_retention_cleanup_enabled" {
  description = "Enable the scheduled retention sweep that purges EFS workspaces and S3 raw uploads for sessions archived past the retention window. Off by default; enable after validating with a dry run."
  type        = bool
  default     = false
}

variable "compose_workspace_retention_days" {
  description = "Age (days) past archival after which a Compose session's workspace + S3 uploads are eligible for retention cleanup."
  type        = number
  default     = 30
}

variable "compose_cleanup_limit" {
  description = "Maximum archived Compose sessions processed per retention sweep."
  type        = number
  default     = 50

  validation {
    condition     = var.compose_cleanup_limit > 0 && floor(var.compose_cleanup_limit) == var.compose_cleanup_limit
    error_message = "compose_cleanup_limit must be a positive integer."
  }
}

variable "compose_retention_sweep_ms" {
  description = "Retention sweep interval in milliseconds when COMPOSE_RETENTION_CLEANUP_ENABLED is true."
  type        = number
  default     = 21600000

  validation {
    condition     = var.compose_retention_sweep_ms > 0 && floor(var.compose_retention_sweep_ms) == var.compose_retention_sweep_ms
    error_message = "compose_retention_sweep_ms must be a positive integer."
  }
}

variable "spec_factory_source_delete_undo_minutes" {
  description = "Minutes after a Compose source is removed during which the original source can be restored before physical artifact purge."
  type        = number
  default     = 10

  validation {
    condition     = var.spec_factory_source_delete_undo_minutes > 0 && var.spec_factory_source_delete_undo_minutes <= 10080 && floor(var.spec_factory_source_delete_undo_minutes) == var.spec_factory_source_delete_undo_minutes
    error_message = "spec_factory_source_delete_undo_minutes must be an integer from 1 through 10080."
  }
}

variable "spec_factory_source_delete_sweep_ms" {
  description = "Interval in milliseconds for the retention worker to purge source deletions after their undo window expires."
  type        = number
  default     = 60000

  validation {
    condition     = var.spec_factory_source_delete_sweep_ms > 0 && floor(var.spec_factory_source_delete_sweep_ms) == var.spec_factory_source_delete_sweep_ms
    error_message = "spec_factory_source_delete_sweep_ms must be a positive integer."
  }
}

variable "spec_factory_source_delete_purge_limit" {
  description = "Maximum source-deletion batches purged by one retention-worker sweep."
  type        = number
  default     = 50

  validation {
    condition     = var.spec_factory_source_delete_purge_limit > 0 && floor(var.spec_factory_source_delete_purge_limit) == var.spec_factory_source_delete_purge_limit
    error_message = "spec_factory_source_delete_purge_limit must be a positive integer."
  }
}

variable "spec_factory_worker_heartbeat_retention_days" {
  description = "Age threshold in days for deleting stale spec_factory_worker_heartbeats rows during the Compose retention sweep."
  type        = number
  default     = 7

  validation {
    condition     = var.spec_factory_worker_heartbeat_retention_days > 0
    error_message = "spec_factory_worker_heartbeat_retention_days must be positive."
  }
}

variable "spec_factory_worker_heartbeat_gc_limit" {
  description = "Maximum stale spec_factory_worker_heartbeats rows deleted per Compose retention sweep."
  type        = number
  default     = 500

  validation {
    condition     = var.spec_factory_worker_heartbeat_gc_limit > 0 && floor(var.spec_factory_worker_heartbeat_gc_limit) == var.spec_factory_worker_heartbeat_gc_limit
    error_message = "spec_factory_worker_heartbeat_gc_limit must be a positive integer."
  }
}

variable "compose_cleanup_dry_run" {
  description = "When true the retention sweep reports what it would delete without deleting. Use to validate the candidate set before enabling destructive cleanup."
  type        = bool
  default     = true
}

variable "compose_artifact_tmp_retention_hours" {
  description = "Age threshold in hours for deleting stale .tmp artifact entries under COMPOSE_WORKSPACE_BASE during the Compose cleanup sweep."
  type        = number
  default     = 24

  validation {
    condition     = var.compose_artifact_tmp_retention_hours > 0
    error_message = "compose_artifact_tmp_retention_hours must be positive."
  }
}

variable "compose_artifact_gc_limit" {
  description = "Maximum stale .tmp artifact entries deleted per Compose cleanup pass."
  type        = number
  default     = 500

  validation {
    condition     = var.compose_artifact_gc_limit > 0 && floor(var.compose_artifact_gc_limit) == var.compose_artifact_gc_limit
    error_message = "compose_artifact_gc_limit must be a positive integer."
  }
}

variable "compose_artifact_gc_max_depth" {
  description = "Maximum directory depth searched for .tmp artifact directories during Compose artifact cleanup."
  type        = number
  default     = 6

  validation {
    condition     = var.compose_artifact_gc_max_depth > 0 && floor(var.compose_artifact_gc_max_depth) == var.compose_artifact_gc_max_depth
    error_message = "compose_artifact_gc_max_depth must be a positive integer."
  }
}

variable "spec_factory_llm_audit_artifact_retention_days" {
  description = "Age threshold in days for clearing file-backed Spec Factory LLM prompt/response audit artifacts from SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE."
  type        = number
  default     = 30

  validation {
    condition     = var.spec_factory_llm_audit_artifact_retention_days > 0
    error_message = "spec_factory_llm_audit_artifact_retention_days must be positive."
  }
}

variable "spec_factory_llm_audit_artifact_gc_limit" {
  description = "Maximum Spec Factory LLM audit rows whose prompt/response artifact URIs are cleaned per retention pass."
  type        = number
  default     = 500

  validation {
    condition     = var.spec_factory_llm_audit_artifact_gc_limit > 0 && floor(var.spec_factory_llm_audit_artifact_gc_limit) == var.spec_factory_llm_audit_artifact_gc_limit
    error_message = "spec_factory_llm_audit_artifact_gc_limit must be a positive integer."
  }
}

variable "compose_s3_reachability_gc_enabled" {
  description = "Enable optional S3 reachability cleanup under COMPOSE_S3_PREFIX for objects not rooted under live compose_sessions.s3_prefix values. Honors compose_cleanup_dry_run."
  type        = bool
  default     = false
}

variable "compose_s3_reachability_gc_limit" {
  description = "Maximum S3 objects inspected per optional Compose reachability cleanup pass."
  type        = number
  default     = 1000

  validation {
    condition     = var.compose_s3_reachability_gc_limit > 0 && floor(var.compose_s3_reachability_gc_limit) == var.compose_s3_reachability_gc_limit
    error_message = "compose_s3_reachability_gc_limit must be a positive integer."
  }
}

variable "compose_confluence_allowed_host_suffixes" {
  description = "Comma-separated host-suffix allowlist for Confluence/URL ingestion (e.g. \"atlassian.net\"). Empty disables the suffix allowlist (public-HTTPS + SSRF checks still apply). Read by both the spec-factory app and the markitdown sidecar."
  type        = string
  default     = ""
}

variable "compose_audio_max_seconds" {
  description = "Max media duration (seconds) the markitdown sidecar will transcribe before rejecting with 413."
  type        = number
  default     = 3600
}

variable "compose_audio_max_bytes" {
  description = "Max uploaded media size (bytes) the markitdown sidecar will accept for audio extraction."
  type        = number
  default     = 524288000
}

variable "compose_markitdown_max_bytes" {
  description = "Max file size (bytes) the markitdown sidecar will convert via /convert."
  type        = number
  default     = 52428800
}

variable "spec_factory_repo_deep_dive_enabled" {
  description = "Enable Spec Factory repo worktree deep-dive before draft generation"
  type        = bool
  default     = false
}

variable "enable_watchdog" {
  description = "Enable the Watchdog investigation surface in the dashboard ECS task, including the watchdog-mcp sidecar."
  type        = bool
  default     = true
}

variable "watchdog_mcp_image_tag" {
  description = "Image tag for the watchdog-mcp sidecar ECR image."
  type        = string
  default     = "latest"
}

variable "watchdog_prod_reader_secret_name" {
  description = "Secrets Manager secret name containing read-only prod AWS credentials for Watchdog MCP CloudWatch/ECS tools."
  type        = string
  default     = "/specter/dev/watchdog/prod-reader"
}

variable "watchdog_prod_account_id" {
  description = "Prod AWS account ID that Watchdog MCP credentials must resolve to."
  type        = string
  default     = "239350186085"
}

variable "watchdog_evidence_bucket" {
  description = "Dedicated S3 bucket for redacted Watchdog evidence payloads."
  type        = string
  default     = "specter-watchdog-evidence"
}

variable "watchdog_investigator" {
  description = "Watchdog runner mode. Use llm_log_analysis for live MCP evidence plus Claude analysis."
  type        = string
  default     = "llm_log_analysis"
}

variable "watchdog_agentic_mcp_loop" {
  description = "Enable or disable optional LLM-planned follow-up MCP searches."
  type        = string
  default     = "disabled"
}

variable "watchdog_claude_max_turns" {
  description = "Claude Agent SDK turn cap for Watchdog investigations."
  type        = number
  default     = 3
}

variable "watchdog_llm_max_output_tokens" {
  description = "Maximum output tokens for Watchdog final analysis."
  type        = number
  default     = 1800
}

variable "watchdog_claude_timeout_ms" {
  description = "Wall-clock timeout for Watchdog Claude analysis calls."
  type        = number
  default     = 240000
}

# Worker Configuration
variable "worker_polling_interval_ms" {
  description = "Worker polling interval in milliseconds"
  type        = number
  default     = 10000
}

# ============================================================================
# CLOUDWATCH CONFIGURATION
# ============================================================================

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}

variable "enable_container_insights" {
  description = "Enable ECS Container Insights"
  type        = bool
  default     = true
}

# ============================================================================
# S3 CONFIGURATION
# ============================================================================

variable "s3_task_bucket" {
  description = "S3 bucket for task descriptions"
  type        = string
  default     = "specter-tasks"
}

variable "s3_result_bucket" {
  description = "S3 bucket for agent results"
  type        = string
  default     = "specter-results"
}

variable "compose_upload_allowed_origins" {
  type        = list(string)
  description = "Browser origins allowed to presigned-PUT Compose uploads to the results bucket"
  default     = ["*"]
}
