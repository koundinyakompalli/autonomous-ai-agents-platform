# Spec Factory ECS Configuration
# Louise-to-OneShot Epic composition service.

# ============================================================================
# ECR REPOSITORY
# ============================================================================

resource "aws_ecr_repository" "spec_factory" {
  #checkov:skip=CKV_AWS_51:Commit-SHA tags are immutable and Terraform resolves the deployed image digest explicitly.
  #checkov:skip=CKV_AWS_136:Repository uses the account default encryption posture; customer-managed KMS is outside this Spec Factory rollout.
  count                = var.enable_spec_factory ? 1 : 0
  name                 = "specter/spec-factory"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Service = "spec-factory"
  })
}

resource "aws_ecr_repository" "spec_factory_runtime" {
  for_each = var.enable_spec_factory ? toset(["api", "research", "conversion"]) : toset([])

  name                 = "specter/spec-factory-${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration { scan_on_push = true }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.spec_factory_data[0].arn
  }

  tags = merge(local.common_tags, {
    Service = "spec-factory-${each.key}"
  })
}

resource "aws_ecr_lifecycle_policy" "spec_factory_runtime" {
  for_each   = aws_ecr_repository.spec_factory_runtime
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the latest 50 immutable commit images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 50
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "spec_factory" {
  count      = var.enable_spec_factory ? 1 : 0
  repository = aws_ecr_repository.spec_factory[0].name

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
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only last 50 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 50
        }
        action = { type = "expire" }
      }
    ]
  })
}

resource "aws_ecr_repository" "compose_markitdown" {
  #checkov:skip=CKV_AWS_51:Commit-SHA tags are immutable and Terraform resolves the deployed image digest explicitly.
  #checkov:skip=CKV_AWS_136:Repository uses the account default encryption posture; customer-managed KMS is outside this Spec Factory rollout.
  count                = var.enable_spec_factory ? 1 : 0
  name                 = "specter/compose-markitdown"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Service = "compose-markitdown"
  })
}

locals {
  spec_factory_runtime_repositories = var.enable_spec_factory ? {
    api        = aws_ecr_repository.spec_factory_runtime["api"]
    core       = aws_ecr_repository.spec_factory[0]
    research   = aws_ecr_repository.spec_factory_runtime["research"]
    conversion = aws_ecr_repository.spec_factory_runtime["conversion"]
  } : {}
}

data "aws_ecr_image" "spec_factory_runtime" {
  for_each = var.enable_spec_factory && var.spec_factory_pin_image_by_digest ? local.spec_factory_runtime_repositories : {}

  repository_name = each.value.name
  image_tag       = var.spec_factory_image_tag
}

data "aws_ecr_image" "compose_markitdown" {
  count = var.enable_spec_factory && var.spec_factory_pin_image_by_digest ? 1 : 0

  repository_name = aws_ecr_repository.compose_markitdown[0].name
  image_tag       = var.spec_factory_image_tag
}

locals {
  spec_factory_runtime_images = var.enable_spec_factory ? {
    for role, repository in local.spec_factory_runtime_repositories : role => (
      var.spec_factory_pin_image_by_digest
      ? "${repository.repository_url}@${data.aws_ecr_image.spec_factory_runtime[role].image_digest}"
      : "${repository.repository_url}:${var.spec_factory_image_tag}"
    )
  } : {}
  compose_markitdown_image = var.enable_spec_factory ? (
    var.spec_factory_pin_image_by_digest
    ? "${aws_ecr_repository.compose_markitdown[0].repository_url}@${data.aws_ecr_image.compose_markitdown[0].image_digest}"
    : "${aws_ecr_repository.compose_markitdown[0].repository_url}:${var.spec_factory_image_tag}"
  ) : ""
}

resource "aws_ecr_lifecycle_policy" "compose_markitdown" {
  count      = var.enable_spec_factory ? 1 : 0
  repository = aws_ecr_repository.compose_markitdown[0].name

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
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only last 50 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 50
        }
        action = { type = "expire" }
      }
    ]
  })
}

# ============================================================================
# DURABLE WORK QUEUES
# ============================================================================

locals {
  spec_factory_queue_visibility_seconds = {
    turn       = 900
    context    = 900
    research   = 1200
    conversion = 1200
    draft      = 1800
    events     = 120
  }
}

resource "aws_sqs_queue" "spec_factory_dlq" {
  for_each = var.enable_spec_factory ? local.spec_factory_queue_visibility_seconds : {}

  name                       = "${var.environment}-spec-factory-${each.key}-dlq"
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = each.value
  sqs_managed_sse_enabled    = true

  tags = merge(local.common_tags, {
    Service = "spec-factory-${each.key}"
    Purpose = "dead-letter-queue"
  })
}

resource "aws_sqs_queue" "spec_factory" {
  for_each = var.enable_spec_factory ? local.spec_factory_queue_visibility_seconds : {}

  name                       = "${var.environment}-spec-factory-${each.key}"
  message_retention_seconds  = 345600
  visibility_timeout_seconds = each.value
  sqs_managed_sse_enabled    = true
  receive_wait_time_seconds  = 20
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.spec_factory_dlq[each.key].arn
    maxReceiveCount     = 5
  })

  tags = merge(local.common_tags, {
    Service = "spec-factory-${each.key}"
  })
}

resource "aws_sqs_queue" "spec_factory_quarantine" {
  count = var.enable_spec_factory ? 1 : 0

  name                      = "${var.environment}-spec-factory-quarantine"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true

  tags = merge(local.common_tags, {
    Service = "spec-factory"
    Purpose = "unsupported-message-quarantine"
  })
}

resource "aws_cloudwatch_metric_alarm" "spec_factory_quarantine_depth" {
  count = var.enable_spec_factory ? 1 : 0

  alarm_name          = "${var.environment}-spec-factory-quarantine-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Spec Factory quarantine contains unsupported queue messages"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.spec_factory_alarm_actions
  ok_actions          = local.spec_factory_alarm_actions

  dimensions = { QueueName = aws_sqs_queue.spec_factory_quarantine[0].name }
}

resource "aws_cloudwatch_metric_alarm" "spec_factory_dlq_depth" {
  for_each = aws_sqs_queue.spec_factory_dlq

  alarm_name          = "${var.environment}-spec-factory-${each.key}-dlq-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Spec Factory ${each.key} DLQ contains failed work"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.spec_factory_alarm_actions
  ok_actions          = local.spec_factory_alarm_actions

  dimensions = { QueueName = each.value.name }
}

resource "aws_cloudwatch_metric_alarm" "spec_factory_queue_age" {
  for_each = aws_sqs_queue.spec_factory

  alarm_name          = "${var.environment}-spec-factory-${each.key}-queue-age"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = each.key == "turn" ? 30 : 300
  alarm_description   = "Spec Factory ${each.key} queue age exceeds its SLO"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.spec_factory_alarm_actions
  ok_actions          = local.spec_factory_alarm_actions

  dimensions = { QueueName = each.value.name }
}

# ============================================================================
# CLOUDWATCH LOG GROUP
# ============================================================================

resource "aws_cloudwatch_log_group" "spec_factory" {
  count             = var.enable_spec_factory ? 1 : 0
  name              = "/ecs/specter/spec-factory"
  retention_in_days = var.spec_factory_log_retention_days
  kms_key_id        = aws_kms_key.spec_factory_data[0].arn

  tags = merge(local.common_tags, {
    Service = "spec-factory"
  })
}

# ============================================================================
# ALB TARGET GROUP
# ============================================================================

resource "aws_lb_target_group" "spec_factory" {
  #checkov:skip=CKV_AWS_378:This is the internal target group behind the HTTPS dashboard ALB listener; container health and traffic use HTTP on port 3012.
  count       = var.enable_spec_factory ? 1 : 0
  name        = "specter-spec-factory-tg"
  port        = 3012
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health"
    port                = "3012"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  deregistration_delay = 30

  tags = merge(local.common_tags, {
    Name    = "specter-spec-factory-tg"
    Service = "spec-factory"
  })
}

# ============================================================================
# SECURITY GROUPS
# ============================================================================

resource "aws_security_group" "spec_factory_tasks" {
  #checkov:skip=CKV2_AWS_5:The security group is attached to conditional ECS services; Checkov does not resolve the count/for_each attachment reliably here.
  count       = var.enable_spec_factory ? 1 : 0
  name        = "specter-spec-factory-tasks"
  description = "Security group for Spec Factory ECS tasks"
  vpc_id      = local.vpc_id

  ingress {
    description     = "From Dashboard ALB on port 3012"
    from_port       = 3012
    to_port         = 3012
    protocol        = "tcp"
    security_groups = [aws_security_group.dashboard_alb.id]
  }

  tags = merge(local.common_tags, {
    Name    = "specter-spec-factory-tasks"
    Service = "spec-factory"
  })
}

resource "aws_security_group_rule" "spec_factory_https_egress" {
  count             = var.enable_spec_factory ? 1 : 0
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  security_group_id = aws_security_group.spec_factory_tasks[0].id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "TLS to AWS APIs and approved external HTTPS services"
}

resource "aws_security_group_rule" "spec_factory_dns_udp_egress" {
  count             = var.enable_spec_factory ? 1 : 0
  type              = "egress"
  from_port         = 53
  to_port           = 53
  protocol          = "udp"
  security_group_id = aws_security_group.spec_factory_tasks[0].id
  cidr_blocks       = [data.aws_vpc.existing.cidr_block]
  description       = "UDP DNS inside the VPC"
}

resource "aws_security_group_rule" "spec_factory_dns_tcp_egress" {
  count             = var.enable_spec_factory ? 1 : 0
  type              = "egress"
  from_port         = 53
  to_port           = 53
  protocol          = "tcp"
  security_group_id = aws_security_group.spec_factory_tasks[0].id
  cidr_blocks       = [data.aws_vpc.existing.cidr_block]
  description       = "TCP DNS fallback inside the VPC"
}

resource "aws_security_group_rule" "spec_factory_rds_egress" {
  count                    = var.enable_spec_factory && !var.spec_factory_aurora_enabled && (!var.spec_factory_rds_proxy_enabled || var.spec_factory_rds_direct_fallback_enabled) ? 1 : 0
  type                     = "egress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  security_group_id        = aws_security_group.spec_factory_tasks[0].id
  source_security_group_id = var.existing_rds_security_group_id
  description              = "MySQL to the existing RDS security group"
}

resource "aws_security_group_rule" "spec_factory_rds_proxy_egress" {
  count                    = var.enable_spec_factory && var.spec_factory_rds_proxy_enabled ? 1 : 0
  type                     = "egress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  security_group_id        = aws_security_group.spec_factory_tasks[0].id
  source_security_group_id = aws_security_group.spec_factory_rds_proxy[0].id
  description              = "MySQL to the Spec Factory RDS Proxy"
}

resource "aws_security_group_rule" "spec_factory_aurora_egress" {
  count                    = var.enable_spec_factory && var.spec_factory_aurora_enabled && !var.spec_factory_rds_proxy_enabled ? 1 : 0
  type                     = "egress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  security_group_id        = aws_security_group.spec_factory_tasks[0].id
  source_security_group_id = aws_security_group.spec_factory_aurora[0].id
  description              = "MySQL directly to the optional Spec Factory Aurora cluster"
}

resource "aws_security_group_rule" "spec_factory_efs_egress" {
  count                    = var.enable_spec_factory && var.spec_factory_legacy_runtime != "disabled" ? 1 : 0
  type                     = "egress"
  from_port                = 2049
  to_port                  = 2049
  protocol                 = "tcp"
  security_group_id        = aws_security_group.spec_factory_tasks[0].id
  source_security_group_id = var.existing_efs_security_group_id
  description              = "NFS to the approved EFS security group"
}

resource "aws_security_group_rule" "spec_factory_valkey_egress" {
  count                    = var.enable_spec_factory && var.spec_factory_valkey_enabled ? 1 : 0
  type                     = "egress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  security_group_id        = aws_security_group.spec_factory_tasks[0].id
  source_security_group_id = aws_security_group.spec_factory_valkey[0].id
  description              = "TLS Valkey fanout"
}

