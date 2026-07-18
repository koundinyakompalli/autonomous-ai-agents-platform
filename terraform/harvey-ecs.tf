# Harvey ECS Configuration
# Conversational Intake Agent - Microsoft Teams Bot Framework service
#
# Harvey is a lightweight HTTP service (Bot Framework /api/messages endpoint)
# that accepts Teams messages, runs LLM-based intake conversations via Bedrock,
# creates tasks for Specter agents, and delivers results back to users.
#
# Architecture:
#   Teams -> Bot Framework -> ALB (HTTPS) -> Harvey ECS (port 3978)
#   Harvey -> Bedrock (InvokeModel), RDS (sessions/tasks), S3 (task descriptions)
#
# Unlike workers, Harvey is an always-on HTTP service behind an ALB,
# not a polling-based background process.

# ============================================================================
# LOCAL VALUES
# ============================================================================

locals {
  # Fall back to ECS task subnets if no dedicated ALB subnets provided
  harvey_alb_subnets = length(var.harvey_alb_subnet_ids) > 0 ? var.harvey_alb_subnet_ids : var.subnet_ids
}

# ============================================================================
# SECRETS - Teams Bot Credentials
# ============================================================================

# Teams Bot credentials stored in Secrets Manager
# Create this secret manually or via CLI before first deploy:
#   aws secretsmanager create-secret \
#     --name YOUR_HARVEY_TEAMS_SECRET_NAME \
#     --secret-string '{"app_id":"YOUR_BOT_APP_ID","app_password":"YOUR_BOT_APP_PASSWORD"}'
data "aws_secretsmanager_secret" "harvey_teams_credentials" {
  name = var.harvey_teams_secret_name
}

# ============================================================================
# ECR REPOSITORY
# ============================================================================

resource "aws_ecr_repository" "harvey" {
  name                 = "specter/harvey"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Service = "harvey"
  })
}

resource "aws_ecr_lifecycle_policy" "harvey" {
  repository = aws_ecr_repository.harvey.name

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

# ============================================================================
# CLOUDWATCH LOG GROUP
# ============================================================================

resource "aws_cloudwatch_log_group" "harvey" {
  name              = "/ecs/specter/harvey"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Service = "harvey"
  })
}

# ============================================================================
# ECS TASK DEFINITION
# ============================================================================

resource "aws_ecs_task_definition" "harvey" {
  family                   = "specter-harvey"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.harvey_cpu
  memory                   = var.harvey_memory
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.harvey_task_role.arn

  container_definitions = jsonencode([{
    name  = "harvey"
    image = "${aws_ecr_repository.harvey.repository_url}:latest"

    portMappings = [{
      containerPort = 3978
      hostPort      = 3978
      protocol      = "tcp"
    }]

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:3978/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "HARVEY_PORT", value = "3978" },
      { name = "HARVEY_HOST", value = "0.0.0.0" },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "BEDROCK_MODEL_ID", value = var.bedrock_model_id },
      { name = "BEDROCK_MODEL", value = var.bedrock_model_id },
      { name = "RESULT_POLL_INTERVAL", value = tostring(var.harvey_result_poll_interval_ms) },
      { name = "S3_BUCKET_PREFIX", value = "specter" },
      # Database connection
      { name = "DB_HOST", value = var.db_host },
      { name = "DB_PORT", value = var.db_port },
      { name = "DB_NAME", value = var.db_name },
    ]

    secrets = [
      {
        name      = "TEAMS_APP_ID"
        valueFrom = "${data.aws_secretsmanager_secret.harvey_teams_credentials.arn}:app_id::"
      },
      {
        name      = "TEAMS_APP_PASSWORD"
        valueFrom = "${data.aws_secretsmanager_secret.harvey_teams_credentials.arn}:app_password::"
      },
      {
        name      = "TEAMS_TENANT_ID"
        valueFrom = "${data.aws_secretsmanager_secret.harvey_teams_credentials.arn}:tenant_id::"
      },
      {
        name      = "DB_USER"
        valueFrom = "${data.aws_secretsmanager_secret.db_credentials.arn}:username::"
      },
      {
        name      = "DB_PASSWORD"
        valueFrom = "${data.aws_secretsmanager_secret.db_credentials.arn}:password::"
      }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.harvey.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "harvey"
      }
    }
  }])

  tags = merge(local.common_tags, {
    Service = "harvey"
  })
}

# ============================================================================
# ALB - Application Load Balancer for Harvey
# ============================================================================

resource "aws_lb" "harvey" {
  name               = "specter-harvey-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.harvey_alb.id]
  subnets            = local.harvey_alb_subnets

  tags = merge(local.common_tags, {
    Name    = "specter-harvey-alb"
    Service = "harvey"
  })
}

# HTTPS Listener (required by Bot Framework)
resource "aws_lb_listener" "harvey_https" {
  load_balancer_arn = aws_lb.harvey.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.harvey_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.harvey.arn
  }

  tags = merge(local.common_tags, {
    Service = "harvey"
  })
}

# HTTP -> HTTPS redirect
resource "aws_lb_listener" "harvey_http_redirect" {
  load_balancer_arn = aws_lb.harvey.arn
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
    Service = "harvey"
  })
}

