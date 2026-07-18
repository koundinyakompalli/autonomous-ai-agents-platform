# Dashboard ECS Configuration
# Pixel-art office UI showing all Specter agents and their live task status.
#
# Architecture:
#   Browser -> ALB (HTTPS) -> Dashboard ECS (port 3001)
#   Dashboard -> RDS (read-only DB queries for agents/tasks)
#
# Reuse:
#   - aws_ecs_cluster.specter          (shared ECS cluster)
#   - aws_iam_role.ecs_execution_role  (shared execution role, already has DB secret access)
#   - data.aws_secretsmanager_secret.db_credentials  (shared DB secret ref)
#   - data.aws_iam_role.existing_task_role  (shared task role — no extra AWS permissions needed)
#   - var.harvey_certificate_arn       (*.mhkdevsandbox.com wildcard cert covers productFactory.*)
#   - var.harvey_alb_subnet_ids        (same public subnets for ALB)
#   - local.common_tags / local.vpc_id (shared locals)
#
# URL: https://productFactory.mhkdevsandbox.com

# ============================================================================
# ECR REPOSITORY
# ============================================================================

resource "aws_ecr_repository" "dashboard" {
  name                 = "specter/dashboard"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Service = "dashboard"
  })
}

resource "aws_ecr_lifecycle_policy" "dashboard" {
  repository = aws_ecr_repository.dashboard.name

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
        description  = "Keep only last 10 tagged images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v", "latest"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}

resource "aws_ecr_repository" "watchdog_mcp" {
  count                = var.enable_watchdog ? 1 : 0
  name                 = "specter/watchdog-mcp"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Service = "watchdog-mcp"
  })
}

resource "aws_ecr_lifecycle_policy" "watchdog_mcp" {
  count      = var.enable_watchdog ? 1 : 0
  repository = aws_ecr_repository.watchdog_mcp[0].name

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
        description  = "Keep only last 10 tagged images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v", "latest"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}

# ============================================================================
# CLOUDWATCH LOG GROUP
# ============================================================================

resource "aws_cloudwatch_log_group" "dashboard" {
  name              = "/ecs/specter/dashboard"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Service = "dashboard"
  })
}

resource "aws_cloudwatch_log_group" "watchdog_mcp" {
  count             = var.enable_watchdog ? 1 : 0
  name              = "/ecs/specter/watchdog-mcp"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Service = "watchdog-mcp"
  })
}

# ============================================================================
# ECS TASK DEFINITION
# ============================================================================