resource "aws_security_group_rule" "rds_from_spec_factory" {
  count                    = var.enable_spec_factory && !var.spec_factory_aurora_enabled && (!var.spec_factory_rds_proxy_enabled || var.spec_factory_rds_direct_fallback_enabled) ? 1 : 0
  type                     = "ingress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  security_group_id        = var.existing_rds_security_group_id
  source_security_group_id = aws_security_group.spec_factory_tasks[0].id
  description              = "MySQL from Spec Factory ECS tasks"
}

resource "aws_security_group_rule" "efs_from_spec_factory" {
  count                    = var.enable_spec_factory && var.spec_factory_legacy_runtime != "disabled" ? 1 : 0
  type                     = "ingress"
  from_port                = 2049
  to_port                  = 2049
  protocol                 = "tcp"
  security_group_id        = var.existing_efs_security_group_id
  source_security_group_id = aws_security_group.spec_factory_tasks[0].id
  description              = "NFS from Spec Factory ECS tasks"
}

locals {
  spec_factory_alarm_actions = trimspace(var.spec_factory_alarm_topic_arn) != "" ? [var.spec_factory_alarm_topic_arn] : local.oneshot_alarm_actions

  spec_factory_worker_services = {
    worker = {
      service_name       = "SPEC-FACTORY-WORKER"
      log_prefix         = "spec-factory-worker"
      desired_count      = var.spec_factory_worker_desired_count
      include_markitdown = false
      image_family       = "core"
    }
    turn-worker = {
      service_name       = "SPEC-FACTORY-TURN"
      log_prefix         = "spec-factory-turn-worker"
      desired_count      = var.spec_factory_turn_worker_desired_count
      include_markitdown = false
      image_family       = "core"
    }
    context-worker = {
      service_name       = "SPEC-FACTORY-CONTEXT"
      log_prefix         = "spec-factory-context-worker"
      desired_count      = var.spec_factory_context_worker_desired_count
      include_markitdown = false
      image_family       = "core"
    }
    research-worker = {
      service_name       = "SPEC-FACTORY-RESEARCH"
      log_prefix         = "spec-factory-research-worker"
      desired_count      = var.spec_factory_research_worker_desired_count
      include_markitdown = false
      image_family       = "research"
    }
    conversion-worker = {
      service_name       = "SPEC-FACTORY-CONVERSION"
      log_prefix         = "spec-factory-conversion-worker"
      desired_count      = var.spec_factory_conversion_worker_desired_count
      include_markitdown = true
      image_family       = "conversion"
    }
    draft-worker = {
      service_name       = "SPEC-FACTORY-DRAFT"
      log_prefix         = "spec-factory-draft-worker"
      desired_count      = var.spec_factory_draft_worker_desired_count
      include_markitdown = false
      image_family       = "core"
    }
    relay-worker = {
      service_name       = "SPEC-FACTORY-RELAY"
      log_prefix         = "spec-factory-relay-worker"
      desired_count      = var.spec_factory_relay_worker_desired_count
      include_markitdown = false
      image_family       = "core"
    }
    retention-worker = {
      service_name       = "SPEC-FACTORY-RETENTION"
      log_prefix         = "spec-factory-retention-worker"
      desired_count      = var.spec_factory_retention_worker_desired_count
      include_markitdown = false
      image_family       = "core"
    }
  }

  spec_factory_runtime_queues = {
    turn-worker       = "turn"
    context-worker    = "context"
    research-worker   = "research"
    conversion-worker = "conversion"
    draft-worker      = "draft"
    relay-worker      = "events"
  }

  spec_factory_worker_services_with_desired_tasks = {
    for mode, service in local.spec_factory_worker_services : mode => service
    if service.desired_count > 0
  }
}

# ============================================================================
# ECS TASK DEFINITION
# ============================================================================

