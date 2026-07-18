# OneShot queues, image repository, and ECS consumers.

locals {
  oneshot_alarm_topic_arn_effective = (
    trimspace(var.oneshot_alarm_topic_arn) != ""
    ? trimspace(var.oneshot_alarm_topic_arn)
    : (var.enable_oneshot ? aws_sns_topic.oneshot_alerts[0].arn : "")
  )
  oneshot_alarm_actions = trimspace(local.oneshot_alarm_topic_arn_effective) != "" ? [local.oneshot_alarm_topic_arn_effective] : []
}

resource "aws_sns_topic" "oneshot_alerts" {
  count = var.enable_oneshot ? 1 : 0

  name = "${var.environment}-oneshot-alerts"

  tags = merge(local.common_tags, {
    Service = "oneshot"
    Purpose = "alerts"
  })
}

# ============================================================================
# SQS QUEUES
# ============================================================================

resource "aws_sqs_queue" "oneshot_dlq" {
  for_each = var.enable_oneshot ? {
    planning       = 1800
    review         = 900
    implementation = 5400
    code_review    = 3600
    testing        = 1800
  } : {}

  name                        = "oneshot-${replace(each.key, "_", "-")}-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  message_retention_seconds   = 1209600 # 14 days — keep failed messages for investigation
  visibility_timeout_seconds  = each.value

  tags = merge(local.common_tags, {
    Service = "oneshot-${replace(each.key, "_", "-")}-dlq"
    Purpose = "dead-letter-queue"
  })
}

resource "aws_sqs_queue" "oneshot" {
  for_each = var.enable_oneshot ? {
    planning       = 1800
    review         = 900
    implementation = 5400
    code_review    = 3600
    testing        = 1800
  } : {}

  name                        = "oneshot-${replace(each.key, "_", "-")}.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  message_retention_seconds   = 345600
  visibility_timeout_seconds  = each.value
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.oneshot_dlq[each.key].arn
    maxReceiveCount     = 4
  })

  tags = merge(local.common_tags, {
    Service = "oneshot-${replace(each.key, "_", "-")}"
  })
}

# ============================================================================
# CLOUDWATCH ALARMS — DLQ DEPTH
# ============================================================================

resource "aws_cloudwatch_metric_alarm" "oneshot_dlq_depth" {
  for_each = aws_sqs_queue.oneshot_dlq

  alarm_name          = "${var.environment}-oneshot-${replace(each.key, "_", "-")}-dlq-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "OneShot ${replace(each.key, "_", "-")} DLQ has messages — investigate failed processing"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.oneshot_alarm_actions
  ok_actions          = local.oneshot_alarm_actions

  dimensions = {
    QueueName = each.value.name
  }

  tags = merge(local.common_tags, {
    Service = "oneshot"
    Purpose = "dead-letter-queue-alarm"
  })
}

resource "aws_cloudwatch_metric_alarm" "oneshot_queue_age" {
  for_each = aws_sqs_queue.oneshot

  alarm_name          = "${var.environment}-oneshot-${replace(each.key, "_", "-")}-queue-age"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.oneshot_queue_age_alarm_threshold_seconds
  alarm_description   = "OneShot ${replace(each.key, "_", "-")} queue age is breaching the configured threshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.oneshot_alarm_actions
  ok_actions          = local.oneshot_alarm_actions

  dimensions = {
    QueueName = each.value.name
  }

  tags = merge(local.common_tags, {
    Service = "oneshot-${replace(each.key, "_", "-")}"
    Purpose = "queue-age-alarm"
  })
}

resource "aws_cloudwatch_metric_alarm" "oneshot_queue_depth" {
  for_each = aws_sqs_queue.oneshot

  alarm_name          = "${var.environment}-oneshot-${replace(each.key, "_", "-")}-queue-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.oneshot_queue_depth_alarm_threshold
  alarm_description   = "OneShot ${replace(each.key, "_", "-")} queue depth is breaching the configured threshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.oneshot_alarm_actions
  ok_actions          = local.oneshot_alarm_actions

  dimensions = {
    QueueName = each.value.name
  }

  tags = merge(local.common_tags, {
    Service = "oneshot-${replace(each.key, "_", "-")}"
    Purpose = "queue-depth-alarm"
  })
}