resource "aws_ecs_task_definition" "dashboard" {
  family                   = "specter-dashboard"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.dashboard_cpu
  memory                   = var.dashboard_memory
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  # Reuse the shared task role. Dashboard write actions can publish OneShot
  # retry messages through the same SQS permissions used by the workers.
  task_role_arn = data.aws_iam_role.existing_task_role.arn

  container_definitions = jsonencode(concat([merge({
    name  = "dashboard"
    image = "${aws_ecr_repository.dashboard.repository_url}:latest"

    portMappings = [{
      containerPort = 3001
      hostPort      = 3001
      protocol      = "tcp"
    }]

    healthCheck = {
      # wget is available on node:alpine; curl is not installed by default
      command     = ["CMD-SHELL", "wget -qO- http://localhost:3001/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }

    environment = concat([
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3001" },
      { name = "DB_HOST", value = var.db_host },
      { name = "DB_PORT", value = var.db_port },
      { name = "DB_NAME", value = var.db_name },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "JIRA_BASE_URL", value = var.jira_base_url },
      { name = "JIRA_USERNAME", value = var.jira_username },
      { name = "DASHBOARD_OPERATOR_ID_HEADER", value = var.dashboard_operator_id_header },
      { name = "DASHBOARD_OPERATOR_NAME_HEADER", value = var.dashboard_operator_name_header },
      { name = "COREAPP_PREVIEW_URL", value = var.dashboard_coreapp_preview_url },
      { name = "S3_BUCKET_PREFIX", value = "specter" },
      { name = "S3_TASK_BUCKET", value = var.s3_task_bucket },
      { name = "S3_RESULT_BUCKET", value = var.s3_result_bucket },
      ], var.enable_oneshot ? [
      { name = "COREAPP_PREVIEW_WORKFLOW_ID", value = "coreapp-preview-deploy.yml" },
      { name = "GITHUB_ACTIONS_REPO_OWNER", value = "mhk-repos" },
      { name = "GITHUB_ACTIONS_REPO_NAME", value = "cp-autonomous-ai-agents-platform" },
      { name = "GITHUB_ACTIONS_DISPATCH_REF", value = "main" },
      { name = "ONESHOT_PLANNING_QUEUE_URL", value = aws_sqs_queue.oneshot["planning"].url },
      { name = "ONESHOT_REVIEW_QUEUE_URL", value = aws_sqs_queue.oneshot["review"].url },
      { name = "ONESHOT_IMPLEMENTATION_QUEUE_URL", value = aws_sqs_queue.oneshot["implementation"].url },
      { name = "ONESHOT_CODE_REVIEW_QUEUE_URL", value = aws_sqs_queue.oneshot["code_review"].url },
      { name = "ONESHOT_TESTING_QUEUE_URL", value = aws_sqs_queue.oneshot["testing"].url },
      { name = "ONESHOT_STATISTICS_LLM_MODEL_ID", value = trimspace(var.oneshot_statistics_llm_model_id) != "" ? trimspace(var.oneshot_statistics_llm_model_id) : var.bedrock_model_id },
      { name = "ONESHOT_STATISTICS_MIN_SAMPLE_SIZE", value = "5" },
      { name = "QUALIFIER_DESIRED_COUNT", value = tostring(var.qualifier_desired_count) },
      { name = "ONESHOT_PLANNER_DESIRED_COUNT", value = tostring(var.oneshot_planner_desired_count) },
      { name = "ONESHOT_REVIEWER_DESIRED_COUNT", value = tostring(var.oneshot_reviewer_desired_count) },
      { name = "ONESHOT_IMPLEMENTER_DESIRED_COUNT", value = tostring(var.oneshot_implementer_desired_count) },
      { name = "ONESHOT_CODE_REVIEWER_DESIRED_COUNT", value = tostring(var.oneshot_code_reviewer_desired_count) },
      { name = "ONESHOT_TESTER_DESIRED_COUNT", value = tostring(var.oneshot_tester_desired_count) },
      ] : [], var.enable_watchdog ? [
      { name = "WATCHDOG_INVESTIGATOR", value = var.watchdog_investigator },
      { name = "WATCHDOG_MCP_HTTP_URL", value = "http://127.0.0.1:8000/mcp" },
      { name = "WATCHDOG_MCP_AUTH_MODE", value = "sandbox_static_secret" },
      { name = "WATCHDOG_ALLOW_LOCAL_OPERATOR_FALLBACK", value = "true" },
      { name = "WATCHDOG_USER_ID", value = "watchdog-public" },
      { name = "WATCHDOG_USER_DISPLAY", value = "Watchdog Public Operator" },
      { name = "WATCHDOG_TARGET_AWS_ACCOUNT_ID", value = var.watchdog_prod_account_id },
      { name = "WATCHDOG_EVIDENCE_BUCKET", value = var.watchdog_evidence_bucket },
      { name = "WATCHDOG_EVIDENCE_REGION", value = var.aws_region },
      { name = "WATCHDOG_RESULT_BUCKET", value = var.s3_result_bucket },
      { name = "WATCHDOG_DARCI_TASK_BUCKET", value = var.s3_task_bucket },
      { name = "WATCHDOG_DARCI_TASK_REGION", value = var.aws_region },
      { name = "WATCHDOG_LLM_MODEL_ID", value = var.bedrock_model_id },
      { name = "WATCHDOG_BEDROCK_REGION", value = var.bedrock_region },
      { name = "WATCHDOG_LLM_MAX_OUTPUT_TOKENS", value = tostring(var.watchdog_llm_max_output_tokens) },
      { name = "WATCHDOG_CLAUDE_MAX_TURNS", value = tostring(var.watchdog_claude_max_turns) },
      { name = "WATCHDOG_CLAUDE_TIMEOUT_MS", value = tostring(var.watchdog_claude_timeout_ms) },
      { name = "WATCHDOG_AGENTIC_MCP_LOOP", value = var.watchdog_agentic_mcp_loop },
      { name = "CLAUDE_CODE_USE_BEDROCK", value = "1" },
      { name = "ANTHROPIC_MODEL", value = var.bedrock_model_id },
      { name = "BEDROCK_MODEL", value = var.bedrock_model_id },
    ] : [])

    # DB credentials injected by execution role at startup
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
      }
      ], var.enable_oneshot ? [
      {
        name      = "GITHUB_ACTIONS_DISPATCH_TOKEN"
        valueFrom = data.aws_secretsmanager_secret.github_write_token[0].arn
      },
      {
        name      = "ONESHOT_DEPLOY_WEBHOOK_SECRET"
        valueFrom = data.aws_secretsmanager_secret.oneshot_deploy_webhook_secret[0].arn
      },
      {
        name      = "GITHUB_APP_WEBHOOK_SECRET"
        valueFrom = data.aws_secretsmanager_secret.github_app_webhook_secret[0].arn
      }
      ] : [], local.oneshot_github_app_credentials_secret_enabled ? [
      {
        name      = "GITHUB_APP_CREDENTIALS"
        valueFrom = data.aws_secretsmanager_secret.github_app_credentials[0].arn
      }
    ] : [])

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.dashboard.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "dashboard"
      }
    }
    }, var.enable_watchdog ? {
    dependsOn = [
      {
        containerName = "watchdog-mcp"
        condition     = "HEALTHY"
      }
    ]
    } : {})], var.enable_watchdog ? [{
    name      = "watchdog-mcp"
    image     = "${aws_ecr_repository.watchdog_mcp[0].repository_url}:${var.watchdog_mcp_image_tag}"
    essential = true

    portMappings = [{
      containerPort = 8000
      hostPort      = 8000
      protocol      = "tcp"
    }]

    healthCheck = {
      command     = ["CMD-SHELL", "python -c \"import socket; s=socket.create_connection(('127.0.0.1',8000),3); s.close()\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    environment = [
      { name = "WATCHDOG_AWS_AUTH_MODE", value = "sandbox_static_secret" },
      { name = "WATCHDOG_PROD_READER_SECRET_ARN", value = data.aws_secretsmanager_secret.watchdog_prod_reader[0].arn },
      { name = "WATCHDOG_SECRETS_REGION", value = var.aws_region },
      { name = "WATCHDOG_AWS_ACCOUNT_ID", value = var.watchdog_prod_account_id },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "AWS_DEFAULT_REGION", value = var.aws_region },
      { name = "WATCHDOG_MCP_TRANSPORT", value = "streamable-http" },
      { name = "WATCHDOG_MCP_HOST", value = "0.0.0.0" },
      { name = "WATCHDOG_MCP_PORT", value = "8000" },
      { name = "WATCHDOG_MCP_STATELESS_HTTP", value = "1" },
      { name = "WATCHDOG_DATA_DIR", value = "/app/data" },
      { name = "JIRA_URL", value = var.jira_base_url },
      { name = "JIRA_USERNAME", value = var.jira_username },
    ]

    secrets = [
      {
        name      = "JIRA_API_TOKEN"
        valueFrom = data.aws_secretsmanager_secret.jira_token.arn
      }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.watchdog_mcp[0].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "watchdog-mcp"
      }
    }
  }] : []))

  tags = merge(local.common_tags, {
    Service = "dashboard"
  })
}