resource "aws_ecs_task_definition" "spec_factory" {
  count                    = var.enable_spec_factory ? 1 : 0
  family                   = "specter-spec-factory"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.spec_factory_cpu
  memory                   = var.spec_factory_memory
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.spec_factory_runtime["api"].arn

  depends_on = [
    aws_db_proxy_target.spec_factory_existing,
    aws_db_proxy_target.spec_factory_aurora,
  ]

  ephemeral_storage {
    size_in_gib = var.spec_factory_ephemeral_storage_gib
  }

  dynamic "volume" {
    for_each = var.spec_factory_legacy_runtime == "disabled" ? [] : [1]
    content {
      name = "specter-repo"
      efs_volume_configuration {
        file_system_id     = var.existing_efs_id
        transit_encryption = "ENABLED"
        root_directory     = "/"
      }
    }
  }

  container_definitions = jsonencode(concat([
    {
      name  = "spec-factory"
      image = local.spec_factory_runtime_images.api

      dependsOn = var.spec_factory_otel_enabled ? [{
        containerName = "ecs-cwagent"
        condition     = "START"
      }] : []

      # Soft floor so the sidecar (capped below) cannot starve the essential app.
      memoryReservation = var.spec_factory_app_memory_reservation

      portMappings = [{
        containerPort = 3012
        hostPort      = 3012
        protocol      = "tcp"
      }]

      healthCheck = {
        command     = ["CMD-SHELL", "curl -fsS http://localhost:3012/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 45
      }

      mountPoints = var.spec_factory_legacy_runtime == "disabled" ? [] : [{
        sourceVolume  = "specter-repo"
        containerPath = "/mnt/efs/specter-repo"
        readOnly      = false
      }]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "SPEC_FACTORY_MODE", value = "api" },
        { name = "SPEC_FACTORY_PORT", value = "3012" },
        { name = "OTEL_ENABLED", value = tostring(var.spec_factory_otel_enabled) },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = local.spec_factory_otel_metrics_endpoint },
        { name = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", value = local.spec_factory_otel_traces_endpoint },
        { name = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", value = local.spec_factory_otel_metrics_endpoint },
        { name = "SPEC_FACTORY_LOUISE_JQL", value = var.spec_factory_louise_jql },
        { name = "SPEC_FACTORY_JIRA_PROJECT_KEY", value = var.spec_factory_jira_project_key },
        { name = "SPEC_FACTORY_JIRA_EPIC_ISSUE_TYPE", value = var.spec_factory_jira_epic_issue_type },
        { name = "SPEC_FACTORY_JIRA_CHILD_ISSUE_TYPE", value = var.spec_factory_jira_child_issue_type },
        { name = "SPEC_FACTORY_MODEL_ID", value = var.spec_factory_model_id },
        { name = "SPEC_FACTORY_DRAFT_TIMEOUT_MS", value = var.spec_factory_draft_timeout_ms },
        { name = "SPEC_FACTORY_PROCESSOR_POLL_MS", value = var.spec_factory_processor_poll_ms },
        { name = "SPEC_FACTORY_WORKER_HEARTBEAT_ENABLED", value = tostring(var.spec_factory_worker_heartbeat_enabled) },
        { name = "SPEC_FACTORY_WORKER_HEARTBEAT_MS", value = var.spec_factory_worker_heartbeat_ms },
        { name = "SPEC_FACTORY_DURABLE_EVENTS", value = tostring(var.spec_factory_durable_events_required) },
        { name = "SPEC_FACTORY_OUTBOX_ENABLED", value = tostring(var.spec_factory_outbox_enabled) },
        { name = "SPEC_FACTORY_ARTIFACT_STORE", value = var.spec_factory_artifact_store },
        { name = "SPEC_FACTORY_ARTIFACT_BUCKET", value = aws_s3_bucket.results.bucket },
        { name = "SPEC_FACTORY_ARTIFACT_PREFIX", value = "spec-factory" },
        { name = "SPEC_FACTORY_QUEUE_DISPATCH_MODE", value = var.spec_factory_queue_dispatch_mode },
        { name = "SPEC_FACTORY_TURN_QUEUE_URL", value = aws_sqs_queue.spec_factory["turn"].url },
        { name = "SPEC_FACTORY_CONTEXT_QUEUE_URL", value = aws_sqs_queue.spec_factory["context"].url },
        { name = "SPEC_FACTORY_RESEARCH_QUEUE_URL", value = aws_sqs_queue.spec_factory["research"].url },
        { name = "SPEC_FACTORY_CONVERSION_QUEUE_URL", value = aws_sqs_queue.spec_factory["conversion"].url },
        { name = "SPEC_FACTORY_DRAFT_QUEUE_URL", value = aws_sqs_queue.spec_factory["draft"].url },
        { name = "SPEC_FACTORY_EVENTS_QUEUE_URL", value = aws_sqs_queue.spec_factory["events"].url },
        { name = "SPEC_FACTORY_QUARANTINE_QUEUE_URL", value = aws_sqs_queue.spec_factory_quarantine[0].url },
        { name = "SPEC_FACTORY_SSE_DURABLE_POLL_MS", value = var.spec_factory_sse_durable_poll_ms },
        { name = "SPEC_FACTORY_WORKFLOW_STATE_RATE_LIMIT_MAX", value = tostring(var.spec_factory_workflow_state_rate_limit_max) },
        { name = "SPEC_FACTORY_DURABLE_TURNS", value = var.spec_factory_durable_turns },
        { name = "SPEC_FACTORY_TURN_LEASE_MS", value = var.spec_factory_turn_lease_ms },
        { name = "SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS", value = var.spec_factory_turn_lease_heartbeat_ms },
        { name = "SPEC_FACTORY_TURN_WORKER_BATCH_SIZE", value = var.spec_factory_turn_worker_batch_size },
        { name = "SPEC_FACTORY_TURN_WORKER_CONCURRENCY", value = var.spec_factory_turn_worker_concurrency },
        { name = "SPEC_FACTORY_TURN_WORKER_POLL_MS", value = var.spec_factory_turn_worker_poll_ms },
        { name = "SPEC_FACTORY_TURN_LEASE_RECOVERY_LIMIT", value = var.spec_factory_turn_lease_recovery_limit },
        { name = "SPEC_FACTORY_TURN_CLARIFICATION_EXPIRY_LIMIT", value = var.spec_factory_turn_clarification_expiry_limit },
        { name = "SPEC_FACTORY_AGENT_TASK_WORKER_ENABLED", value = tostring(var.spec_factory_agent_task_worker_enabled) },
        { name = "SPEC_FACTORY_AGENT_TASK_LEASE_MS", value = var.spec_factory_agent_task_lease_ms },
        { name = "SPEC_FACTORY_AGENT_TASK_WORKER_BATCH_SIZE", value = var.spec_factory_agent_task_worker_batch_size },
        { name = "SPEC_FACTORY_AGENT_TASK_WORKER_POLL_MS", value = var.spec_factory_agent_task_worker_poll_ms },
        { name = "SPEC_FACTORY_AGENT_TASK_LEASE_RECOVERY_LIMIT", value = var.spec_factory_agent_task_lease_recovery_limit },
        { name = "SPEC_FACTORY_AGENT_TASK_WORKER_CAPABILITIES", value = var.spec_factory_agent_task_worker_capabilities },
        { name = "SPEC_FACTORY_WORKSPACE_MANAGER", value = tostring(var.spec_factory_workspace_manager_enabled) },
        { name = "SPEC_FACTORY_RESEARCH_EXECUTOR", value = var.spec_factory_research_executor },
        { name = "SPEC_FACTORY_RESEARCH_INGRESS_ENABLED", value = tostring(var.spec_factory_research_ingress_enabled) },
        { name = "SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS", value = var.spec_factory_research_allowed_tools },
        { name = "SPEC_FACTORY_RESEARCH_ALLOWED_BASH_PATTERNS", value = var.spec_factory_research_allowed_bash_patterns },
        { name = "SPEC_FACTORY_RESEARCH_MODEL_ID", value = var.spec_factory_research_model_id },
        { name = "SPEC_FACTORY_RESEARCH_TIMEOUT_MS", value = var.spec_factory_research_timeout_ms },
        { name = "SPEC_FACTORY_RESEARCH_MAX_RUNTIME_SECONDS", value = var.spec_factory_research_max_runtime_seconds },
        { name = "SPEC_FACTORY_RESEARCH_DISTILLATION_ENABLED", value = tostring(var.spec_factory_research_distillation_enabled) },
        { name = "SPEC_FACTORY_RESEARCH_MAX_TURNS", value = var.spec_factory_research_max_turns },
        { name = "SPEC_FACTORY_RESEARCH_TOOL_BUDGET", value = var.spec_factory_research_tool_budget },
        { name = "SPEC_FACTORY_RESEARCH_MAX_COST_USD", value = var.spec_factory_research_max_cost_usd },
        { name = "SPEC_FACTORY_RESEARCH_COST_CEILING_USD", value = var.spec_factory_research_cost_ceiling_usd },
        { name = "SPEC_FACTORY_RESEARCH_TASKS_PER_24H", value = var.spec_factory_research_tasks_per_24h },
        { name = "SPEC_FACTORY_RESEARCH_INFLIGHT_TASKS_PER_SESSION", value = var.spec_factory_research_inflight_tasks_per_session },
        { name = "SPEC_FACTORY_RESEARCH_GLOBAL_COST_CEILING_USD", value = var.spec_factory_research_global_cost_ceiling_usd },
        { name = "SPEC_FACTORY_RESEARCH_GLOBAL_INFLIGHT_TASKS", value = var.spec_factory_research_global_inflight_tasks },
        { name = "SPEC_FACTORY_RESEARCH_GLOBAL_TASKS_PER_24H", value = var.spec_factory_research_global_tasks_per_24h },
        { name = "SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION", value = tostring(var.spec_factory_enable_context_distillation) },
        { name = "SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM", value = tostring(var.spec_factory_enable_context_distillation_llm) },
        { name = "SPEC_FACTORY_CONTEXT_DISTILLATION_MAX_COST_USD", value = var.spec_factory_context_distillation_max_cost_usd },
        { name = "SPEC_FACTORY_CONTEXT_DISTILLATION_TIMEOUT_MS", value = var.spec_factory_context_distillation_timeout_ms },
        { name = "SPEC_FACTORY_ENABLE_CONTEXT_MERGE", value = tostring(var.spec_factory_enable_context_merge) },
        { name = "SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM", value = tostring(var.spec_factory_enable_context_merge_llm) },
        { name = "SPEC_FACTORY_CONTEXT_MERGE_MAX_COST_USD", value = var.spec_factory_context_merge_max_cost_usd },
        { name = "SPEC_FACTORY_CONTEXT_MERGE_TIMEOUT_MS", value = var.spec_factory_context_merge_timeout_ms },
        { name = "SPEC_FACTORY_LLM_GATEWAY", value = tostring(var.spec_factory_llm_gateway_enabled) },
        { name = "SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES", value = var.spec_factory_llm_direct_bedrock_purposes },
        { name = "SPEC_FACTORY_LLM_PROMPT_LOGGING", value = var.spec_factory_llm_prompt_logging },
        { name = "SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE", value = var.spec_factory_llm_audit_artifact_base },
        { name = "SPEC_FACTORY_LLM_SECURE_DEBUG", value = tostring(var.spec_factory_llm_secure_debug) },
        { name = "SPEC_FACTORY_PROMPT_REGISTRY_SOURCE", value = var.spec_factory_prompt_registry_source },
        { name = "SPEC_FACTORY_LLM_MAX_ATTEMPTS", value = var.spec_factory_llm_max_attempts },
        { name = "SPEC_FACTORY_LLM_RETRY_BASE_MS", value = var.spec_factory_llm_retry_base_ms },
        { name = "SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD", value = var.spec_factory_llm_session_cost_ceiling_usd },
        { name = "SPEC_FACTORY_LLM_GLOBAL_DAILY_COST_CEILING_USD", value = var.spec_factory_llm_global_daily_cost_ceiling_usd },
        { name = "SPEC_FACTORY_LLM_MODEL_ALLOWLIST", value = var.spec_factory_llm_model_allowlist },
        { name = "SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST", value = var.spec_factory_llm_model_chat_coordinator_fast },
        { name = "SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_STRONG", value = var.spec_factory_llm_model_chat_coordinator_strong },
        { name = "SPEC_FACTORY_LLM_MODEL_SOURCE_DISTILLATION", value = var.spec_factory_llm_model_source_distillation },
        { name = "SPEC_FACTORY_LLM_MODEL_CONTEXT_MERGE", value = var.spec_factory_llm_model_context_merge },
        { name = "SPEC_FACTORY_LLM_MODEL_CRITIC_REVIEW", value = var.spec_factory_llm_model_critic_review },
        { name = "SPEC_FACTORY_LLM_MODEL_HANDOFF_SYNTHESIS", value = var.spec_factory_llm_model_handoff_synthesis },
        { name = "SPEC_FACTORY_LLM_MODEL_CONVERSATION_SUMMARY", value = var.spec_factory_llm_model_conversation_summary },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS", value = var.spec_factory_llm_max_output_tokens },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CHAT_COORDINATOR_FAST", value = var.spec_factory_llm_max_output_tokens_chat_coordinator_fast },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CHAT_COORDINATOR_STRONG", value = var.spec_factory_llm_max_output_tokens_chat_coordinator_strong },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_SOURCE_DISTILLATION", value = var.spec_factory_llm_max_output_tokens_source_distillation },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CONTEXT_MERGE", value = var.spec_factory_llm_max_output_tokens_context_merge },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CRITIC_REVIEW", value = var.spec_factory_llm_max_output_tokens_critic_review },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_HANDOFF_SYNTHESIS", value = var.spec_factory_llm_max_output_tokens_handoff_synthesis },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CONVERSATION_SUMMARY", value = var.spec_factory_llm_max_output_tokens_conversation_summary },
        { name = "SPEC_FACTORY_CHAT_COORDINATOR", value = tostring(var.spec_factory_chat_coordinator_enabled) },
        { name = "SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN", value = var.spec_factory_coordinator_max_tasks_per_turn },
        { name = "SPEC_FACTORY_ENABLE_CRITIC", value = tostring(var.spec_factory_enable_critic) },
        { name = "SPEC_FACTORY_CRITIC_MAX_COST_USD", value = var.spec_factory_critic_max_cost_usd },
        { name = "SPEC_FACTORY_CRITIC_TIMEOUT_MS", value = var.spec_factory_critic_timeout_ms },
        { name = "SPEC_FACTORY_HANDOFF_ENRICHED", value = tostring(var.spec_factory_handoff_enriched) },
        { name = "SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED", value = tostring(var.spec_factory_handoff_build_task_enabled) },
        { name = "SPEC_FACTORY_HANDOFF_LLM_SYNTHESIS", value = tostring(var.spec_factory_handoff_llm_synthesis) },
        { name = "SPEC_FACTORY_HANDOFF_SYNTHESIS_MAX_COST_USD", value = var.spec_factory_handoff_synthesis_max_cost_usd },
        { name = "SPEC_FACTORY_HANDOFF_SYNTHESIS_TIMEOUT_MS", value = var.spec_factory_handoff_synthesis_timeout_ms },
        { name = "SPEC_FACTORY_ADMIN_IDS", value = var.spec_factory_admin_ids },
        { name = "SPEC_FACTORY_QUALIFIER_MODEL_ID", value = var.spec_factory_model_id },
        { name = "SPEC_FACTORY_QUALIFIER_TIMEOUT_MS", value = var.spec_factory_qualifier_timeout_ms },
        { name = "COMPOSE_CHAT_MODEL_ID", value = var.compose_chat_model_id },
        { name = "COMPOSE_MAX_QUEUED_TURNS", value = tostring(var.compose_max_queued_turns) },
        { name = "COMPOSE_MAX_UPLOAD_BYTES", value = tostring(var.compose_max_upload_bytes) },
        { name = "COMPOSE_CHAT_TIMEOUT_MS", value = tostring(var.compose_chat_timeout_ms) },
        { name = "COMPOSE_CHAT_MAX_PROMPT_TOKENS", value = tostring(var.compose_chat_max_prompt_tokens) },
        { name = "COMPOSE_RETRY_BASE_MS", value = tostring(var.compose_retry_base_ms) },
        { name = "SPEC_FACTORY_REPO_DEEP_DIVE_ENABLED", value = tostring(var.spec_factory_repo_deep_dive_enabled) },
        { name = "SPEC_FACTORY_REPO_CACHE_BASE", value = var.spec_factory_legacy_runtime == "disabled" ? "/var/lib/spec-factory/repo-cache" : "/mnt/efs/specter-repo/spec-factory/repo-cache" },
        { name = "SPEC_FACTORY_REPO_CACHE_FRESHNESS_TTL_MS", value = tostring(var.oneshot_repo_cache_freshness_ttl_ms) },
        { name = "SPEC_FACTORY_TASK_WORKSPACE_BASE", value = var.spec_factory_legacy_runtime == "disabled" ? "/var/lib/spec-factory/tasks" : "/mnt/efs/specter-repo/spec-factory/tasks" },
        { name = "SPEC_FACTORY_EVIDENCE_WORKSPACE_BASE", value = var.spec_factory_legacy_runtime == "disabled" ? "/var/lib/spec-factory/evidence-workspaces" : "/mnt/efs/specter-repo/spec-factory/evidence-workspaces" },
        { name = "SPEC_FACTORY_WORKSPACE_BASE", value = var.spec_factory_legacy_runtime == "disabled" ? "/var/lib/spec-factory/repo-workspaces" : "/mnt/efs/specter-repo/spec-factory/workspaces" },
        { name = "SPEC_FACTORY_WORKTREE_BASE", value = "/var/lib/spec-factory/worktrees" },
        { name = "SPEC_FACTORY_ATTACHMENT_BUCKET", value = aws_s3_bucket.results.bucket },
        { name = "DB_HOST", value = var.spec_factory_rds_proxy_enabled ? aws_db_proxy.spec_factory[0].endpoint : var.db_host },
        { name = "DB_PORT", value = var.db_port },
        { name = "DB_NAME", value = var.spec_factory_aurora_enabled ? "specfactory" : var.db_name },
        { name = "DB_SSL", value = tostring(var.spec_factory_rds_proxy_enabled) },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "S3_BUCKET_PREFIX", value = "specter" },
        { name = "JIRA_BASE_URL", value = var.jira_base_url },
        { name = "JIRA_USERNAME", value = var.jira_username },
        { name = "CLAUDE_CODE_USE_BEDROCK", value = "1" },
        { name = "ANTHROPIC_MODEL", value = var.spec_factory_model_id },
        { name = "BEDROCK_MODEL", value = var.spec_factory_model_id },
        { name = "COMPOSE_WORKSPACE_BASE", value = var.spec_factory_legacy_runtime == "disabled" ? "/var/lib/spec-factory/compose" : "/mnt/efs/specter-repo/spec-factory/compose" },
        { name = "COMPOSE_WORKSPACE_VALIDATE_ON_STARTUP", value = tostring(var.compose_workspace_validate_on_startup) },
        { name = "COMPOSE_S3_PREFIX", value = "compose" },
        { name = "COMPOSE_MARKITDOWN_URL", value = "http://localhost:8080" },
        { name = "COMPOSE_VOXTRAL_MODEL_ID", value = var.compose_voxtral_model_id },
        { name = "COMPOSE_REPO_GROUNDING_ENABLED", value = tostring(var.compose_repo_grounding_enabled) },
        { name = "COMPOSE_MAX_GROUNDED_REPOS", value = tostring(var.compose_max_grounded_repos) },
        { name = "COMPOSE_REPO_GROUNDING_TOOL_BUDGET", value = tostring(var.compose_repo_grounding_tool_budget) },
        { name = "COMPOSE_REPO_GROUNDING_TIMEOUT_MS", value = tostring(var.compose_repo_grounding_timeout_ms) },
        { name = "COMPOSE_AUDIO_SEGMENT_SECONDS", value = tostring(var.compose_audio_segment_seconds) },
        { name = "COMPOSE_VOXTRAL_MAX_REQUEST_BYTES", value = tostring(var.compose_voxtral_max_request_bytes) },
        { name = "COMPOSE_CONVERT_TIMEOUT_MS", value = tostring(var.compose_convert_timeout_ms) },
        { name = "COMPOSE_EXTRACT_AUDIO_TIMEOUT_MS", value = tostring(var.compose_extract_audio_timeout_ms) },
        { name = "COMPOSE_TRANSCRIBE_SEGMENT_TIMEOUT_MS", value = tostring(var.compose_transcribe_segment_timeout_ms) },
        { name = "COMPOSE_CONVERSION_LEASE_MS", value = tostring(var.compose_conversion_lease_ms) },
        { name = "COMPOSE_CONVERSION_POLL_MS", value = tostring(var.compose_conversion_poll_ms) },
        { name = "COMPOSE_RETENTION_CLEANUP_ENABLED", value = tostring(var.compose_retention_cleanup_enabled) },
        { name = "COMPOSE_WORKSPACE_RETENTION_DAYS", value = tostring(var.compose_workspace_retention_days) },
        { name = "COMPOSE_CLEANUP_LIMIT", value = tostring(var.compose_cleanup_limit) },
        { name = "COMPOSE_RETENTION_SWEEP_MS", value = tostring(var.compose_retention_sweep_ms) },
        { name = "SPEC_FACTORY_SOURCE_DELETE_UNDO_MINUTES", value = tostring(var.spec_factory_source_delete_undo_minutes) },
        { name = "SPEC_FACTORY_SOURCE_DELETE_SWEEP_MS", value = tostring(var.spec_factory_source_delete_sweep_ms) },
        { name = "SPEC_FACTORY_SOURCE_DELETE_PURGE_LIMIT", value = tostring(var.spec_factory_source_delete_purge_limit) },
        { name = "SPEC_FACTORY_WORKER_HEARTBEAT_RETENTION_DAYS", value = tostring(var.spec_factory_worker_heartbeat_retention_days) },
        { name = "SPEC_FACTORY_WORKER_HEARTBEAT_GC_LIMIT", value = tostring(var.spec_factory_worker_heartbeat_gc_limit) },
        { name = "COMPOSE_CLEANUP_DRY_RUN", value = tostring(var.compose_cleanup_dry_run) },
        { name = "COMPOSE_ARTIFACT_TMP_RETENTION_HOURS", value = tostring(var.compose_artifact_tmp_retention_hours) },
        { name = "COMPOSE_ARTIFACT_GC_LIMIT", value = tostring(var.compose_artifact_gc_limit) },
        { name = "COMPOSE_ARTIFACT_GC_MAX_DEPTH", value = tostring(var.compose_artifact_gc_max_depth) },
        { name = "SPEC_FACTORY_LLM_AUDIT_ARTIFACT_RETENTION_DAYS", value = tostring(var.spec_factory_llm_audit_artifact_retention_days) },
        { name = "SPEC_FACTORY_LLM_AUDIT_ARTIFACT_GC_LIMIT", value = tostring(var.spec_factory_llm_audit_artifact_gc_limit) },
        { name = "COMPOSE_S3_REACHABILITY_GC_ENABLED", value = tostring(var.compose_s3_reachability_gc_enabled) },
        { name = "COMPOSE_S3_REACHABILITY_GC_LIMIT", value = tostring(var.compose_s3_reachability_gc_limit) },
        { name = "COMPOSE_CONFLUENCE_ALLOWED_HOST_SUFFIXES", value = var.compose_confluence_allowed_host_suffixes },
        { name = "SPEC_FACTORY_VALKEY_URL", value = var.spec_factory_valkey_enabled ? "rediss://${aws_elasticache_replication_group.spec_factory[0].primary_endpoint_address}:6379" : "" },
        { name = "SPEC_FACTORY_DRAFT_WORKFLOW_V2_ENABLED", value = tostring(var.spec_factory_draft_workflow_v2_enabled) },
        { name = "SPEC_FACTORY_DRAFT_WORKFLOW_CONCURRENCY", value = tostring(var.spec_factory_draft_workflow_concurrency) },
        { name = "SPEC_FACTORY_LEGACY_RUNTIME", value = var.spec_factory_legacy_runtime },
        { name = "SPEC_FACTORY_IMAGE_PINNED", value = tostring(var.spec_factory_pin_image_by_digest) },
        { name = "SPEC_FACTORY_CERTIFICATION_ID", value = var.spec_factory_certification_id },
        { name = "SPEC_FACTORY_CONTEXT_V4_REPAIR_RUN_ID", value = tostring(var.spec_factory_context_v4_repair_run_id) },
        { name = "SPEC_FACTORY_SQS_VISIBILITY_TIMEOUT_SECONDS", value = "900" },
        { name = "SPEC_FACTORY_SQS_HEARTBEAT_SECONDS", value = tostring(var.spec_factory_sqs_heartbeat_seconds) },
        { name = "SPEC_FACTORY_QUEUE_RECEIPT_LEASE_MS", value = "960000" },
        { name = "SPEC_FACTORY_OUTBOX_RETENTION_DAYS", value = tostring(var.spec_factory_outbox_retention_days) },
        { name = "SPEC_FACTORY_QUEUE_RECEIPT_RETENTION_DAYS", value = tostring(var.spec_factory_queue_receipt_retention_days) },
        { name = "SPEC_FACTORY_REPAIR_RECONCILE_LIMIT", value = tostring(var.spec_factory_repair_reconcile_limit) },
        { name = "SPEC_FACTORY_IMMUTABLE_ARTIFACT_ORPHAN_GRACE_HOURS", value = tostring(var.spec_factory_immutable_artifact_orphan_grace_hours) },
        { name = "SPEC_FACTORY_IMMUTABLE_ARTIFACT_GC_LIMIT", value = tostring(var.spec_factory_immutable_artifact_gc_limit) }
      ]

      secrets = [
        {
          name      = "DB_USER"
          valueFrom = "${local.spec_factory_database_secret_arn}:username::"
        },
        {
          name      = "DB_PASSWORD"
          valueFrom = "${local.spec_factory_database_secret_arn}:password::"
        },
        {
          name      = "JIRA_TOKEN"
          valueFrom = data.aws_secretsmanager_secret.jira_token.arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.spec_factory[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "spec-factory"
        }
      }
    },
    {
      name      = "compose-markitdown"
      image     = local.compose_markitdown_image
      essential = false

      # Hard cap: on overrun ECS OOM-kills ONLY this non-essential sidecar (the
      # task + essential app survive; the in-flight conversion fails and is
      # retried) rather than taking down the whole task as before.
      memory = var.compose_markitdown_memory

      portMappings = [{
        containerPort = 8080
        hostPort      = 8080
        protocol      = "tcp"
      }]

      environment = [
        { name = "COMPOSE_AUDIO_SEGMENT_SECONDS", value = tostring(var.compose_audio_segment_seconds) },
        { name = "COMPOSE_AUDIO_MP3_BITRATE", value = var.compose_audio_mp3_bitrate },
        { name = "COMPOSE_AUDIO_MAX_SECONDS", value = tostring(var.compose_audio_max_seconds) },
        { name = "COMPOSE_AUDIO_MAX_BYTES", value = tostring(var.compose_audio_max_bytes) },
        { name = "MARKITDOWN_MAX_BYTES", value = tostring(var.compose_markitdown_max_bytes) },
        { name = "COMPOSE_CONFLUENCE_ALLOWED_HOST_SUFFIXES", value = var.compose_confluence_allowed_host_suffixes },
        { name = "MARKITDOWN_URL_MAX_BYTES", value = "10485760" },
        { name = "MARKITDOWN_URL_FETCH_TIMEOUT_SECONDS", value = "15" },
        { name = "MARKITDOWN_URL_MAX_REDIRECTS", value = "5" }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8080/health').status==200 else 1)\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.spec_factory[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "compose-markitdown"
        }
      }
    }
    ], var.spec_factory_otel_enabled ? [{
      name              = "ecs-cwagent"
      image             = var.spec_factory_otel_sidecar_image
      cpu               = 64
      essential         = false
      memory            = var.spec_factory_otel_sidecar_memory
      memoryReservation = 128

      secrets = [{
        name      = "CW_CONFIG_CONTENT"
        valueFrom = aws_ssm_parameter.spec_factory_cwagent_config[0].arn
      }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.spec_factory[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "otel-all-local"
        }
      }
    }] : []
  ))

  tags = merge(local.common_tags, {
    Service = "spec-factory"
  })
}