# Target Group
resource "aws_lb_target_group" "harvey" {
  name        = "specter-harvey-tg"
  port        = 3978
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip" # Required for Fargate awsvpc

  health_check {
    enabled             = true
    path                = "/health"
    port                = "3978"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  # Allow time for Bot Framework graceful shutdown
  deregistration_delay = 30

  tags = merge(local.common_tags, {
    Name    = "specter-harvey-tg"
    Service = "harvey"
  })
}

# ============================================================================
# ECS SERVICE
# ============================================================================

resource "aws_ecs_service" "harvey" {
  name            = "HARVEY"
  cluster         = aws_ecs_cluster.specter.id
  task_definition = aws_ecs_task_definition.harvey.arn
  desired_count   = var.harvey_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.harvey_tasks.id]
    assign_public_ip = true # Required for internet access (Bot Framework callback URLs)
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.harvey.arn
    container_name   = "harvey"
    container_port   = 3978
  }

  # Ensure ALB listener is ready before service starts
  depends_on = [aws_lb_listener.harvey_https]

  tags = merge(local.common_tags, {
    Service = "HARVEY"
  })
}

# ============================================================================
# SECURITY GROUPS
# ============================================================================

# ALB Security Group - public-facing
resource "aws_security_group" "harvey_alb" {
  name        = "specter-harvey-alb"
  description = "Security group for Harvey ALB - accepts Bot Framework traffic"
  vpc_id      = local.vpc_id

  # HTTPS from anywhere (Bot Framework sends callbacks from Microsoft IPs)
  ingress {
    description = "HTTPS from internet (Bot Framework)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP for redirect
  ingress {
    description = "HTTP for redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Outbound to ECS tasks
  egress {
    description = "To Harvey ECS tasks"
    from_port   = 3978
    to_port     = 3978
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name    = "specter-harvey-alb"
    Service = "harvey"
  })
}

# Harvey ECS Tasks Security Group
resource "aws_security_group" "harvey_tasks" {
  name        = "specter-harvey-tasks"
  description = "Security group for Harvey ECS tasks"
  vpc_id      = local.vpc_id

  # Inbound: only from ALB on port 3978
  ingress {
    description     = "Bot Framework traffic from ALB"
    from_port       = 3978
    to_port         = 3978
    protocol        = "tcp"
    security_groups = [aws_security_group.harvey_alb.id]
  }

  # Outbound: all (needs Bedrock API, RDS, S3, Bot Framework callback)
  egress {
    description = "All outbound (Bedrock, RDS, S3, Bot Framework)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name    = "specter-harvey-tasks"
    Service = "harvey"
  })
}

# Allow Harvey to connect to the shared Specter RDS security group
resource "aws_security_group_rule" "rds_from_harvey" {
  type                     = "ingress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  security_group_id        = var.existing_rds_security_group_id
  source_security_group_id = aws_security_group.harvey_tasks.id
  description              = "MySQL from Harvey ECS tasks"
}

# ============================================================================
# IAM - Harvey Task Role
# ============================================================================

# Harvey gets its own task role (separate from workers) because it needs
# different permissions: Bedrock + S3 but no EFS, no git clones, no JIRA token.
resource "aws_iam_role" "harvey_task_role" {
  name = "SpecterHarveyTaskRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })

  tags = merge(local.common_tags, {
    Name    = "SpecterHarveyTaskRole"
    Service = "harvey"
  })
}

# Bedrock InvokeModel - for intake agent LLM conversations
resource "aws_iam_role_policy" "harvey_bedrock" {
  name = "HarveyBedrockAccess"
  role = aws_iam_role.harvey_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "BedrockInvokeModel"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream"
        ]
        Resource = "*"
      },
      {
        Sid    = "BedrockListInferenceProfiles"
        Effect = "Allow"
        Action = [
          "bedrock:ListInferenceProfiles",
          "bedrock:GetInferenceProfile"
        ]
        Resource = "*"
      }
    ]
  })
}

# S3 read/write - for task descriptions created by Harvey
resource "aws_iam_role_policy" "harvey_s3" {
  name = "HarveyS3Access"
  role = aws_iam_role.harvey_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3ObjectAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = [
          "${aws_s3_bucket.tasks.arn}/*",
          "${aws_s3_bucket.results.arn}/*"
        ]
      },
      {
        Sid    = "S3ListBucket"
        Effect = "Allow"
        Action = [
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.tasks.arn,
          aws_s3_bucket.results.arn
        ]
      }
    ]
  })
}

# ============================================================================
# IAM - Execution Role Secrets Access for Harvey
# ============================================================================

# Grant the shared execution role access to Harvey's Teams credentials secret
resource "aws_iam_role_policy" "ecs_execution_harvey_secrets" {
  name = "SpecterHarveySecretsAccess"
  role = aws_iam_role.ecs_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          data.aws_secretsmanager_secret.harvey_teams_credentials.arn
        ]
      }
    ]
  })
}

# ============================================================================
# ROUTE 53 (Optional - DNS alias for the ALB)
# ============================================================================

# Uncomment and configure if you have a hosted zone for the domain:
# resource "aws_route53_record" "harvey" {
#   zone_id = var.harvey_route53_zone_id
#   name    = var.harvey_domain_name
#   type    = "A"
#
#   alias {
#     name                   = aws_lb.harvey.dns_name
#     zone_id                = aws_lb.harvey.zone_id
#     evaluate_target_health = true
#   }
# }