# ============================================================================
# ALB
# ============================================================================

resource "aws_lb" "dashboard" {
  name               = "specter-dashboard-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.dashboard_alb.id]
  # Reuse same public subnets as Harvey ALB
  subnets = length(var.harvey_alb_subnet_ids) > 0 ? var.harvey_alb_subnet_ids : var.subnet_ids

  tags = merge(local.common_tags, {
    Name    = "specter-dashboard-alb"
    Service = "dashboard"
  })
}

# HTTPS — reuses the existing *.mhkdevsandbox.com wildcard cert
resource "aws_lb_listener" "dashboard_https" {
  load_balancer_arn = aws_lb.dashboard.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.harvey_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.dashboard.arn
  }

  lifecycle {
    precondition {
      condition = !var.dashboard_enable_cognito_auth || (
        var.dashboard_cognito_user_pool_arn != null &&
        var.dashboard_cognito_user_pool_client_id != null &&
        var.dashboard_cognito_user_pool_domain != null
      )
      error_message = "Dashboard Cognito auth requires dashboard_cognito_user_pool_arn, dashboard_cognito_user_pool_client_id, and dashboard_cognito_user_pool_domain."
    }
  }

  tags = merge(local.common_tags, {
    Service = "dashboard"
  })
}

resource "aws_lb_listener_rule" "dashboard_deploy_auth_start" {
  count = var.dashboard_enable_cognito_auth ? 1 : 0

  listener_arn = aws_lb_listener.dashboard_https.arn
  priority     = 100

  action {
    type  = "authenticate-cognito"
    order = 1

    authenticate_cognito {
      user_pool_arn       = var.dashboard_cognito_user_pool_arn
      user_pool_client_id = var.dashboard_cognito_user_pool_client_id
      user_pool_domain    = var.dashboard_cognito_user_pool_domain
      scope               = "openid email profile"
    }
  }

  action {
    type             = "forward"
    order            = 2
    target_group_arn = aws_lb_target_group.dashboard.arn
  }

  condition {
    path_pattern {
      values = ["/auth/deploy/start"]
    }
  }
}