resource "aws_ecs_task_definition" "spec_factory_workers" {
  for_each = var.enable_spec_factory ? local.spec_factory_worker_services : {}

  family                   = "specter-spec-factory-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.spec_factory_cpu
  memory                   = var.spec_factory_memory
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.spec_factory_runtime[each.key].arn

  depends_on = [
    aws_db_proxy_target.spec_factory_existing,
    aws_db_proxy_target.spec_factory_aurora,
  ]

  ephemeral_storage {
    size_in_gib = var.spec_factory_ephemeral_storage_gib
  }

  dynamic "volume" {
    for_each = var.spec_factory_legacy_runtime == "disabled" ? [] : [1]
    content {
      name = "specter-repo"
      efs_volume_configuration {
        file_system_id     = var.existing_efs_id
        transit_encryption = "ENABLED"
        root_directory     = "/"
      }
    }
  }

  container_definitions = jsonencode(concat([
    {
      name  = "spec-factory"
      image = local.spec_factory_runtime_images[each.value.image_family]

      dependsOn = var.spec_factory_otel_enabled ? [{
        containerName = "ecs-cwagent"
        condition     = "START"
      }] : []

      memoryReservation = var.spec_factory_app_memory_reservation

      portMappings = [{
        containerPort = 3012
        hostPort      = 3012
        protocol      = "tcp"
      }]

      healthCheck = {
        command     = ["CMD-SHELL", "curl -fsS http://localhost:3012/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 45
      }

      mountPoints = var.spec_factory_legacy_runtime == "disabled" ? [] : [{
        sourceVolume  = "specter-repo"
        containerPath = "/mnt/efs/specter-repo"
        readOnly      = false
      }]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "SPEC_FACTORY_MODE", value = each.key },
        { name = "SPEC_FACTORY_PORT", value = "3012" },
        { name = "OTEL_ENABLED", value = tostring(var.spec_factory_otel_enabled) },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = local.spec_factory_otel_metrics_endpoint },
        { name = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", value = local.spec_factory_otel_traces_endpoint },
        { name = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", value = local.spec_factory_otel_metrics_endpoint },
        { name = "SPEC_FACTORY_LOUISE_JQL", value = var.spec_factory_louise_jql },
        { name = "SPEC_FACTORY_JIRA_PROJECT_KEY", value = var.spec_factory_jira_project_key },
        { name = "SPEC_FACTORY_JIRA_EPIC_ISSUE_TYPE", value = var.spec_factory_jira_epic_issue_type },
        { name = "SPEC_FACTORY_JIRA_CHILD_ISSUE_TYPE", value = var.spec_factory_jira_child_issue_type },
        { name = "SPEC_FACTORY_MODEL_ID", value = var.spec_factory_model_id },
        { name = "SPEC_FACTORY_DRAFT_TIMEOUT_MS", value = var.spec_factory_draft_timeout_ms },
        { name = "SPEC_FACTORY_PROCESSOR_POLL_MS", value = var.spec_factory_processor_poll_ms },
        { name = "SPEC_FACTORY_WORKER_HEARTBEAT_ENABLED", value = tostring(var.spec_factory_worker_heartbeat_enabled) },
        { name = "SPEC_FACTORY_WORKER_HEARTBEAT_MS", value = var.spec_factory_worker_heartbeat_ms },
        { name = "SPEC_FACTORY_ECS_TASK_PROTECTION_ENABLED", value = tostring(var.spec_factory_ecs_task_protection_enabled && contains(keys(local.spec_factory_runtime_queues), each.key)) },
        { name = "SPEC_FACTORY_ECS_TASK_PROTECTION_EXPIRES_MINUTES", value = tostring(var.spec_factory_ecs_task_protection_expires_minutes) },
        { name = "SPEC_FACTORY_ECS_TASK_PROTECTION_REFRESH_MS", value = tostring(var.spec_factory_ecs_task_protection_refresh_ms) },
        { name = "SPEC_FACTORY_ECS_TASK_PROTECTION_REQUEST_TIMEOUT_MS", value = tostring(var.spec_factory_ecs_task_protection_request_timeout_ms) },
        { name = "SPEC_FACTORY_DURABLE_EVENTS", value = tostring(var.spec_factory_durable_events_required) },
        { name = "SPEC_FACTORY_OUTBOX_ENABLED", value = tostring(var.spec_factory_outbox_enabled) },
        { name = "SPEC_FACTORY_ARTIFACT_STORE", value = var.spec_factory_artifact_store },
        { name = "SPEC_FACTORY_ARTIFACT_BUCKET", value = aws_s3_bucket.results.bucket },
        { name = "SPEC_FACTORY_ARTIFACT_PREFIX", value = "spec-factory" },
        { name = "SPEC_FACTORY_QUEUE_DISPATCH_MODE", value = var.spec_factory_queue_dispatch_mode },
        { name = "SPEC_FACTORY_TURN_QUEUE_URL", value = aws_sqs_queue.spec_factory["turn"].url },
        { name = "SPEC_FACTORY_CONTEXT_QUEUE_URL", value = aws_sqs_queue.spec_factory["context"].url },
        { name = "SPEC_FACTORY_RESEARCH_QUEUE_URL", value = aws_sqs_queue.spec_factory["research"].url },
        { name = "SPEC_FACTORY_CONVERSION_QUEUE_URL", value = aws_sqs_queue.spec_factory["conversion"].url },
        { name = "SPEC_FACTORY_DRAFT_QUEUE_URL", value = aws_sqs_queue.spec_factory["draft"].url },
        { name = "SPEC_FACTORY_EVENTS_QUEUE_URL", value = aws_sqs_queue.spec_factory["events"].url },
        { name = "SPEC_FACTORY_QUARANTINE_QUEUE_URL", value = aws_sqs_queue.spec_factory_quarantine[0].url },
        { name = "SPEC_FACTORY_SSE_DURABLE_POLL_MS", value = var.spec_factory_sse_durable_poll_ms },
        { name = "SPEC_FACTORY_DURABLE_TURNS", value = var.spec_factory_durable_turns },
        { name = "SPEC_FACTORY_TURN_LEASE_MS", value = var.spec_factory_turn_lease_ms },
        { name = "SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS", value = var.spec_factory_turn_lease_heartbeat_ms },
        { name = "SPEC_FACTORY_TURN_WORKER_BATCH_SIZE", value = var.spec_factory_turn_worker_batch_size },
        { name = "SPEC_FACTORY_TURN_WORKER_CONCURRENCY", value = var.spec_factory_turn_worker_concurrency },
        { name = "SPEC_FACTORY_TURN_WORKER_POLL_MS", value = var.spec_factory_turn_worker_poll_ms },
        { name = "SPEC_FACTORY_TURN_LEASE_RECOVERY_LIMIT", value = var.spec_factory_turn_lease_recovery_limit },
        { name = "SPEC_FACTORY_TURN_CLARIFICATION_EXPIRY_LIMIT", value = var.spec_factory_turn_clarification_expiry_limit },
        { name = "SPEC_FACTORY_AGENT_TASK_WORKER_ENABLED", value = tostring(contains(["context-worker", "research-worker"], each.key) ? true : var.spec_factory_agent_task_worker_enabled) },
        { name = "SPEC_FACTORY_AGENT_TASK_LEASE_MS", value = var.spec_factory_agent_task_lease_ms },
        { name = "SPEC_FACTORY_AGENT_TASK_WORKER_BATCH_SIZE", value = var.spec_factory_agent_task_worker_batch_size },
        { name = "SPEC_FACTORY_AGENT_TASK_WORKER_POLL_MS", value = var.spec_factory_agent_task_worker_poll_ms },
        { name = "SPEC_FACTORY_AGENT_TASK_LEASE_RECOVERY_LIMIT", value = var.spec_factory_agent_task_lease_recovery_limit },
        { name = "SPEC_FACTORY_AGENT_TASK_WORKER_CAPABILITIES", value = each.key == "context-worker" ? "source_distillation,context_merge,handoff_build,critic_review" : each.key == "research-worker" ? "code_research,config_research,devops_research" : each.key == "draft-worker" ? "" : var.spec_factory_agent_task_worker_capabilities },
        { name = "SPEC_FACTORY_WORKSPACE_MANAGER", value = "true" },
        { name = "SPEC_FACTORY_RESEARCH_EXECUTOR", value = var.spec_factory_research_executor },
        { name = "SPEC_FACTORY_RESEARCH_INGRESS_ENABLED", value = "false" },
        { name = "SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS", value = var.spec_factory_research_allowed_tools },
        { name = "SPEC_FACTORY_RESEARCH_ALLOWED_BASH_PATTERNS", value = var.spec_factory_research_allowed_bash_patterns },
        { name = "SPEC_FACTORY_RESEARCH_MODEL_ID", value = var.spec_factory_research_model_id },
        { name = "SPEC_FACTORY_RESEARCH_TIMEOUT_MS", value = var.spec_factory_research_timeout_ms },
        { name = "SPEC_FACTORY_RESEARCH_MAX_RUNTIME_SECONDS", value = var.spec_factory_research_max_runtime_seconds },
        { name = "SPEC_FACTORY_RESEARCH_DISTILLATION_ENABLED", value = tostring(var.spec_factory_research_distillation_enabled) },
        { name = "SPEC_FACTORY_RESEARCH_MAX_TURNS", value = var.spec_factory_research_max_turns },
        { name = "SPEC_FACTORY_RESEARCH_TOOL_BUDGET", value = var.spec_factory_research_tool_budget },
        { name = "SPEC_FACTORY_RESEARCH_MAX_COST_USD", value = var.spec_factory_research_max_cost_usd },
        { name = "SPEC_FACTORY_RESEARCH_COST_CEILING_USD", value = var.spec_factory_research_cost_ceiling_usd },
        { name = "SPEC_FACTORY_RESEARCH_TASKS_PER_24H", value = var.spec_factory_research_tasks_per_24h },
        { name = "SPEC_FACTORY_RESEARCH_INFLIGHT_TASKS_PER_SESSION", value = var.spec_factory_research_inflight_tasks_per_session },
        { name = "SPEC_FACTORY_RESEARCH_GLOBAL_COST_CEILING_USD", value = var.spec_factory_research_global_cost_ceiling_usd },
        { name = "SPEC_FACTORY_RESEARCH_GLOBAL_INFLIGHT_TASKS", value = var.spec_factory_research_global_inflight_tasks },
        { name = "SPEC_FACTORY_RESEARCH_GLOBAL_TASKS_PER_24H", value = var.spec_factory_research_global_tasks_per_24h },
        { name = "SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION", value = tostring(var.spec_factory_enable_context_distillation) },
        { name = "SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM", value = tostring(var.spec_factory_enable_context_distillation_llm) },
        { name = "SPEC_FACTORY_CONTEXT_DISTILLATION_MAX_COST_USD", value = var.spec_factory_context_distillation_max_cost_usd },
        { name = "SPEC_FACTORY_CONTEXT_DISTILLATION_TIMEOUT_MS", value = var.spec_factory_context_distillation_timeout_ms },
        { name = "SPEC_FACTORY_ENABLE_CONTEXT_MERGE", value = tostring(var.spec_factory_enable_context_merge) },
        { name = "SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM", value = tostring(var.spec_factory_enable_context_merge_llm) },
        { name = "SPEC_FACTORY_CONTEXT_MERGE_MAX_COST_USD", value = var.spec_factory_context_merge_max_cost_usd },
        { name = "SPEC_FACTORY_CONTEXT_MERGE_TIMEOUT_MS", value = var.spec_factory_context_merge_timeout_ms },
        { name = "SPEC_FACTORY_LLM_GATEWAY", value = tostring(var.spec_factory_llm_gateway_enabled) },
        { name = "SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES", value = var.spec_factory_llm_direct_bedrock_purposes },
        { name = "SPEC_FACTORY_LLM_PROMPT_LOGGING", value = var.spec_factory_llm_prompt_logging },
        { name = "SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE", value = var.spec_factory_llm_audit_artifact_base },
        { name = "SPEC_FACTORY_LLM_SECURE_DEBUG", value = tostring(var.spec_factory_llm_secure_debug) },
        { name = "SPEC_FACTORY_PROMPT_REGISTRY_SOURCE", value = var.spec_factory_prompt_registry_source },
        { name = "SPEC_FACTORY_LLM_MAX_ATTEMPTS", value = var.spec_factory_llm_max_attempts },
        { name = "SPEC_FACTORY_LLM_RETRY_BASE_MS", value = var.spec_factory_llm_retry_base_ms },
        { name = "SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD", value = var.spec_factory_llm_session_cost_ceiling_usd },
        { name = "SPEC_FACTORY_LLM_GLOBAL_DAILY_COST_CEILING_USD", value = var.spec_factory_llm_global_daily_cost_ceiling_usd },
        { name = "SPEC_FACTORY_LLM_MODEL_ALLOWLIST", value = var.spec_factory_llm_model_allowlist },
        { name = "SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST", value = var.spec_factory_llm_model_chat_coordinator_fast },
        { name = "SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_STRONG", value = var.spec_factory_llm_model_chat_coordinator_strong },
        { name = "SPEC_FACTORY_LLM_MODEL_SOURCE_DISTILLATION", value = var.spec_factory_llm_model_source_distillation },
        { name = "SPEC_FACTORY_LLM_MODEL_CONTEXT_MERGE", value = var.spec_factory_llm_model_context_merge },
        { name = "SPEC_FACTORY_LLM_MODEL_CRITIC_REVIEW", value = var.spec_factory_llm_model_critic_review },
        { name = "SPEC_FACTORY_LLM_MODEL_HANDOFF_SYNTHESIS", value = var.spec_factory_llm_model_handoff_synthesis },
        { name = "SPEC_FACTORY_LLM_MODEL_CONVERSATION_SUMMARY", value = var.spec_factory_llm_model_conversation_summary },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS", value = var.spec_factory_llm_max_output_tokens },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CHAT_COORDINATOR_FAST", value = var.spec_factory_llm_max_output_tokens_chat_coordinator_fast },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CHAT_COORDINATOR_STRONG", value = var.spec_factory_llm_max_output_tokens_chat_coordinator_strong },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_SOURCE_DISTILLATION", value = var.spec_factory_llm_max_output_tokens_source_distillation },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CONTEXT_MERGE", value = var.spec_factory_llm_max_output_tokens_context_merge },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CRITIC_REVIEW", value = var.spec_factory_llm_max_output_tokens_critic_review },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_HANDOFF_SYNTHESIS", value = var.spec_factory_llm_max_output_tokens_handoff_synthesis },
        { name = "SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CONVERSATION_SUMMARY", value = var.spec_factory_llm_max_output_tokens_conversation_summary },
        { name = "SPEC_FACTORY_CHAT_COORDINATOR", value = tostring(var.spec_factory_chat_coordinator_enabled) },
        { name = "SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN", value = var.spec_factory_coordinator_max_tasks_per_turn },
        { name = "SPEC_FACTORY_ENABLE_CRITIC", value = tostring(var.spec_factory_enable_critic) },
        { name = "SPEC_FACTORY_CRITIC_MAX_COST_USD", value = var.spec_factory_critic_max_cost_usd },
        { name = "SPEC_FACTORY_CRITIC_TIMEOUT_MS", value = var.spec_factory_critic_timeout_ms },
        { name = "SPEC_FACTORY_HANDOFF_ENRICHED", value = tostring(var.spec_factory_handoff_enriched) },
        { name = "SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED", value = tostring(var.spec_factory_handoff_build_task_enabled) },
        { name = "SPEC_FACTORY_HANDOFF_LLM_SYNTHESIS", value = tostring(var.spec_factory_handoff_llm_synthesis) },
        { name = "SPEC_FACTORY_HANDOFF_SYNTHESIS_MAX_COST_USD", value = var.spec_factory_handoff_synthesis_max_cost_usd },
        { name = "SPEC_FACTORY_HANDOFF_SYNTHESIS_TIMEOUT_MS", value = var.spec_factory_handoff_synthesis_timeout_ms },
        { name = "SPEC_FACTORY_ADMIN_IDS", value = var.spec_factory_admin_ids },
        { name = "SPEC_FACTORY_QUALIFIER_MODEL_ID", value = var.spec_factory_model_id },
        { name = "SPEC_FACTORY_QUALIFIER_TIMEOUT_MS", value = var.spec_factory_qualifier_timeout_ms },
        { name = "COMPOSE_CHAT_MODEL_ID", value = var.compose_chat_model_id },
        { name = "COMPOSE_MAX_QUEUED_TURNS", value = tostring(var.compose_max_queued_turns) },
        { name = "COMPOSE_MAX_UPLOAD_BYTES", value = tostring(var.compose_max_upload_bytes) },
        { name = "COMPOSE_CHAT_TIMEOUT_MS", value = tostring(var.compose_chat_timeout_ms) },
        { name = "COMPOSE_CHAT_MAX_PROMPT_TOKENS", value = tostring(var.compose_chat_max_prompt_tokens) },
        { name = "COMPOSE_RETRY_BASE_MS", value = tostring(var.compose_retry_base_ms) },
        { name = "SPEC_FACTORY_REPO_DEEP_DIVE_ENABLED", value = tostring(var.spec_factory_repo_deep_dive_enabled) },
        { name = "SPEC_FACTORY_REPO_CACHE_BASE", value = var.spec_factory_legacy_runtime == "disabled" ? "/var/lib/spec-factory/repo-cache" : "/mnt/efs/specter-repo/spec-factory/repo-cache" },
        { name = "SPEC_FACTORY_REPO_CACHE_FRESHNESS_TTL_MS", value = tostring(var.oneshot_repo_cache_freshness_ttl_ms) },
        { name = "SPEC_FACTORY_TASK_WORKSPACE_BASE", value = var.spec_factory_legacy_runtime == "disabled" ? "/var/lib/spec-factory/tasks" : "/mnt/efs/specter-repo/spec-factory/tasks" },
        { name = "SPEC_FACTORY_EVIDENCE_WORKSPACE_BASE", value = var.spec_factory_legacy_runtime == "disabled" ? "/var/lib/spec-factory/evidence-workspaces" : "/mnt/efs/specter-repo/spec-factory/evidence-workspaces" },
        { name = "SPEC_FACTORY_WORKSPACE_BASE", value = var.spec_factory_legacy_runtime == "disabled" ? "/var/lib/spec-factory/repo-workspaces" : "/mnt/efs/specter-repo/spec-factory/workspaces" },
        { name = "SPEC_FACTORY_WORKTREE_BASE", value = "/var/lib/spec-factory/worktrees" },
        { name = "SPEC_FACTORY_ATTACHMENT_BUCKET", value = aws_s3_bucket.results.bucket },
        { name = "DB_HOST", value = var.spec_factory_rds_proxy_enabled ? aws_db_proxy.spec_factory[0].endpoint : var.db_host },
        { name = "DB_PORT", value = var.db_port },
        { name = "DB_NAME", value = var.spec_factory_aurora_enabled ? "specfactory" : var.db_name },
        { name = "DB_SSL", value = tostring(var.spec_factory_rds_proxy_enabled) },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "S3_BUCKET_PREFIX", value = "specter" },
        { name = "JIRA_BASE_URL", value = var.jira_base_url },
        { name = "JIRA_USERNAME", value = var.jira_username },
        { name = "CLAUDE_CODE_USE_BEDROCK", value = "1" },
        { name = "ANTHROPIC_MODEL", value = var.spec_factory_model_id },
        { name = "BEDROCK_MODEL", value = var.spec_factory_model_id },
        { name = "COMPOSE_WORKSPACE_BASE", value = var.spec_factory_legacy_runtime == "disabled" ? "/var/lib/spec-factory/compose" : "/mnt/efs/specter-repo/spec-factory/compose" },
        { name = "COMPOSE_WORKSPACE_VALIDATE_ON_STARTUP", value = tostring(var.compose_workspace_validate_on_startup) },
        { name = "COMPOSE_S3_PREFIX", value = "compose" },
        { name = "COMPOSE_MARKITDOWN_URL", value = "http://localhost:8080" },
        { name = "COMPOSE_VOXTRAL_MODEL_ID", value = var.compose_voxtral_model_id },
        { name = "COMPOSE_REPO_GROUNDING_ENABLED", value = tostring(var.compose_repo_grounding_enabled) },
        { name = "COMPOSE_MAX_GROUNDED_REPOS", value = tostring(var.compose_max_grounded_repos) },
        { name = "COMPOSE_REPO_GROUNDING_TOOL_BUDGET", value = tostring(var.compose_repo_grounding_tool_budget) },
        { name = "COMPOSE_REPO_GROUNDING_TIMEOUT_MS", value = tostring(var.compose_repo_grounding_timeout_ms) },
        { name = "COMPOSE_AUDIO_SEGMENT_SECONDS", value = tostring(var.compose_audio_segment_seconds) },
        { name = "COMPOSE_VOXTRAL_MAX_REQUEST_BYTES", value = tostring(var.compose_voxtral_max_request_bytes) },
        { name = "COMPOSE_CONVERT_TIMEOUT_MS", value = tostring(var.compose_convert_timeout_ms) },
        { name = "COMPOSE_EXTRACT_AUDIO_TIMEOUT_MS", value = tostring(var.compose_extract_audio_timeout_ms) },
        { name = "COMPOSE_TRANSCRIBE_SEGMENT_TIMEOUT_MS", value = tostring(var.compose_transcribe_segment_timeout_ms) },
        { name = "COMPOSE_CONVERSION_LEASE_MS", value = tostring(var.compose_conversion_lease_ms) },
        { name = "COMPOSE_CONVERSION_POLL_MS", value = tostring(var.compose_conversion_poll_ms) },
        { name = "COMPOSE_RETENTION_CLEANUP_ENABLED", value = tostring(each.key == "retention-worker" ? true : var.compose_retention_cleanup_enabled) },
        { name = "COMPOSE_WORKSPACE_RETENTION_DAYS", value = tostring(var.compose_workspace_retention_days) },
        { name = "COMPOSE_CLEANUP_LIMIT", value = tostring(var.compose_cleanup_limit) },
        { name = "COMPOSE_RETENTION_SWEEP_MS", value = tostring(var.compose_retention_sweep_ms) },
        { name = "SPEC_FACTORY_SOURCE_DELETE_UNDO_MINUTES", value = tostring(var.spec_factory_source_delete_undo_minutes) },
        { name = "SPEC_FACTORY_SOURCE_DELETE_SWEEP_MS", value = tostring(var.spec_factory_source_delete_sweep_ms) },
        { name = "SPEC_FACTORY_SOURCE_DELETE_PURGE_LIMIT", value = tostring(var.spec_factory_source_delete_purge_limit) },
        { name = "SPEC_FACTORY_WORKER_HEARTBEAT_RETENTION_DAYS", value = tostring(var.spec_factory_worker_heartbeat_retention_days) },
        { name = "SPEC_FACTORY_WORKER_HEARTBEAT_GC_LIMIT", value = tostring(var.spec_factory_worker_heartbeat_gc_limit) },
        { name = "COMPOSE_CLEANUP_DRY_RUN", value = tostring(var.compose_cleanup_dry_run) },
        { name = "COMPOSE_ARTIFACT_TMP_RETENTION_HOURS", value = tostring(var.compose_artifact_tmp_retention_hours) },
        { name = "COMPOSE_ARTIFACT_GC_LIMIT", value = tostring(var.compose_artifact_gc_limit) },
        { name = "COMPOSE_ARTIFACT_GC_MAX_DEPTH", value = tostring(var.compose_artifact_gc_max_depth) },
        { name = "SPEC_FACTORY_LLM_AUDIT_ARTIFACT_RETENTION_DAYS", value = tostring(var.spec_factory_llm_audit_artifact_retention_days) },
        { name = "SPEC_FACTORY_LLM_AUDIT_ARTIFACT_GC_LIMIT", value = tostring(var.spec_factory_llm_audit_artifact_gc_limit) },
        { name = "COMPOSE_S3_REACHABILITY_GC_ENABLED", value = tostring(var.compose_s3_reachability_gc_enabled) },
        { name = "COMPOSE_S3_REACHABILITY_GC_LIMIT", value = tostring(var.compose_s3_reachability_gc_limit) },
        { name = "COMPOSE_CONFLUENCE_ALLOWED_HOST_SUFFIXES", value = var.compose_confluence_allowed_host_suffixes },
        { name = "SPEC_FACTORY_VALKEY_URL", value = var.spec_factory_valkey_enabled ? "rediss://${aws_elasticache_replication_group.spec_factory[0].primary_endpoint_address}:6379" : "" },
        { name = "SPEC_FACTORY_DRAFT_WORKFLOW_V2_ENABLED", value = tostring(var.spec_factory_draft_workflow_v2_enabled) },
        { name = "SPEC_FACTORY_DRAFT_WORKFLOW_CONCURRENCY", value = tostring(var.spec_factory_draft_workflow_concurrency) },
        { name = "SPEC_FACTORY_LEGACY_RUNTIME", value = var.spec_factory_legacy_runtime },
        { name = "SPEC_FACTORY_IMAGE_PINNED", value = tostring(var.spec_factory_pin_image_by_digest) },
        { name = "SPEC_FACTORY_CERTIFICATION_ID", value = var.spec_factory_certification_id },
        { name = "SPEC_FACTORY_CONTEXT_V4_REPAIR_RUN_ID", value = tostring(var.spec_factory_context_v4_repair_run_id) },
        { name = "SPEC_FACTORY_SQS_VISIBILITY_TIMEOUT_SECONDS", value = tostring(lookup(local.spec_factory_queue_visibility_seconds, lookup(local.spec_factory_runtime_queues, each.key, "turn"), 900)) },
        { name = "SPEC_FACTORY_SQS_HEARTBEAT_SECONDS", value = tostring(var.spec_factory_sqs_heartbeat_seconds) },
        { name = "SPEC_FACTORY_QUEUE_RECEIPT_LEASE_MS", value = tostring((lookup(local.spec_factory_queue_visibility_seconds, lookup(local.spec_factory_runtime_queues, each.key, "turn"), 900) + 60) * 1000) },
        { name = "SPEC_FACTORY_OUTBOX_RETENTION_DAYS", value = tostring(var.spec_factory_outbox_retention_days) },
        { name = "SPEC_FACTORY_QUEUE_RECEIPT_RETENTION_DAYS", value = tostring(var.spec_factory_queue_receipt_retention_days) },
        { name = "SPEC_FACTORY_REPAIR_RECONCILE_LIMIT", value = tostring(var.spec_factory_repair_reconcile_limit) },
        { name = "SPEC_FACTORY_IMMUTABLE_ARTIFACT_ORPHAN_GRACE_HOURS", value = tostring(var.spec_factory_immutable_artifact_orphan_grace_hours) },
        { name = "SPEC_FACTORY_IMMUTABLE_ARTIFACT_GC_LIMIT", value = tostring(var.spec_factory_immutable_artifact_gc_limit) }
      ]

      secrets = concat([
        {
          name      = "DB_USER"
          valueFrom = "${local.spec_factory_database_secret_arn}:username::"
        },
        {
          name      = "DB_PASSWORD"
          valueFrom = "${local.spec_factory_database_secret_arn}:password::"
        }
        ], contains(["worker", "draft-worker"], each.key) ? [{
          name      = "JIRA_TOKEN"
          valueFrom = data.aws_secretsmanager_secret.jira_token.arn
          }] : [], contains(["worker", "turn-worker", "research-worker", "draft-worker"], each.key) ? [{
          name      = "GITHUB_REPO_TOKEN"
          valueFrom = data.aws_secretsmanager_secret.github_repo_token.arn
      }] : [])

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.spec_factory[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = each.value.log_prefix
        }
      }
    }
    ], each.value.include_markitdown ? [
    {
      name      = "compose-markitdown"
      image     = local.compose_markitdown_image
      essential = false

      memory = var.compose_markitdown_memory

      portMappings = [{
        containerPort = 8080
        hostPort      = 8080
        protocol      = "tcp"
      }]

      environment = [
        { name = "COMPOSE_AUDIO_SEGMENT_SECONDS", value = tostring(var.compose_audio_segment_seconds) },
        { name = "COMPOSE_AUDIO_MP3_BITRATE", value = var.compose_audio_mp3_bitrate },
        { name = "COMPOSE_AUDIO_MAX_SECONDS", value = tostring(var.compose_audio_max_seconds) },
        { name = "COMPOSE_AUDIO_MAX_BYTES", value = tostring(var.compose_audio_max_bytes) },
        { name = "MARKITDOWN_MAX_BYTES", value = tostring(var.compose_markitdown_max_bytes) },
        { name = "COMPOSE_CONFLUENCE_ALLOWED_HOST_SUFFIXES", value = var.compose_confluence_allowed_host_suffixes },
        { name = "MARKITDOWN_URL_MAX_BYTES", value = "10485760" },
        { name = "MARKITDOWN_URL_FETCH_TIMEOUT_SECONDS", value = "15" },
        { name = "MARKITDOWN_URL_MAX_REDIRECTS", value = "5" }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8080/health').status==200 else 1)\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.spec_factory[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "compose-markitdown-${each.key}"
        }
      }
    }
    ] : [], var.spec_factory_otel_enabled ? [{
      name              = "ecs-cwagent"
      image             = var.spec_factory_otel_sidecar_image
      cpu               = 64
      essential         = false
      memory            = var.spec_factory_otel_sidecar_memory
      memoryReservation = 128

      secrets = [{
        name      = "CW_CONFIG_CONTENT"
        valueFrom = aws_ssm_parameter.spec_factory_cwagent_config[0].arn
      }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.spec_factory[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "otel-${each.key}"
        }
      }
    }] : []
  ))

  tags = merge(local.common_tags, {
    Service = "spec-factory"
    Role    = each.key
  })
}