# ============================================================================
# CLOUDWATCH ALARMS — CONSUMER HEALTH
# ============================================================================
# These alarms detect consumer-side failures (crash loops, runaway tasks,
# resource exhaustion) that SQS queue metrics alone cannot surface. For
# example, a crash-looping consumer redelivers messages fast enough to keep
# queue age low while performing no real work.

resource "aws_cloudwatch_metric_alarm" "oneshot_cpu_high" {
  for_each = local.oneshot_consumers

  alarm_name          = "${var.environment}-oneshot-${each.key}-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = var.oneshot_consumer_cpu_alarm_threshold
  alarm_description   = "OneShot ${each.key} consumer CPU sustained above ${var.oneshot_consumer_cpu_alarm_threshold}% — investigate runaway task or resource exhaustion"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.oneshot_alarm_actions
  ok_actions          = local.oneshot_alarm_actions

  dimensions = {
    ClusterName = aws_ecs_cluster.specter.name
    ServiceName = aws_ecs_service.oneshot[each.key].name
  }

  tags = merge(local.common_tags, {
    Service = "oneshot-${each.key}"
    Purpose = "consumer-health-alarm"
  })
}

resource "aws_cloudwatch_metric_alarm" "oneshot_memory_high" {
  for_each = local.oneshot_consumers

  alarm_name          = "${var.environment}-oneshot-${each.key}-memory-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = var.oneshot_consumer_memory_alarm_threshold
  alarm_description   = "OneShot ${each.key} consumer memory sustained above ${var.oneshot_consumer_memory_alarm_threshold}% — risk of OOM kill"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.oneshot_alarm_actions
  ok_actions          = local.oneshot_alarm_actions

  dimensions = {
    ClusterName = aws_ecs_cluster.specter.name
    ServiceName = aws_ecs_service.oneshot[each.key].name
  }

  tags = merge(local.common_tags, {
    Service = "oneshot-${each.key}"
    Purpose = "consumer-health-alarm"
  })
}

resource "aws_cloudwatch_metric_alarm" "oneshot_running_tasks_low" {
  for_each = {
    for key, consumer in local.oneshot_consumers : key => consumer
    if consumer.desired_count > 0
  }

  alarm_name          = "${var.environment}-oneshot-${each.key}-running-tasks-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 300
  statistic           = "Minimum"
  threshold           = each.value.desired_count
  alarm_description   = "OneShot ${each.key} has fewer running tasks than desired (${each.value.desired_count}) for 15 minutes — possible crash loop"
  treat_missing_data  = "breaching"
  alarm_actions       = local.oneshot_alarm_actions
  ok_actions          = local.oneshot_alarm_actions

  dimensions = {
    ClusterName = aws_ecs_cluster.specter.name
    ServiceName = aws_ecs_service.oneshot[each.key].name
  }

  tags = merge(local.common_tags, {
    Service = "oneshot-${each.key}"
    Purpose = "consumer-health-alarm"
  })
}

# ============================================================================
# CLOUDWATCH LOG GROUPS
# ============================================================================

resource "aws_cloudwatch_log_group" "oneshot" {
  for_each = local.oneshot_consumers

  name              = "/ecs/specter/oneshot-${each.key}"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Service = "oneshot-${each.key}"
  })
}

# ============================================================================
# ECR REPOSITORY
# ============================================================================

resource "aws_ecr_repository" "oneshot" {
  count                = var.enable_oneshot ? 1 : 0
  name                 = "specter/oneshot"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Service = "oneshot"
  })
}