resource "aws_lb_listener_rule" "dashboard_deploy_request_api" {
  count = var.dashboard_enable_cognito_auth ? 1 : 0

  listener_arn = aws_lb_listener.dashboard_https.arn
  priority     = 110

  action {
    type  = "authenticate-cognito"
    order = 1

    authenticate_cognito {
      user_pool_arn       = var.dashboard_cognito_user_pool_arn
      user_pool_client_id = var.dashboard_cognito_user_pool_client_id
      user_pool_domain    = var.dashboard_cognito_user_pool_domain
      scope               = "openid email profile"
    }
  }

  action {
    type             = "forward"
    order            = 2
    target_group_arn = aws_lb_target_group.dashboard.arn
  }

  condition {
    path_pattern {
      values = [
        "/api/oneshot/deploy-requests",
        "/api/oneshot/deploy-requests/*",
      ]
    }
  }
}

resource "aws_lb_listener_rule" "dashboard_oneshot_run_request_auth" {
  count = var.dashboard_enable_cognito_auth ? 1 : 0

  listener_arn = aws_lb_listener.dashboard_https.arn
  priority     = 120

  action {
    type  = "authenticate-cognito"
    order = 1

    authenticate_cognito {
      user_pool_arn       = var.dashboard_cognito_user_pool_arn
      user_pool_client_id = var.dashboard_cognito_user_pool_client_id
      user_pool_domain    = var.dashboard_cognito_user_pool_domain
      scope               = "openid email profile"
    }
  }

  action {
    type             = "forward"
    order            = 2
    target_group_arn = aws_lb_target_group.dashboard.arn
  }

  condition {
    path_pattern {
      values = [
        "/auth/oneshot-run/start",
        "/api/oneshot/run-requests",
        "/api/oneshot/run-requests/*",
        "/api/oneshot/runs/*/retry",
      ]
    }
  }
}

resource "aws_lb_listener_rule" "dashboard_repo_router_auth" {
  count = var.dashboard_enable_cognito_auth ? 1 : 0

  listener_arn = aws_lb_listener.dashboard_https.arn
  priority     = 130

  action {
    type  = "authenticate-cognito"
    order = 1

    authenticate_cognito {
      user_pool_arn       = var.dashboard_cognito_user_pool_arn
      user_pool_client_id = var.dashboard_cognito_user_pool_client_id
      user_pool_domain    = var.dashboard_cognito_user_pool_domain
      scope               = "openid email profile"
    }
  }

  action {
    type             = "forward"
    order            = 2
    target_group_arn = aws_lb_target_group.dashboard.arn
  }

  condition {
    path_pattern {
      values = [
        "/auth/repo-router/start",
        "/api/oneshot/repo-router/confirmations/*/resolve",
      ]
    }
  }
}

# HTTP → HTTPS redirect
resource "aws_lb_listener" "dashboard_http_redirect" {
  load_balancer_arn = aws_lb.dashboard.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = merge(local.common_tags, {
    Service = "dashboard"
  })
}