# ============================================================================
# ECS SERVICE
# ============================================================================

locals {
  spec_factory_runtime_subnet_ids = length(var.spec_factory_runtime_subnet_ids) > 0 ? var.spec_factory_runtime_subnet_ids : var.subnet_ids
  spec_factory_horizontal_scaling_requested = var.enable_spec_factory && (
    var.spec_factory_desired_count > 1 || var.spec_factory_autoscaling_enabled
  )
  spec_factory_ha_worker_minimums = {
    turn-worker       = var.spec_factory_turn_worker_desired_count
    context-worker    = var.spec_factory_context_worker_desired_count
    research-worker   = var.spec_factory_research_worker_desired_count
    conversion-worker = var.spec_factory_conversion_worker_desired_count
    draft-worker      = var.spec_factory_draft_worker_desired_count
    relay-worker      = var.spec_factory_relay_worker_desired_count
  }
}

data "aws_subnet" "spec_factory_runtime" {
  for_each = var.enable_spec_factory ? toset(local.spec_factory_runtime_subnet_ids) : toset([])
  id       = each.value
}

resource "aws_efs_mount_target" "spec_factory_runtime" {
  for_each = var.enable_spec_factory && var.spec_factory_legacy_runtime != "disabled" ? toset(var.spec_factory_additional_efs_mount_target_subnet_ids) : toset([])

  file_system_id  = data.aws_efs_file_system.specter_repo.id
  subnet_id       = each.value
  security_groups = [var.existing_efs_security_group_id]
}

