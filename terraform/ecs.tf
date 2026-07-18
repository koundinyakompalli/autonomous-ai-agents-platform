# Specter ECS Configuration
# ECS Cluster, Task Definitions, and Services

# ============================================================================
# ECS CLUSTER
# ============================================================================

resource "aws_ecs_cluster" "specter" {
  name = "specter-cluster"

  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }

  tags = merge(local.common_tags, {
    Name = "specter-cluster"
  })
}

# ============================================================================
# CLOUDWATCH LOG GROUPS
# ============================================================================

resource "aws_cloudwatch_log_group" "orchestrator" {
  name              = "/ecs/specter/orchestrator"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Service = "orchestrator"
  })
}

resource "aws_cloudwatch_log_group" "workers" {
  for_each = local.all_worker_agents

  name              = "/ecs/specter/${each.key}-worker"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Service = "${each.key}-worker"
  })
}

# ============================================================================
# ECR REPOSITORIES
# ============================================================================

resource "aws_ecr_repository" "orchestrator" {
  name                 = "specter/orchestrator"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Service = "orchestrator"
  })
}

resource "aws_ecr_repository" "workers" {
  for_each = local.all_worker_agents

  name                 = "specter/${each.key}-worker"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Service = "${each.key}-worker"
  })
}

# ECR Lifecycle Policies - expire images after 30 days except currently used
resource "aws_ecr_lifecycle_policy" "orchestrator" {
  repository = aws_ecr_repository.orchestrator.name

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

resource "aws_ecr_lifecycle_policy" "workers" {
  for_each   = aws_ecr_repository.workers
  repository = each.value.name

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

data "aws_ecr_image" "workers" {
  for_each = var.worker_pin_image_by_digest ? aws_ecr_repository.workers : {}

  repository_name = each.value.name
  image_tag       = var.worker_image_tag
}

# ============================================================================
# ECS TASK DEFINITIONS
# ============================================================================

# Orchestrator Task Definition
resource "aws_ecs_task_definition" "orchestrator" {
  family                   = "specter-orchestrator"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.orchestrator_cpu
  memory                   = var.orchestrator_memory
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = data.aws_iam_role.existing_task_role.arn

  lifecycle {
    precondition {
      condition     = !var.enable_oneshot || trimspace(var.oneshot_comment_asset_base_url) != ""
      error_message = "oneshot_comment_asset_base_url must be set when OneShot is enabled so Jira comments can include the required logo image."
    }

    precondition {
      condition     = !var.enable_oneshot || trimspace(var.oneshot_dashboard_base_url) != ""
      error_message = "oneshot_dashboard_base_url must be set when OneShot is enabled so the first Jira comment can link to the dashboard pipeline."
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

  container_definitions = jsonencode([{
    name  = "orchestrator"
    image = "${aws_ecr_repository.orchestrator.repository_url}:latest"

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:8080/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    mountPoints = [{
      sourceVolume  = "specter-repo"
      containerPath = "/mnt/efs/specter-repo"
      readOnly      = false
    }]

    environment = concat([
      { name = "NODE_ENV", value = "production" },
      { name = "DB_HOST", value = var.db_host },
      { name = "DB_PORT", value = var.db_port },
      { name = "DB_NAME", value = var.db_name },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "S3_BUCKET_PREFIX", value = "specter" },
      { name = "JIRA_BASE_URL", value = var.jira_base_url },
      { name = "JIRA_USERNAME", value = var.jira_username },
      { name = "JIRA_POLLING_ENABLED", value = "true" },
      { name = "JIRA_POLLING_INTERVAL_MS", value = tostring(var.jira_polling_interval_ms) },
      { name = "RESULT_CHECK_INTERVAL_MS", value = tostring(var.result_check_interval_ms) },
      { name = "AUTO_REASSIGN_TICKETS", value = "false" },
      { name = "EFS_MOUNT_PATH", value = "/mnt/efs/specter-repo" },
      { name = "BEDROCK_MODEL", value = var.bedrock_model_id },
      ], var.enable_oneshot ? [
      { name = "ONESHOT_ARTIFACT_BUCKET", value = aws_s3_bucket.results.bucket },
      { name = "ONESHOT_ARTIFACT_PREFIX", value = var.oneshot_artifact_prefix },
      { name = "ONESHOT_WORKSPACE_LEASE_TTL_SECONDS", value = tostring(var.oneshot_workspace_lease_ttl_seconds) },
      { name = "ONESHOT_WORKSPACE_LEASE_HEARTBEAT_SECONDS", value = tostring(var.oneshot_workspace_lease_heartbeat_seconds) },
      { name = "ONESHOT_REPO_CACHE_FRESHNESS_TTL_MS", value = tostring(var.oneshot_repo_cache_freshness_ttl_ms) },
      { name = "ONESHOT_COMMENT_ASSET_BASE_URL", value = var.oneshot_comment_asset_base_url },
      { name = "ONESHOT_DASHBOARD_BASE_URL", value = var.oneshot_dashboard_base_url },
      { name = "ONESHOT_TARGET_REPO_FIELD_ID", value = var.oneshot_target_repo_field_id },
      { name = "ONESHOT_DESCRIPTION_REPO_DIRECTIVE_MODE", value = var.oneshot_description_repo_directive_mode },
      { name = "ONESHOT_GITHUB_REPO_OWNERS", value = var.oneshot_github_repo_owners },
      { name = "ONESHOT_MAX_REVIEW_LOOPS", value = tostring(var.oneshot_max_review_loops) },
      { name = "ONESHOT_MAX_TOTAL_TOKENS", value = tostring(var.oneshot_max_total_tokens) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_PLANNING", value = tostring(var.oneshot_max_stage_tokens_planning) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_REVIEW", value = tostring(var.oneshot_max_stage_tokens_review) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_IMPLEMENTATION", value = tostring(var.oneshot_max_stage_tokens_implementation) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_CODE_REVIEW", value = tostring(var.oneshot_max_stage_tokens_code_review) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_TESTING", value = tostring(var.oneshot_max_stage_tokens_testing) },
      { name = "ONESHOT_RECONCILE_STALE_MINUTES", value = tostring(var.oneshot_reconcile_stale_minutes) },
      { name = "ONESHOT_DOCS_SYNTHESIS_ENABLED", value = tostring(var.oneshot_docs_synthesis_enabled) },
      { name = "ONESHOT_PLANNING_QUEUE_URL", value = aws_sqs_queue.oneshot["planning"].url },
      { name = "ONESHOT_REVIEW_QUEUE_URL", value = aws_sqs_queue.oneshot["review"].url },
      { name = "ONESHOT_IMPLEMENTATION_QUEUE_URL", value = aws_sqs_queue.oneshot["implementation"].url },
    ] : [])

    secrets = [
      {
        name      = "DB_USER"
        valueFrom = "${data.aws_secretsmanager_secret.db_credentials.arn}:username::"
      },
      {
        name      = "DB_PASSWORD"
        valueFrom = "${data.aws_secretsmanager_secret.db_credentials.arn}:password::"
      },
      {
        name      = "JIRA_TOKEN"
        valueFrom = data.aws_secretsmanager_secret.jira_token.arn
      },
      {
        name      = "GITHUB_REPO_TOKEN"
        valueFrom = data.aws_secretsmanager_secret.github_repo_token.arn
      }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.orchestrator.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "orchestrator"
      }
    }
  }])

  tags = merge(local.common_tags, {
    Service = "orchestrator"
  })
}

# Worker Task Definitions (one for each agent)
resource "aws_ecs_task_definition" "workers" {
  for_each = local.all_worker_agents

  family                   = "specter-${each.key}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = data.aws_iam_role.existing_task_role.arn

  lifecycle {
    precondition {
      condition     = each.key != "qualifier" || !var.enable_oneshot || trimspace(var.oneshot_comment_asset_base_url) != ""
      error_message = "oneshot_comment_asset_base_url must be set when OneShot is enabled so Jira comments can include the required logo image."
    }

    precondition {
      condition     = each.key != "qualifier" || !var.enable_oneshot || trimspace(var.oneshot_dashboard_base_url) != ""
      error_message = "oneshot_dashboard_base_url must be set when OneShot is enabled so the first Jira comment can link to the dashboard pipeline."
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

  container_definitions = jsonencode(concat([{
    name = "${each.key}-worker"
    image = (
      var.worker_pin_image_by_digest
      ? "${aws_ecr_repository.workers[each.key].repository_url}@${data.aws_ecr_image.workers[each.key].image_digest}"
      : "${aws_ecr_repository.workers[each.key].repository_url}:${var.worker_image_tag}"
    )

    dependsOn = each.key == "qualifier" && var.enable_oneshot && var.oneshot_otel_enabled ? [
      {
        containerName = "ecs-cwagent"
        condition     = "START"
      }
    ] : []

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:8080/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    mountPoints = [{
      sourceVolume  = "specter-repo"
      containerPath = "/mnt/efs/specter-repo"
      readOnly      = false
    }]

    environment = concat([
      { name = "NODE_ENV", value = "production" },
      { name = "WORKER_TYPE", value = upper(each.key) }, # Required by worker-main.ts
      { name = "AGENT_NAME", value = upper(each.key) },  # Also set for compatibility
      { name = "DB_HOST", value = var.db_host },
      { name = "DB_PORT", value = var.db_port },
      { name = "DB_NAME", value = var.db_name },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "S3_BUCKET_PREFIX", value = "specter" },
      { name = "EFS_MOUNT_PATH", value = "/mnt/efs/specter-repo" },
      { name = "REPOSITORY_PATH", value = "/mnt/efs/specter-repo/repositories" },
      { name = "SHARED_REPOSITORY_PATH", value = "/mnt/efs/specter-repo/repositories" },
      { name = "WORKER_POLLING_INTERVAL_MS", value = tostring(var.worker_polling_interval_ms) },
      # JIRA configuration (needed by BEACON worker for attachments & comments)
      { name = "JIRA_BASE_URL", value = var.jira_base_url },
      { name = "JIRA_USERNAME", value = var.jira_username },
      # BCAT Agent configuration (custom field IDs)
      { name = "BCAT_APPROVER_FIELD", value = "customfield_10003" },     # Approvers field
      { name = "BCAT_REQUEST_TYPE_FIELD", value = "customfield_10010" }, # Request Type field
      { name = "BCAT_TARGET_PROJECT", value = "CPSUP" },
      # Claude Agent SDK environment variables
      { name = "CLAUDE_CODE_USE_BEDROCK", value = "1" },
      { name = "ANTHROPIC_MODEL", value = each.key == "qualifier" && trimspace(var.qualifier_model_id) != "" ? trimspace(var.qualifier_model_id) : var.bedrock_model_id },
      { name = "BEDROCK_MODEL", value = each.key == "qualifier" && trimspace(var.qualifier_model_id) != "" ? trimspace(var.qualifier_model_id) : var.bedrock_model_id }, # For orchestrator LLM calls
      { name = "CLAUDE_CODE_MAX_OUTPUT_TOKENS", value = tostring(var.worker_claude_code_max_output_tokens) },
      { name = "MAX_THINKING_TOKENS", value = tostring(var.worker_max_thinking_tokens) },
      ], var.enable_oneshot ? [
      { name = "ONESHOT_ARTIFACT_BUCKET", value = aws_s3_bucket.results.bucket },
      { name = "ONESHOT_ARTIFACT_PREFIX", value = var.oneshot_artifact_prefix },
      { name = "ONESHOT_MAX_REVIEW_LOOPS", value = tostring(var.oneshot_max_review_loops) },
      { name = "ONESHOT_MAX_TOTAL_TOKENS", value = tostring(var.oneshot_max_total_tokens) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_PLANNING", value = tostring(var.oneshot_max_stage_tokens_planning) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_REVIEW", value = tostring(var.oneshot_max_stage_tokens_review) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_IMPLEMENTATION", value = tostring(var.oneshot_max_stage_tokens_implementation) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_CODE_REVIEW", value = tostring(var.oneshot_max_stage_tokens_code_review) },
      { name = "ONESHOT_MAX_STAGE_TOKENS_TESTING", value = tostring(var.oneshot_max_stage_tokens_testing) },
      { name = "ONESHOT_RECONCILE_STALE_MINUTES", value = tostring(var.oneshot_reconcile_stale_minutes) },
      { name = "ONESHOT_PLANNING_QUEUE_URL", value = aws_sqs_queue.oneshot["planning"].url },
      { name = "ONESHOT_REVIEW_QUEUE_URL", value = aws_sqs_queue.oneshot["review"].url },
      { name = "ONESHOT_IMPLEMENTATION_QUEUE_URL", value = aws_sqs_queue.oneshot["implementation"].url },
      { name = "ONESHOT_REPO_ADMIN_BASE", value = "/mnt/efs/specter-repo/repo-admin" },
      { name = "ONESHOT_REPO_CACHE_BASE", value = "/mnt/efs/specter-repo/oneshot/repos" },
      { name = "ONESHOT_WORKTREE_BASE", value = "/var/oneshot/workspaces" },
      { name = "ONESHOT_WORKSPACE_LEASE_TTL_SECONDS", value = tostring(var.oneshot_workspace_lease_ttl_seconds) },
      { name = "ONESHOT_WORKSPACE_LEASE_HEARTBEAT_SECONDS", value = tostring(var.oneshot_workspace_lease_heartbeat_seconds) },
      { name = "ONESHOT_REPO_CACHE_FRESHNESS_TTL_MS", value = tostring(var.oneshot_repo_cache_freshness_ttl_ms) },
      ] : [],
      each.key == "qualifier" && var.enable_oneshot ? [
        { name = "ONESHOT_COMMENT_ASSET_BASE_URL", value = var.oneshot_comment_asset_base_url },
        { name = "ONESHOT_DASHBOARD_BASE_URL", value = var.oneshot_dashboard_base_url },
        { name = "ONESHOT_DESCRIPTION_REPO_DIRECTIVE_MODE", value = var.oneshot_description_repo_directive_mode },
        { name = "ONESHOT_GITHUB_REPO_OWNERS", value = var.oneshot_github_repo_owners },
        { name = "ONESHOT_MULTI_REPO_ENABLED", value = tostring(var.oneshot_multi_repo_enabled) },
        { name = "OTEL_ENABLED", value = tostring(var.oneshot_otel_enabled) },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.oneshot_otel_exporter_endpoint },
        { name = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", value = local.oneshot_otel_traces_endpoint },
        { name = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", value = local.oneshot_otel_metrics_endpoint },
    ] : [])

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
        name      = "JIRA_TOKEN"
        valueFrom = data.aws_secretsmanager_secret.jira_token.arn
      },
      {
        name      = "GITHUB_REPO_TOKEN"
        valueFrom = data.aws_secretsmanager_secret.github_repo_token.arn
      }
      ],
      each.key == "qualifier" && local.oneshot_github_app_credentials_secret_enabled ? [
        {
          name      = "GITHUB_APP_CREDENTIALS"
          valueFrom = data.aws_secretsmanager_secret.github_app_credentials[0].arn
        }
    ] : [])

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.workers[each.key].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = each.key
      }
    }
    }], each.key == "qualifier" && var.enable_oneshot && var.oneshot_otel_enabled ? [{
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
        "awslogs-group"         = aws_cloudwatch_log_group.workers[each.key].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "otel-${each.key}"
      }
    }
  }] : []))

  tags = merge(local.common_tags, {
    Service = "${each.key}-worker"
  })
}