resource "aws_ecr_lifecycle_policy" "oneshot" {
  count      = var.enable_oneshot ? 1 : 0
  repository = aws_ecr_repository.oneshot[0].name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Keep only last 10 tagged images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v", "latest"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 3
        description  = "Expire images older than 30 days"
        selection = {
          tagStatus   = "any"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 30
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

data "aws_ecr_image" "oneshot" {
  count = var.enable_oneshot && var.oneshot_pin_image_by_digest ? 1 : 0

  repository_name = aws_ecr_repository.oneshot[0].name
  image_tag       = var.oneshot_image_tag

  depends_on = [aws_ecr_repository.oneshot]
}

# ============================================================================
# ECS TASK DEFINITIONS
# ============================================================================

resource "aws_ecs_task_definition" "oneshot" {
  for_each = local.oneshot_consumers

  family                   = "specter-oneshot-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = data.aws_iam_role.existing_task_role.arn

  dynamic "ephemeral_storage" {
    for_each = (
      var.oneshot_workspace_local_storage_gib != null
      ? [var.oneshot_workspace_local_storage_gib]
      : (
        var.oneshot_build_test_ephemeral_storage_gib != null &&
        contains(["implementer", "tester"], each.key)
      ) ? [var.oneshot_build_test_ephemeral_storage_gib] : []
    )
    content {
      size_in_gib = ephemeral_storage.value
    }
  }

  volume {
    name = "specter-repo"
    efs_volume_configuration {
      file_system_id     = var.existing_efs_id
      transit_encryption = "ENABLED"
      root_directory     = "/"
    }
  }

  lifecycle {
    precondition {
      condition     = trimspace(var.oneshot_comment_asset_base_url) != ""
      error_message = "oneshot_comment_asset_base_url must be set so OneShot Jira comments can include the required logo image."
    }

    precondition {
      condition     = trimspace(var.oneshot_dashboard_base_url) != ""
      error_message = "oneshot_dashboard_base_url must be set so the first OneShot Jira comment can link back to the dashboard pipeline."
    }

    precondition {
      condition     = var.oneshot_reviewer_enabled || trimspace(var.oneshot_reviewer_bypass_reason) != ""
      error_message = "Disabling the OneShot reviewer requires oneshot_reviewer_bypass_reason so the production runtime can start cleanly."
    }

    precondition {
      condition     = var.oneshot_code_reviewer_enabled || trimspace(var.oneshot_code_reviewer_bypass_reason) != ""
      error_message = "Disabling the OneShot code reviewer requires oneshot_code_reviewer_bypass_reason so the production runtime can start cleanly."
    }

    precondition {
      condition     = var.oneshot_reviewer_provider != "anthropic" || trimspace(var.oneshot_reviewer_model_id) != ""
      error_message = "oneshot_reviewer_model_id must be set when oneshot_reviewer_provider is 'anthropic' so the reviewer task can start cleanly."
    }

    precondition {
      condition     = var.oneshot_code_reviewer_provider != "anthropic" || trimspace(var.oneshot_code_reviewer_model_id) != ""
      error_message = "oneshot_code_reviewer_model_id must be set when oneshot_code_reviewer_provider is 'anthropic' so the code reviewer task can start cleanly."
    }

    precondition {
      condition     = local.oneshot_maven_config_complete
      error_message = "OneShot Maven support requires oneshot_maven_artifactory_host, a username source (oneshot_maven_user or oneshot_maven_user_secret_name), and oneshot_maven_password_secret_name to be set together when oneshot_maven_builds_enabled=true."
    }
  }

  container_definitions = jsonencode(concat([{
    name = "oneshot-${each.key}"
    image = (
      var.oneshot_pin_image_by_digest
      ? "${aws_ecr_repository.oneshot[0].repository_url}@${data.aws_ecr_image.oneshot[0].image_digest}"
      : "${aws_ecr_repository.oneshot[0].repository_url}:${var.oneshot_image_tag}"
    )

    dependsOn = var.oneshot_otel_enabled ? [
      {
        containerName = "ecs-cwagent"
        condition     = "START"
      }
    ] : []

    healthCheck = {
      command     = ["CMD-SHELL", "curl -fsS http://localhost:8080/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 120
    }

    mountPoints = [{
      sourceVolume  = "specter-repo"
      containerPath = "/mnt/efs/specter-repo"
      readOnly      = false
    }]

    environment = concat([
      { name = "NODE_ENV", value = "production" },
      { name = "ONESHOT_ROLE", value = each.value.role },
      { name = "DB_HOST", value = var.db_host },
      { name = "DB_PORT", value = var.db_port },
      { name = "DB_NAME", value = var.db_name },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "S3_BUCKET_PREFIX", value = "specter" },
      { name = "EFS_MOUNT_PATH", value = "/mnt/efs/specter-repo" },
      { name = "REPOSITORY_PATH", value = "/mnt/efs/specter-repo/repositories" },
      { name = "ONESHOT_REPO_ADMIN_BASE", value = "/mnt/efs/specter-repo/repo-admin" },
      { name = "ONESHOT_REPO_CACHE_BASE", value = "/mnt/efs/specter-repo/oneshot/repos" },
      { name = "ONESHOT_WORKTREE_BASE", value = "/var/oneshot/workspaces" },
      { name = "ONESHOT_ARTIFACT_BUCKET", value = aws_s3_bucket.results.bucket },
      { name = "ONESHOT_ARTIFACT_PREFIX", value = var.oneshot_artifact_prefix },
      { name = "ONESHOT_WORKSPACE_LEASE_TTL_SECONDS", value = tostring(var.oneshot_workspace_lease_ttl_seconds) },
      { name = "ONESHOT_WORKSPACE_LEASE_HEARTBEAT_SECONDS", value = tostring(var.oneshot_workspace_lease_heartbeat_seconds) },
      { name = "ONESHOT_REPO_CACHE_FRESHNESS_TTL_MS", value = tostring(var.oneshot_repo_cache_freshness_ttl_ms) },
      { name = "ONESHOT_MAVEN_BUILDS_ENABLED", value = tostring(var.oneshot_maven_builds_enabled) },
      { name = "ONESHOT_COMMENT_ASSET_BASE_URL", value = var.oneshot_comment_asset_base_url },
      { name = "ONESHOT_DASHBOARD_BASE_URL", value = var.oneshot_dashboard_base_url },
      { name = "ONESHOT_PROMPT_SOURCE", value = var.oneshot_prompt_source },
      { name = "ONESHOT_MAX_REVIEW_LOOPS", value = tostring(var.oneshot_max_review_loops) },
      { name = "ONESHOT_MAX_TOTAL_TOKENS", value = tostring(var.oneshot_max_total_tokens) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_PLANNING", value = tostring(var.oneshot_max_stage_tokens_planning) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_REVIEW", value = tostring(var.oneshot_max_stage_tokens_review) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_IMPLEMENTATION", value = tostring(var.oneshot_max_stage_tokens_implementation) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_CODE_REVIEW", value = tostring(var.oneshot_max_stage_tokens_code_review) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_TESTING", value = tostring(var.oneshot_max_stage_tokens_testing) },
      { name = "ONESHOT_RECONCILE_STALE_MINUTES", value = tostring(var.oneshot_reconcile_stale_minutes) },
      { name = "ONESHOT_REVIEWER_ENABLED", value = tostring(var.oneshot_reviewer_enabled) },
      { name = "ONESHOT_CODE_REVIEWER_ENABLED", value = tostring(var.oneshot_code_reviewer_enabled) },
      { name = "ONESHOT_TRACE_ENABLED", value = tostring(var.oneshot_trace_enabled) },
      { name = "ONESHOT_DOCS_SYNTHESIS_ENABLED", value = tostring(var.oneshot_docs_synthesis_enabled) },
      { name = "ONESHOT_TRACE_POST_TO_JIRA", value = tostring(var.oneshot_trace_post_to_jira) },
      { name = "ONESHOT_IMPLEMENTATION_PLAN_POST_TO_JIRA", value = tostring(var.oneshot_implementation_plan_post_to_jira) },
      { name = "ONESHOT_VERIFY_ENABLED", value = tostring(var.oneshot_verify_enabled) },
      { name = "ONESHOT_VERIFY_MODE", value = var.oneshot_verify_mode },
      { name = "ONESHOT_REVIEW_STAGES_BLOCK_ON_EXHAUSTION", value = tostring(var.oneshot_review_stages_block_on_exhaustion) },
      { name = "ONESHOT_HEALTHCARE_GUARDRAILS", value = tostring(var.oneshot_healthcare_guardrails_enabled) },
      { name = "ONESHOT_READINESS_ACTIVE_RISK_CATEGORIES", value = var.oneshot_readiness_active_risk_categories },
      { name = "ONESHOT_PLANNING_QUEUE_URL", value = aws_sqs_queue.oneshot["planning"].url },
      { name = "ONESHOT_REVIEW_QUEUE_URL", value = aws_sqs_queue.oneshot["review"].url },
      { name = "ONESHOT_IMPLEMENTATION_QUEUE_URL", value = aws_sqs_queue.oneshot["implementation"].url },
      { name = "ONESHOT_CODE_REVIEW_QUEUE_URL", value = aws_sqs_queue.oneshot["code_review"].url },
      { name = "ONESHOT_TESTING_QUEUE_URL", value = aws_sqs_queue.oneshot["testing"].url },
      { name = "ONESHOT_MAX_VERIFICATION_LOOPS", value = tostring(var.oneshot_max_verification_loops) },
      { name = "CLAUDE_CODE_USE_BEDROCK", value = "1" },
      { name = "ANTHROPIC_MODEL", value = var.bedrock_model_id },
      { name = "BEDROCK_MODEL", value = var.bedrock_model_id },
      { name = "CLAUDE_CODE_MAX_OUTPUT_TOKENS", value = tostring(var.oneshot_claude_code_max_output_tokens) },
      { name = "MAX_THINKING_TOKENS", value = tostring(var.oneshot_max_thinking_tokens) },
      { name = "OTEL_ENABLED", value = tostring(var.oneshot_otel_enabled) },
      { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.oneshot_otel_exporter_endpoint },
      { name = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", value = local.oneshot_otel_traces_endpoint },
      { name = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", value = local.oneshot_otel_metrics_endpoint },
      { name = "STATUS_PORT", value = "8080" },
      ], trimspace(var.oneshot_reviewer_bypass_reason) != "" ? [
      { name = "ONESHOT_REVIEWER_BYPASS_REASON", value = var.oneshot_reviewer_bypass_reason },
      ] : [],
      trimspace(var.oneshot_code_reviewer_bypass_reason) != "" ? [
        { name = "ONESHOT_CODE_REVIEWER_BYPASS_REASON", value = var.oneshot_code_reviewer_bypass_reason },
      ] : [],
      trimspace(var.oneshot_prompt_bucket) != "" ? [
        { name = "ONESHOT_PROMPT_BUCKET", value = var.oneshot_prompt_bucket },
      ] : [],
      trimspace(var.oneshot_prompt_manifest_key) != "" ? [
        { name = "ONESHOT_PROMPT_MANIFEST_KEY", value = var.oneshot_prompt_manifest_key },
      ] : [],
      trimspace(var.oneshot_prompt_manifest_version_id) != "" ? [
        { name = "ONESHOT_PROMPT_MANIFEST_VERSION_ID", value = var.oneshot_prompt_manifest_version_id },
      ] : [],
      each.key == "planner" && trimspace(var.oneshot_planner_model_id) != "" ? [
        { name = "ONESHOT_PLANNER_MODEL_ID", value = var.oneshot_planner_model_id },
      ] : [],
      each.key == "planner" ? [
        { name = "ONESHOT_PLANNER_MAX_OUTPUT_TOKENS", value = tostring(var.oneshot_planner_max_output_tokens) },
        { name = "ONESHOT_PLANNER_MAX_REPO_TOOL_CALLS", value = tostring(var.oneshot_planner_max_repo_tool_calls) },
        { name = "ONESHOT_PLANNER_MAX_TURNS", value = tostring(var.oneshot_planner_max_turns) },
        { name = "ONESHOT_PLANNER_CLAUDE_PERMISSION_MODE", value = var.oneshot_planner_claude_permission_mode },
        { name = "ONESHOT_PLANNER_CLAUDE_TOOL_VISIBILITY", value = var.oneshot_planner_claude_tool_visibility },
        { name = "ONESHOT_PLANNER_CLAUDE_TOOL_GUARD", value = var.oneshot_planner_claude_tool_guard },
        { name = "ONESHOT_PLANNER_TOOL_SPRAWL_GUARD", value = tostring(var.oneshot_planner_tool_sprawl_guard) },
        { name = "ONESHOT_PLANNER_SOFT_TEST_VALIDATION", value = "true" },
        { name = "ONESHOT_PLANNER_SKILLS_ENABLED", value = tostring(var.oneshot_planner_skills_enabled) },
        { name = "ONESHOT_PLANNER_SUBAGENTS_ENABLED", value = tostring(var.oneshot_planner_subagents_enabled) },
        { name = "ONESHOT_PLANNER_SUBAGENT_MAX_TURNS", value = tostring(var.oneshot_planner_subagent_max_turns) },
        { name = "ONESHOT_PLANNER_PLUGIN_PATH", value = var.oneshot_planner_plugin_path },
        { name = "ONESHOT_PLANNER_SCOUT_ENABLED", value = tostring(var.oneshot_planner_scout_enabled) },
        { name = "ONESHOT_PLANNER_SCOUT_MODEL_ID", value = var.oneshot_planner_scout_model_id },
      ] : [],
      (
        contains(["planner", "reviewer"], each.key) &&
        var.oneshot_trace_enabled &&
        var.oneshot_trace_post_to_jira
        ) || (
        each.key == "reviewer" &&
        var.oneshot_implementation_plan_post_to_jira
        ) ? [
        { name = "JIRA_BASE_URL", value = var.jira_base_url },
        { name = "JIRA_USERNAME", value = var.jira_username },
      ] : [],
      each.key == "implementer" ? [
        { name = "ONESHOT_IMPLEMENTER_MODEL_ID", value = trimspace(var.oneshot_implementer_model_id) },
        { name = "ONESHOT_IMPLEMENTER_MAX_OUTPUT_TOKENS", value = tostring(var.oneshot_implementer_max_output_tokens) },
        { name = "ONESHOT_IMPLEMENTER_MAX_TURNS", value = tostring(var.oneshot_implementer_max_turns) },
      ] : [],
      contains(["implementer", "tester"], each.key) && var.oneshot_maven_builds_enabled ? concat(
        trimspace(var.oneshot_maven_artifactory_host) != "" ? [
          { name = "ARTIFACTORY_HOST", value = trimspace(var.oneshot_maven_artifactory_host) },
        ] : [],
        trimspace(var.oneshot_maven_user) != "" && !local.oneshot_maven_user_secret_enabled ? [
          { name = "MAVEN_USER", value = trimspace(var.oneshot_maven_user) },
        ] : [],
        trimspace(var.oneshot_maven_cli_opts) != "" ? [
          { name = "MAVEN_CLI_OPTS", value = trimspace(var.oneshot_maven_cli_opts) },
        ] : [],
        trimspace(var.oneshot_maven_opts) != "" ? [
          { name = "MAVEN_OPTS", value = trimspace(var.oneshot_maven_opts) },
        ] : [],
      ) : [],
      each.key == "reviewer" ? concat(
        [
          { name = "ONESHOT_REVIEWER_PROVIDER", value = var.oneshot_reviewer_provider },
        ],
        var.oneshot_reviewer_provider == "openai" ? [
          { name = "OPENAI_REVIEWER_MODEL", value = "gpt-5.4" },
          { name = "OPENAI_REVIEWER_REASONING_EFFORT", value = "high" },
          { name = "OPENAI_MAX_TOOL_ITERATIONS", value = tostring(var.oneshot_openai_max_tool_iterations) },
        ] : [],
        trimspace(var.oneshot_reviewer_model_id) != "" ? [
          { name = "ONESHOT_REVIEWER_MODEL_ID", value = trimspace(var.oneshot_reviewer_model_id) },
        ] : [],
      ) : [],
      each.key == "code_reviewer" ? concat(
        [
          { name = "ONESHOT_CODE_REVIEWER_PROVIDER", value = var.oneshot_code_reviewer_provider },
        ],
        var.oneshot_code_reviewer_provider == "openai" ? [
          { name = "OPENAI_CODE_REVIEWER_MODEL", value = "gpt-5.4" },
          { name = "OPENAI_CODE_REVIEWER_REASONING_EFFORT", value = "high" },
          { name = "OPENAI_MAX_TOOL_ITERATIONS", value = tostring(var.oneshot_openai_max_tool_iterations) },
        ] : [],
        trimspace(var.oneshot_code_reviewer_model_id) != "" ? [
          { name = "ONESHOT_CODE_REVIEWER_MODEL_ID", value = trimspace(var.oneshot_code_reviewer_model_id) },
        ] : [],
    ) : [])

    secrets = concat([
      {
        name      = "DB_USER"
        valueFrom = "${data.aws_secretsmanager_secret.db_credentials.arn}:username::"
      },
      {
        name      = "DB_PASSWORD"
        valueFrom = "${data.aws_secretsmanager_secret.db_credentials.arn}:password::"
      },
      {
        name      = "GITHUB_REPO_TOKEN"
        valueFrom = data.aws_secretsmanager_secret.github_repo_token.arn
      }
      ],
      (
        (each.key == "reviewer" && var.oneshot_reviewer_provider == "openai") ||
        (each.key == "code_reviewer" && var.oneshot_code_reviewer_provider == "openai")
        ) ? [
        {
          name      = "OPENAI_API_KEY"
          valueFrom = data.aws_secretsmanager_secret.openai_reviewer_api_key[0].arn
        }
      ] : [],
      (
        contains(["planner", "reviewer"], each.key) &&
        var.oneshot_trace_enabled &&
        var.oneshot_trace_post_to_jira
        ) || (
        each.key == "reviewer" &&
        var.oneshot_implementation_plan_post_to_jira
        ) ? [
        {
          name      = "JIRA_TOKEN"
          valueFrom = data.aws_secretsmanager_secret.jira_token.arn
        }
      ] : [],
      contains(["implementer", "code_reviewer", "tester"], each.key) && !local.oneshot_github_app_credentials_secret_enabled ? [
        {
          name      = "GITHUB_WRITE_TOKEN"
          valueFrom = data.aws_secretsmanager_secret.github_write_token[0].arn
        }
      ] : [],
      local.oneshot_github_app_credentials_secret_enabled ? [
        {
          name      = "GITHUB_APP_CREDENTIALS"
          valueFrom = data.aws_secretsmanager_secret.github_app_credentials[0].arn
        }
      ] : [],
      contains(["implementer", "tester"], each.key) && local.oneshot_maven_credentials_enabled ? [
        {
          name = "MAVEN_PASSWORD"
          valueFrom = (trimspace(var.oneshot_maven_password_secret_json_key) != ""
            ? "${data.aws_secretsmanager_secret.oneshot_maven_password[0].arn}:${trimspace(var.oneshot_maven_password_secret_json_key)}::"
            : data.aws_secretsmanager_secret.oneshot_maven_password[0].arn
          )
        }
      ] : [],
      contains(["implementer", "tester"], each.key) && local.oneshot_maven_user_secret_enabled ? [
        {
          name = "MAVEN_USER"
          valueFrom = (trimspace(var.oneshot_maven_user_secret_json_key) != ""
            ? "${data.aws_secretsmanager_secret.oneshot_maven_user[0].arn}:${trimspace(var.oneshot_maven_user_secret_json_key)}::"
            : data.aws_secretsmanager_secret.oneshot_maven_user[0].arn
          )
        }
    ] : [])

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.oneshot[each.key].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "oneshot-${each.key}"
      }
    }
    }], var.oneshot_otel_enabled ? [{
    name              = "ecs-cwagent"
    image             = var.oneshot_otel_sidecar_image
    cpu               = 64
    essential         = false
    memoryReservation = 128

    secrets = [
      {
        name      = "CW_CONFIG_CONTENT"
        valueFrom = aws_ssm_parameter.oneshot_cwagent_config[0].arn
      },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.oneshot[each.key].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "otel-${each.key}"
      }
    }
  }] : []))

  tags = merge(local.common_tags, {
    Service = "oneshot-${each.key}"
  })
}

# ============================================================================
# ECS SERVICES
# ============================================================================

resource "aws_ecs_service" "oneshot" {
  for_each = local.oneshot_consumers

  name            = upper(each.key)
  cluster         = aws_ecs_cluster.specter.id
  task_definition = aws_ecs_task_definition.oneshot[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  tags = merge(local.common_tags, {
    Service = upper(each.key)
  })
}

# ============================================================================
# AUTO-SCALING
# ============================================================================
# Scale oneshot consumer ECS services based on SQS backlog so that bursts of
# tickets automatically drive scale-out without operator intervention. Each
# consumer key maps to its upstream SQS queue via local.oneshot_consumer_queue.
# min_capacity is pinned to the configured desired_count so stages with
# desired_count=0 stay off until an operator enables them.

locals {
  # Maps oneshot consumer keys (in local.oneshot_consumers) to their upstream
  # SQS queue keys (in aws_sqs_queue.oneshot). The two sets differ because the
  # queues are named for the pipeline stage while the consumers are named for
  # the role that processes them.
  oneshot_consumer_queue = {
    planner       = "planning"
    reviewer      = "review"
    implementer   = "implementation"
    code_reviewer = "code_review"
    tester        = "testing"
  }
}

resource "aws_appautoscaling_target" "oneshot" {
  for_each = local.oneshot_consumers

  max_capacity       = lookup(var.oneshot_autoscaling_max_capacity, each.key, 5)
  min_capacity       = each.value.desired_count
  resource_id        = "service/${aws_ecs_cluster.specter.name}/${aws_ecs_service.oneshot[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "oneshot_scale_out" {
  for_each = local.oneshot_consumers

  name               = "${var.environment}-oneshot-${each.key}-scale-out"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.oneshot[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.oneshot[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.oneshot[each.key].service_namespace

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 120
    metric_aggregation_type = "Maximum"

    # +1 task when 2-5 messages waiting
    step_adjustment {
      metric_interval_lower_bound = 0
      metric_interval_upper_bound = 3
      scaling_adjustment          = 1
    }
    # +2 tasks when 5-15 messages waiting
    step_adjustment {
      metric_interval_lower_bound = 3
      metric_interval_upper_bound = 13
      scaling_adjustment          = 2
    }
    # +3 tasks when 15+ messages waiting
    step_adjustment {
      metric_interval_lower_bound = 13
      scaling_adjustment          = 3
    }
  }
}

resource "aws_appautoscaling_policy" "oneshot_scale_in" {
  for_each = local.oneshot_consumers

  name               = "${var.environment}-oneshot-${each.key}-scale-in"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.oneshot[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.oneshot[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.oneshot[each.key].service_namespace

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 600
    metric_aggregation_type = "Maximum"

    # -1 task when queue is empty for the alarm period
    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "oneshot_scale_out_alarm" {
  for_each = local.oneshot_consumers

  alarm_name          = "${var.environment}-oneshot-${each.key}-scale-out-trigger"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 2
  alarm_description   = "Trigger scale-out for oneshot ${each.key} when queue has >=2 messages"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.oneshot_scale_out[each.key].arn]

  dimensions = {
    QueueName = aws_sqs_queue.oneshot[local.oneshot_consumer_queue[each.key]].name
  }

  tags = merge(local.common_tags, {
    Service = "oneshot-${each.key}"
    Purpose = "autoscale-scale-out"
  })
}

resource "aws_cloudwatch_metric_alarm" "oneshot_scale_in_alarm" {
  for_each = local.oneshot_consumers

  alarm_name          = "${var.environment}-oneshot-${each.key}-scale-in-trigger"
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 5
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Trigger scale-in for oneshot ${each.key} when queue has been empty for 5 minutes"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.oneshot_scale_in[each.key].arn]

  dimensions = {
    QueueName = aws_sqs_queue.oneshot[local.oneshot_consumer_queue[each.key]].name
  }

  tags = merge(local.common_tags, {
    Service = "oneshot-${each.key}"
    Purpose = "autoscale-scale-in"
  })
}