check "spec_factory_runtime_subnets" {
  assert {
    condition = !local.spec_factory_horizontal_scaling_requested || (
      length(local.spec_factory_runtime_subnet_ids) >= 2 &&
      length(distinct([for subnet in data.aws_subnet.spec_factory_runtime : subnet.availability_zone])) >= 2 &&
      alltrue([
        for subnet in data.aws_subnet.spec_factory_runtime :
        subnet.vpc_id == local.vpc_id && subnet.map_public_ip_on_launch
      ])
    )
    error_message = "Horizontally scaled Spec Factory tasks require public runtime subnets in the configured VPC across at least two availability zones while assign_public_ip remains enabled."
  }
}

check "spec_factory_efs_mount_target_coverage" {
  assert {
    condition = !local.spec_factory_horizontal_scaling_requested || var.spec_factory_legacy_runtime == "disabled" || (
      alltrue([
        for subnet_id in var.spec_factory_additional_efs_mount_target_subnet_ids :
        contains(local.spec_factory_runtime_subnet_ids, subnet_id)
      ]) &&
      length(distinct([
        for subnet_id in var.spec_factory_additional_efs_mount_target_subnet_ids :
        try(data.aws_subnet.spec_factory_runtime[subnet_id].availability_zone, "")
        ])) >= length(distinct([
        for subnet in data.aws_subnet.spec_factory_runtime : subnet.availability_zone
      ])) - 1
    )
    error_message = "Horizontally scaled Spec Factory tasks that still mount the shared EFS filesystem require an additional mount target for every runtime availability zone not already covered by the existing filesystem."
  }
}