# ============================================================================
# ECS SERVICES
# ============================================================================

# Orchestrator Service
resource "aws_ecs_service" "orchestrator" {
  name            = "ORCHESTRATOR"
  cluster         = aws_ecs_cluster.specter.id
  task_definition = aws_ecs_task_definition.orchestrator.arn
  desired_count   = var.orchestrator_desired_count
  launch_type     = "FARGATE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true # Required for internet access to JIRA API
  }

  tags = merge(local.common_tags, {
    Service = "ORCHESTRATOR"
  })
}

# Worker Services
resource "aws_ecs_service" "workers" {
  for_each = local.all_worker_agents

  name            = upper(each.key)
  cluster         = aws_ecs_cluster.specter.id
  task_definition = aws_ecs_task_definition.workers[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true # Required for internet access (git clones, AWS APIs)
  }

  tags = merge(local.common_tags, {
    Service = upper(each.key)
  })
}

# ============================================================================
# SECURITY GROUP FOR ECS TASKS
# ============================================================================

resource "aws_security_group" "ecs_tasks" {
  name        = "specter-ecs-tasks"
  description = "Security group for Specter ECS tasks"
  vpc_id      = local.vpc_id

  # Outbound - allow all (for S3, Bedrock, git clones)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "specter-ecs-tasks"
  })
}

# Add ECS security group to EFS security group ingress
resource "aws_security_group_rule" "efs_from_ecs" {
  type                     = "ingress"
  from_port                = 2049
  to_port                  = 2049
  protocol                 = "tcp"
  security_group_id        = var.existing_efs_security_group_id
  source_security_group_id = aws_security_group.ecs_tasks.id
  description              = "NFS from Specter ECS tasks"
}