resource "aws_lb_target_group" "dashboard" {
  name        = "specter-dashboard-tg"
  port        = 3001
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health"
    port                = "3001"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  deregistration_delay = 30

  tags = merge(local.common_tags, {
    Name    = "specter-dashboard-tg"
    Service = "dashboard"
  })
}

# ============================================================================
# ECS SERVICE
# ============================================================================

resource "aws_ecs_service" "dashboard" {
  name            = "DASHBOARD"
  cluster         = aws_ecs_cluster.specter.id
  task_definition = aws_ecs_task_definition.dashboard.arn
  desired_count   = var.dashboard_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.dashboard_tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.dashboard.arn
    container_name   = "dashboard"
    container_port   = 3001
  }

  depends_on = [aws_lb_listener.dashboard_https]

  tags = merge(local.common_tags, {
    Service = "DASHBOARD"
  })
}

# ============================================================================
# SECURITY GROUPS
# ============================================================================

resource "aws_security_group" "dashboard_alb" {
  name        = "specter-dashboard-alb"
  description = "Security group for Dashboard ALB"
  vpc_id      = local.vpc_id

  ingress {
    description = "HTTPS from dashboard CIDR allowlist"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.dashboard_allowed_cidr_blocks
  }

  ingress {
    description = "HTTPS from dashboard extra CIDR allowlist"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.dashboard_https_extra_cidr_blocks
  }

  dynamic "ingress" {
    for_each = length(var.dashboard_offshore_workstation_cidr_blocks) > 0 ? [var.dashboard_offshore_workstation_cidr_blocks] : []

    content {
      description = "Offshore Workstation"
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = ingress.value
    }
  }

  ingress {
    description = "HTTP redirect from dashboard CIDR allowlist"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.dashboard_allowed_cidr_blocks
  }

  egress {
    description = "To Dashboard ECS tasks"
    from_port   = 3001
    to_port     = 3001
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "To Spec Factory ECS tasks"
    from_port   = 3012
    to_port     = 3012
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name    = "specter-dashboard-alb"
    Service = "dashboard"
  })
}

resource "aws_security_group" "dashboard_tasks" {
  name        = "specter-dashboard-tasks"
  description = "Security group for Dashboard ECS tasks"
  vpc_id      = local.vpc_id

  ingress {
    description     = "From ALB on port 3001"
    from_port       = 3001
    to_port         = 3001
    protocol        = "tcp"
    security_groups = [aws_security_group.dashboard_alb.id]
  }

  egress {
    description = "All outbound (RDS, ECR, CloudWatch Logs)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name    = "specter-dashboard-tasks"
    Service = "dashboard"
  })
}

# Allow dashboard tasks to reach RDS (same SG as all other Specter services)
resource "aws_security_group_rule" "rds_from_dashboard" {
  type                     = "ingress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  security_group_id        = var.existing_rds_security_group_id
  source_security_group_id = aws_security_group.dashboard_tasks.id
  description              = "MySQL from Dashboard ECS tasks"
}

# ============================================================================
# ROUTE 53 — productFactory.mhkdevsandbox.com
# ============================================================================

data "aws_route53_zone" "mhkdevsandbox" {
  zone_id = "ZQM27GCSMD8BI"
}

resource "aws_route53_record" "dashboard" {
  zone_id = data.aws_route53_zone.mhkdevsandbox.zone_id
  name    = "productFactory.mhkdevsandbox.com"
  type    = "A"

  alias {
    name                   = aws_lb.dashboard.dns_name
    zone_id                = aws_lb.dashboard.zone_id
    evaluate_target_health = true
  }
}

# ============================================================================
# OUTPUTS
# ============================================================================

output "dashboard_url" {
  description = "Dashboard URL"
  value       = "https://productFactory.mhkdevsandbox.com"
}

output "dashboard_alb_dns" {
  description = "Dashboard ALB DNS (for verification)"
  value       = aws_lb.dashboard.dns_name
}

output "dashboard_ecr_url" {
  description = "ECR repository URL for pushing dashboard images"
  value       = aws_ecr_repository.dashboard.repository_url
}

output "watchdog_mcp_ecr_url" {
  description = "ECR repository URL for pushing the Watchdog MCP sidecar image"
  value       = var.enable_watchdog ? aws_ecr_repository.watchdog_mcp[0].repository_url : null
}