check "spec_factory_horizontal_scaling_gates" {
  assert {
    condition = !local.spec_factory_horizontal_scaling_requested || (
      var.spec_factory_valkey_enabled &&
      var.spec_factory_rds_proxy_enabled &&
      var.spec_factory_durable_events_required &&
      var.spec_factory_durable_turns == "on" &&
      var.spec_factory_queue_dispatch_mode == "primary" &&
      var.spec_factory_outbox_enabled &&
      (!var.spec_factory_worker_scale_in_enabled || var.spec_factory_ecs_task_protection_enabled) &&
      (!var.spec_factory_ecs_task_protection_enabled || var.spec_factory_ecs_task_protection_refresh_ms < var.spec_factory_ecs_task_protection_expires_minutes * 60000) &&
      !var.spec_factory_single_replica_alarm_enabled &&
      var.spec_factory_desired_count >= 2 &&
      var.spec_factory_api_max_count >= var.spec_factory_desired_count &&
      alltrue([for desired in values(local.spec_factory_ha_worker_minimums) : desired >= 2]) &&
      alltrue([
        for mode, desired in local.spec_factory_ha_worker_minimums :
        lookup(var.spec_factory_worker_max_counts, mode, 0) >= desired
      ]) &&
      alltrue([
        for mode in keys(local.spec_factory_ha_worker_minimums) :
        lookup(var.spec_factory_target_backlog_per_task, mode, 0) > 0
      ])
    )
    error_message = "Spec Factory horizontal scaling requires Valkey, RDS Proxy, strict durable events, durable primary queues/outbox, ECS task protection before worker scale-in, a protection refresh shorter than expiry, the rollback-only single-replica alarm disabled, at least two API/critical-worker tasks, valid maximums, and positive backlog targets."
  }
}

resource "aws_ecs_service" "spec_factory" {
  #checkov:skip=CKV_AWS_333:Spec Factory follows the existing shared subnet/public-IP ECS pattern; private subnet/NAT migration is a separate infra change.
  count           = var.enable_spec_factory ? 1 : 0
  name            = "SPEC-FACTORY"
  cluster         = aws_ecs_cluster.specter.id
  task_definition = aws_ecs_task_definition.spec_factory[0].arn
  # This service is the stateless API tier in the v4 topology. It may scale
  # above one only after durable events/tokens, primary worker queues, and
  # canonical Valkey fanout are active. The optional legacy alarm below protects
  # earlier rollout states and is disabled at the certified API cutover.
  desired_count = var.spec_factory_desired_count
  launch_type   = "FARGATE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.spec_factory_runtime_subnet_ids
    security_groups  = [aws_security_group.spec_factory_tasks[0].id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.spec_factory[0].arn
    container_name   = "spec-factory"
    container_port   = 3012
  }

  depends_on = [aws_lb_listener_rule.dashboard_spec_factory_api]

  tags = merge(local.common_tags, {
    Service = "SPEC-FACTORY"
  })
}

resource "aws_ecs_service" "spec_factory_workers" {
  #checkov:skip=CKV_AWS_333:Split Spec Factory workers follow the existing shared subnet/public-IP ECS pattern; private subnet/NAT migration is a separate infra change.
  for_each = var.enable_spec_factory ? local.spec_factory_worker_services : {}

  name            = each.value.service_name
  cluster         = aws_ecs_cluster.specter.id
  task_definition = aws_ecs_task_definition.spec_factory_workers[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.spec_factory_runtime_subnet_ids
    security_groups  = [aws_security_group.spec_factory_tasks[0].id]
    assign_public_ip = true
  }

  tags = merge(local.common_tags, {
    Service = each.value.service_name
    Role    = each.key
  })
}

# ============================================================================
# DASHBOARD ALB ROUTE
# ============================================================================

resource "aws_lb_listener_rule" "dashboard_spec_factory_api" {
  count        = var.enable_spec_factory ? 1 : 0
  listener_arn = aws_lb_listener.dashboard_https.arn
  priority     = 140

  action {
    type             = "forward"
    order            = 1
    target_group_arn = aws_lb_target_group.spec_factory[0].arn
  }

  condition {
    path_pattern {
      values = ["/api/spec-factory", "/api/spec-factory/*"]
    }
  }
}

output "spec_factory_ecr_url" {
  description = "ECR repository URL for pushing Spec Factory images"
  value       = var.enable_spec_factory ? aws_ecr_repository.spec_factory[0].repository_url : null
}

output "compose_markitdown_ecr_repository_url" {
  value       = var.enable_spec_factory ? aws_ecr_repository.compose_markitdown[0].repository_url : null
  description = "ECR repository URL for the compose markitdown sidecar"
}

output "spec_factory_worker_service_names" {
  description = "Optional split-mode Spec Factory worker ECS service names keyed by runtime mode"
  value       = var.enable_spec_factory ? { for mode, service in aws_ecs_service.spec_factory_workers : mode => service.name } : {}
}

# ============================================================================
# CLOUDWATCH ALARM - LEGACY SINGLE-REPLICA GUARDRAIL
# ============================================================================
# This alarm protects only the pre-v4 all-local/rollback topology. Disable it
# after the API service is stateless and the certified split-runtime gates have
# passed; API autoscaling and per-role health/queue alarms then take over.
#
# Routes to var.spec_factory_alarm_topic_arn when provided; otherwise falls
# back to the existing oneshot_alerts SNS topic. When both are empty, the
# alarm is created without a notification target and still surfaces in the
# CloudWatch console.
resource "aws_cloudwatch_metric_alarm" "spec_factory_running_tasks_high" {
  count = var.enable_spec_factory && var.spec_factory_single_replica_alarm_enabled ? 1 : 0

  alarm_name          = "${var.environment}-spec-factory-running-tasks-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 300
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "Legacy Spec Factory topology is running more than one API/all-local task. Scale back while this guard is enabled, or complete the certified split-runtime cutover and disable the rollback-only alarm."
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.spec_factory_alarm_actions
  ok_actions          = local.spec_factory_alarm_actions

  dimensions = {
    ClusterName = aws_ecs_cluster.specter.name
    ServiceName = aws_ecs_service.spec_factory[0].name
  }

  tags = merge(local.common_tags, {
    Service = "spec-factory"
    Purpose = "single-replica-guardrail-alarm"
  })
}

resource "aws_cloudwatch_metric_alarm" "spec_factory_api_running_tasks_low" {
  count = var.enable_spec_factory && !var.spec_factory_single_replica_alarm_enabled && var.spec_factory_worker_health_alarm_enabled ? 1 : 0

  alarm_name          = "${var.environment}-spec-factory-api-running-tasks-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 300
  statistic           = "Minimum"
  threshold           = var.spec_factory_desired_count
  alarm_description   = "Spec Factory API service has fewer running tasks than the HA floor (${var.spec_factory_desired_count}) for 15 minutes"
  treat_missing_data  = "breaching"
  alarm_actions       = local.spec_factory_alarm_actions
  ok_actions          = local.spec_factory_alarm_actions

  dimensions = {
    ClusterName = aws_ecs_cluster.specter.name
    ServiceName = aws_ecs_service.spec_factory[0].name
  }

  tags = merge(local.common_tags, {
    Service = "SPEC-FACTORY"
    Role    = "api"
    Purpose = "api-health-alarm"
  })
}

resource "aws_cloudwatch_metric_alarm" "spec_factory_worker_running_tasks_low" {
  for_each = var.enable_spec_factory && var.spec_factory_worker_health_alarm_enabled ? local.spec_factory_worker_services_with_desired_tasks : {}

  alarm_name          = "${var.environment}-spec-factory-${each.key}-running-tasks-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 300
  statistic           = "Minimum"
  threshold           = each.value.desired_count
  alarm_description   = "Spec Factory ${each.key} worker service has fewer running tasks than desired (${each.value.desired_count}) for 15 minutes — possible crash loop or placement failure"
  treat_missing_data  = "breaching"
  alarm_actions       = local.spec_factory_alarm_actions
  ok_actions          = local.spec_factory_alarm_actions

  dimensions = {
    ClusterName = aws_ecs_cluster.specter.name
    ServiceName = aws_ecs_service.spec_factory_workers[each.key].name
  }

  tags = merge(local.common_tags, {
    Service = each.value.service_name
    Role    = each.key
    Purpose = "worker-health-alarm"
  })
}

# Queue-backed horizontal scaling. SQS backlog is the primary target; queue-age
# alarms above remain the SLO tripwire when provider or database capacity is the
# actual bottleneck.
locals {
  spec_factory_autoscaled_workers = {
    turn-worker       = "turn"
    context-worker    = "context"
    research-worker   = "research"
    conversion-worker = "conversion"
    draft-worker      = "draft"
    relay-worker      = "events"
  }
}

resource "aws_appautoscaling_target" "spec_factory_api" {
  count = var.enable_spec_factory && var.spec_factory_autoscaling_enabled ? 1 : 0

  max_capacity       = var.spec_factory_api_max_count
  min_capacity       = var.spec_factory_desired_count
  resource_id        = "service/${aws_ecs_cluster.specter.name}/${aws_ecs_service.spec_factory[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "spec_factory_api_cpu" {
  count = var.enable_spec_factory && var.spec_factory_autoscaling_enabled ? 1 : 0

  name               = "${var.environment}-spec-factory-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.spec_factory_api[0].resource_id
  scalable_dimension = aws_appautoscaling_target.spec_factory_api[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.spec_factory_api[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 55
    scale_in_cooldown  = 180
    scale_out_cooldown = 30
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "spec_factory_api_requests" {
  count = var.enable_spec_factory && var.spec_factory_autoscaling_enabled ? 1 : 0

  name               = "${var.environment}-spec-factory-api-requests"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.spec_factory_api[0].resource_id
  scalable_dimension = aws_appautoscaling_target.spec_factory_api[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.spec_factory_api[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = var.spec_factory_api_requests_per_target
    scale_in_cooldown  = 180
    scale_out_cooldown = 30

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.dashboard.arn_suffix}/${aws_lb_target_group.spec_factory[0].arn_suffix}"
    }
  }
}

resource "aws_appautoscaling_target" "spec_factory_workers" {
  for_each = var.enable_spec_factory && var.spec_factory_autoscaling_enabled ? local.spec_factory_autoscaled_workers : {}

  max_capacity = lookup(
    var.spec_factory_worker_max_counts,
    each.key,
    local.spec_factory_worker_services[each.key].desired_count,
  )
  min_capacity       = local.spec_factory_worker_services[each.key].desired_count
  resource_id        = "service/${aws_ecs_cluster.specter.name}/${aws_ecs_service.spec_factory_workers[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "spec_factory_worker_backlog" {
  for_each = var.enable_spec_factory && var.spec_factory_autoscaling_enabled ? local.spec_factory_autoscaled_workers : {}

  name               = "${var.environment}-spec-factory-${each.key}-backlog"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.spec_factory_workers[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.spec_factory_workers[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.spec_factory_workers[each.key].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value = lookup(
      var.spec_factory_target_backlog_per_task,
      each.key,
      1,
    )
    scale_in_cooldown  = 300
    scale_out_cooldown = each.key == "turn-worker" ? 15 : 45
    disable_scale_in   = !var.spec_factory_worker_scale_in_enabled

    customized_metric_specification {
      metric_name = "ApproximateNumberOfMessagesVisible"
      namespace   = "AWS/SQS"
      statistic   = "Average"

      dimensions {
        name  = "QueueName"
        value = aws_sqs_queue.spec_factory[local.spec_factory_autoscaled_workers[each.key]].name
      }
    }
  }
}

# ============================================================================
# APPLICATION TELEMETRY DASHBOARD AND SLO ALARMS
# ============================================================================

resource "aws_cloudwatch_dashboard" "spec_factory" {
  count          = var.enable_spec_factory && var.spec_factory_otel_enabled ? 1 : 0
  dashboard_name = "${var.environment}-spec-factory"

  dashboard_body = jsonencode({
    start          = "-PT6H"
    periodOverride = "inherit"
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Queue age percentiles"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 60
          stacked = false
          yAxis   = { left = { min = 0, label = "Milliseconds" } }
          metrics = [
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.turn_queue_age_ms", { stat = "p50", label = "Turn p50" }],
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.turn_queue_age_ms", { stat = "p95", label = "Turn p95" }],
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.turn_queue_age_ms", { stat = "p99", label = "Turn p99" }],
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.draft_queue_age_ms", { stat = "p50", label = "Draft p50" }],
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.draft_queue_age_ms", { stat = "p95", label = "Draft p95" }],
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.draft_queue_age_ms", { stat = "p99", label = "Draft p99" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Work run duration p50 / p95 / p99"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 60
          stacked = false
          yAxis   = { left = { min = 0, label = "Milliseconds" } }
          metrics = [
            [{ expression = "SEARCH('{${var.spec_factory_otel_metrics_namespace}} MetricName=\"spec_factory.work.run_duration_ms\"', 'p50', 60)", id = "run_p50", label = "p50", period = 60 }],
            [{ expression = "SEARCH('{${var.spec_factory_otel_metrics_namespace}} MetricName=\"spec_factory.work.run_duration_ms\"', 'p95', 60)", id = "run_p95", label = "p95", period = 60 }],
            [{ expression = "SEARCH('{${var.spec_factory_otel_metrics_namespace}} MetricName=\"spec_factory.work.run_duration_ms\"', 'p99', 60)", id = "run_p99", label = "p99", period = 60 }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "LLM provider latency p50 / p95 / p99"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 60
          stacked = false
          yAxis   = { left = { min = 0, label = "Milliseconds" } }
          metrics = [
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.provider_latency_ms", { stat = "p50", label = "p50" }],
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.provider_latency_ms", { stat = "p95", label = "p95" }],
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.provider_latency_ms", { stat = "p99", label = "p99" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Coordinator decision latency p50 / p95 / p99"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 60
          stacked = false
          yAxis   = { left = { min = 0, label = "Milliseconds" } }
          metrics = [
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.coordinator_latency_ms", { stat = "p50", label = "p50" }],
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.coordinator_latency_ms", { stat = "p95", label = "p95" }],
            [var.spec_factory_otel_metrics_namespace, "spec_factory.slo.coordinator_latency_ms", { stat = "p99", label = "p99" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Work outcomes by type"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 60
          stacked = true
          metrics = [[{ expression = "SEARCH('{${var.spec_factory_otel_metrics_namespace}} MetricName=\"spec_factory.work.outcome\"', 'Sum', 60)", id = "work_outcomes", label = "", period = 60 }]]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Coordinator selected / fallback / rejected"
          region  = var.aws_region
          view    = "timeSeries"
          period  = 60
          stacked = true
          metrics = [[{ expression = "SEARCH('{${var.spec_factory_otel_metrics_namespace}} MetricName=\"spec_factory.coordinator.routes\"', 'Sum', 60)", id = "coordinator_routes", label = "", period = 60 }]]
        }
      }
    ]
  })
}

locals {
  spec_factory_latency_alarms = {
    turn_queue = {
      metric_name = "spec_factory.slo.turn_queue_age_ms"
      threshold   = var.spec_factory_turn_queue_p95_alarm_threshold_ms
      description = "Interactive Spec Factory turn queue p95 exceeded the rollout threshold"
    }
    draft_queue = {
      metric_name = "spec_factory.slo.draft_queue_age_ms"
      threshold   = var.spec_factory_draft_queue_p95_alarm_threshold_ms
      description = "Spec Factory draft queue p95 exceeded the rollout threshold"
    }
    coordinator = {
      metric_name = "spec_factory.slo.coordinator_latency_ms"
      threshold   = var.spec_factory_coordinator_p95_alarm_threshold_ms
      description = "Spec Factory coordinator decision p95 exceeded the rollout threshold"
    }
    provider = {
      metric_name = "spec_factory.slo.provider_latency_ms"
      threshold   = var.spec_factory_provider_p95_alarm_threshold_ms
      description = "Spec Factory LLM provider p95 exceeded the rollout threshold"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "spec_factory_latency_p95" {
  for_each = var.enable_spec_factory && var.spec_factory_otel_enabled && var.spec_factory_latency_alarms_enabled ? local.spec_factory_latency_alarms : {}

  alarm_name                            = "${var.environment}-spec-factory-${replace(each.key, "_", "-")}-p95-high"
  comparison_operator                   = "GreaterThanThreshold"
  evaluation_periods                    = 2
  datapoints_to_alarm                   = 2
  metric_name                           = each.value.metric_name
  namespace                             = var.spec_factory_otel_metrics_namespace
  period                                = 300
  extended_statistic                    = "p95"
  threshold                             = each.value.threshold
  alarm_description                     = each.value.description
  evaluate_low_sample_count_percentiles = "ignore"
  treat_missing_data                    = "notBreaching"
  alarm_actions                         = local.spec_factory_alarm_actions
  ok_actions                            = local.spec_factory_alarm_actions

  tags = merge(local.common_tags, {
    Service = "spec-factory"
    Purpose = "latency-slo-alarm"
    SLO     = each.key
  })
}

resource "aws_cloudwatch_metric_alarm" "spec_factory_coordinator_success_rate" {
  count = var.enable_spec_factory && var.spec_factory_otel_enabled && var.spec_factory_latency_alarms_enabled ? 1 : 0

  alarm_name          = "${var.environment}-spec-factory-coordinator-success-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 99
  alarm_description   = "Spec Factory coordinator selected-route success rate is below 99 percent"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.spec_factory_alarm_actions
  ok_actions          = local.spec_factory_alarm_actions

  metric_query {
    id          = "success_rate"
    expression  = "IF(attempts > 0, 100 * successes / attempts, 100)"
    label       = "Coordinator success percent"
    return_data = true
  }

  metric_query {
    id          = "attempts"
    return_data = false
    metric {
      metric_name = "spec_factory.slo.coordinator_attempts"
      namespace   = var.spec_factory_otel_metrics_namespace
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "successes"
    return_data = false
    metric {
      metric_name = "spec_factory.slo.coordinator_successes"
      namespace   = var.spec_factory_otel_metrics_namespace
      period      = 300
      stat        = "Sum"
    }
  }

  tags = merge(local.common_tags, {
    Service = "spec-factory"
    Purpose = "coordinator-success-slo-alarm"
  })
}
