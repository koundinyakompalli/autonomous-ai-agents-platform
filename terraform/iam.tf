# IAM Roles and Policies for Specter

# ============================================================================
# ECS TASK EXECUTION ROLE (pulls images, sends logs)
# ============================================================================

resource "aws_iam_role" "ecs_execution_role" {
  name = "SpecterECSExecutionRole"

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
    Name = "SpecterECSExecutionRole"
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_role_policy" {
  role       = aws_iam_role.ecs_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow execution role to read database credentials, JIRA token, and the
# shared GitHub repository token from Secrets Manager.
resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "SpecterSecretsAccess"
  role = aws_iam_role.ecs_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = concat([
          data.aws_secretsmanager_secret.db_credentials.arn,
          data.aws_secretsmanager_secret.jira_token.arn,
          data.aws_secretsmanager_secret.github_repo_token.arn
          ],
          var.enable_spec_factory && var.spec_factory_aurora_enabled ? [local.spec_factory_database_secret_arn] : [],
          var.enable_oneshot ? [data.aws_secretsmanager_secret.github_write_token[0].arn] : [],
          local.oneshot_github_app_credentials_secret_enabled ? [data.aws_secretsmanager_secret.github_app_credentials[0].arn] : [],
          var.enable_oneshot ? [data.aws_secretsmanager_secret.github_app_webhook_secret[0].arn] : [],
          local.oneshot_uses_openai_reviewer ? [data.aws_secretsmanager_secret.openai_reviewer_api_key[0].arn] : [],
          var.enable_oneshot ? [data.aws_secretsmanager_secret.oneshot_deploy_webhook_secret[0].arn] : [],
          local.oneshot_maven_user_secret_enabled ? [data.aws_secretsmanager_secret.oneshot_maven_user[0].arn] : [],
          local.oneshot_maven_password_secret_configured ? [data.aws_secretsmanager_secret.oneshot_maven_password[0].arn] : []
        )
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "ecs_execution_ssm_parameters" {
  count = (
    (var.enable_oneshot && var.oneshot_otel_enabled) ||
    (var.enable_spec_factory && var.spec_factory_otel_enabled)
  ) ? 1 : 0
  name = "SpecterSSMParameterAccess"
  role = aws_iam_role.ecs_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameters"
        ]
        Resource = concat(
          var.enable_oneshot && var.oneshot_otel_enabled ? [
            aws_ssm_parameter.oneshot_cwagent_config[0].arn
          ] : [],
          var.enable_spec_factory && var.spec_factory_otel_enabled ? [
            aws_ssm_parameter.spec_factory_cwagent_config[0].arn
          ] : []
        )
      }
    ]
  })
}

resource "aws_iam_role_policy" "ecs_execution_spec_factory_ssm_kms" {
  count = var.enable_spec_factory && var.spec_factory_otel_enabled ? 1 : 0
  name  = "SpecterSpecFactorySSMKMSAccess"
  role  = aws_iam_role.ecs_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DecryptSpecFactorySSMParameter"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = aws_kms_key.spec_factory_ssm[0].arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "task_oneshot_sqs" {
  count = var.enable_oneshot ? 1 : 0
  name  = "SpecterOneShotSQS"
  role  = split("/", var.existing_task_role_arn)[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage"
        ]
        Resource = [
          aws_sqs_queue.oneshot["planning"].arn,
          aws_sqs_queue.oneshot["review"].arn,
          aws_sqs_queue.oneshot["implementation"].arn,
          aws_sqs_queue.oneshot["code_review"].arn,
          aws_sqs_queue.oneshot["testing"].arn,
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl"
        ]
        Resource = [
          aws_sqs_queue.oneshot["planning"].arn,
          aws_sqs_queue.oneshot["review"].arn,
          aws_sqs_queue.oneshot["implementation"].arn,
          aws_sqs_queue.oneshot["code_review"].arn,
          aws_sqs_queue.oneshot["testing"].arn,
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "task_spec_factory_sqs" {
  count = var.enable_spec_factory ? 1 : 0
  name  = "SpecterSpecFactorySQS"
  role  = split("/", var.existing_task_role_arn)[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SpecFactoryQueuePublish"
        Effect = "Allow"
        Action = ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
        Resource = concat(
          [for queue in aws_sqs_queue.spec_factory : queue.arn],
          [aws_sqs_queue.spec_factory_quarantine[0].arn]
        )
      },
      {
        Sid    = "SpecFactoryQueueConsume"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl"
        ]
        Resource = [for queue in aws_sqs_queue.spec_factory : queue.arn]
      }
    ]
  })
}

locals {
  spec_factory_runtime_roles = var.enable_spec_factory ? toset([
    "api",
    "worker",
    "turn-worker",
    "context-worker",
    "research-worker",
    "conversion-worker",
    "draft-worker",
    "relay-worker",
    "retention-worker",
  ]) : toset([])
  spec_factory_bedrock_roles = toset([
    "api",
    "worker",
    "turn-worker",
    "context-worker",
    "research-worker",
    "conversion-worker",
    "draft-worker",
  ])
  spec_factory_role_queue = {
    turn-worker       = "turn"
    context-worker    = "context"
    research-worker   = "research"
    conversion-worker = "conversion"
    draft-worker      = "draft"
    relay-worker      = "events"
  }
}

resource "aws_iam_role" "spec_factory_runtime" {
  for_each = local.spec_factory_runtime_roles
  name     = "${var.environment}-SpecFactory-${replace(each.key, "-", "_")}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  tags = merge(local.common_tags, {
    Service    = "spec-factory"
    Capability = each.key
  })
}

resource "aws_iam_role_policy" "spec_factory_runtime" {
  for_each = aws_iam_role.spec_factory_runtime
  role     = each.value.id
  name     = "SpecFactoryLeastPrivilege"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "ListArtifactPrefixes"
          Effect   = "Allow"
          Action   = ["s3:ListBucket"]
          Resource = aws_s3_bucket.results.arn
          Condition = {
            StringLike = {
              "s3:prefix" = ["compose/*", "spec-factory/*"]
            }
          }
        },
        {
          Sid    = "ArtifactObjects"
          Effect = "Allow"
          Action = each.key == "api" ? [
            "s3:GetObject", "s3:PutObject"
            ] : each.key == "retention-worker" ? [
            "s3:GetObject", "s3:DeleteObject"
            ] : [
            "s3:GetObject", "s3:PutObject"
          ]
          Resource = [
            "${aws_s3_bucket.results.arn}/compose/*",
            "${aws_s3_bucket.results.arn}/spec-factory/*"
          ]
        },
        {
          Sid      = "Telemetry"
          Effect   = "Allow"
          Action   = ["cloudwatch:PutMetricData", "xray:PutTraceSegments", "xray:PutTelemetryRecords"]
          Resource = "*"
        }
      ],
      contains(local.spec_factory_bedrock_roles, each.key) ? [{
        Sid    = "BedrockInference"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:Converse",
          "bedrock:ConverseStream"
        ]
        Resource = "*"
      }] : [],
      contains(keys(local.spec_factory_role_queue), each.key) ? [{
        Sid    = "ConsumeOwnedQueue"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl"
        ]
        Resource = aws_sqs_queue.spec_factory[local.spec_factory_role_queue[each.key]].arn
      }] : [],
      contains(keys(local.spec_factory_role_queue), each.key) ? [{
        Sid    = "ManageOwnTaskProtection"
        Effect = "Allow"
        Action = [
          "ecs:GetTaskProtection",
          "ecs:UpdateTaskProtection"
        ]
        Resource = "arn:aws:ecs:${var.aws_region}:${local.account_id}:task/${aws_ecs_cluster.specter.name}/*"
      }] : [],
      contains(keys(local.spec_factory_role_queue), each.key) ? [{
        Sid      = "QuarantineUnsupportedMessages"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.spec_factory_quarantine[0].arn
      }] : [],
      each.key == "relay-worker" ? [{
        Sid      = "PublishDispatchQueues"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
        Resource = [for queue in aws_sqs_queue.spec_factory : queue.arn]
      }] : []
    )
  })
}

resource "aws_iam_role_policy_attachment" "task_cloudwatch_agent_server_policy" {
  count = (
    (var.enable_oneshot && var.oneshot_otel_enabled) ||
    (var.enable_spec_factory && var.spec_factory_otel_enabled)
  ) ? 1 : 0
  role       = split("/", var.existing_task_role_arn)[1]
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# ============================================================================
# BEDROCK PERMISSIONS FOR CLAUDE AGENT SDK
# ============================================================================

# Claude Agent SDK requires these permissions for Bedrock
# Reference: https://docs.anthropic.com/en/docs/claude-code
resource "aws_iam_role_policy" "task_bedrock_claude_sdk" {
  name = "SpecterClaudeAgentSDKBedrock"
  role = split("/", var.existing_task_role_arn)[1]

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
        Resource = concat(
          [
            # Sonnet 4.6 (shared default model)
            "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-sonnet-4-6",
            "arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-4-6",
            "arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-sonnet-4-6",
            "arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-sonnet-4-6",
            # Haiku 4.5 (small/fast model)
            "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
            "arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0",
            # Claude 3.5 Sonnet (fallback)
            "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
            # Opus 4.5 (legacy)
            "arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-opus-4-5-20251101-v1:0",
            # Opus 4.6 (planner/reviewer primary model)
            "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-opus-4-6-v1",
            "arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-opus-4-6-v1",
            "arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-opus-4-6-v1",
          ],
          trimspace(var.oneshot_planner_model_id) != "" ? [
            # Planner-only model override. Set after confirming the exact Bedrock model/profile ID.
            "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.oneshot_planner_model_id}",
            "arn:aws:bedrock:*:*:inference-profile/${var.oneshot_planner_model_id}",
          ] : [],
          trimspace(var.oneshot_reviewer_model_id) != "" ? [
            "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.oneshot_reviewer_model_id}",
            "arn:aws:bedrock:*:*:inference-profile/${var.oneshot_reviewer_model_id}",
          ] : [],
          trimspace(var.oneshot_implementer_model_id) != "" ? [
            "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.oneshot_implementer_model_id}",
            "arn:aws:bedrock:*:*:inference-profile/${var.oneshot_implementer_model_id}",
          ] : [],
          trimspace(var.oneshot_code_reviewer_model_id) != "" ? [
            "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.oneshot_code_reviewer_model_id}",
            "arn:aws:bedrock:*:*:inference-profile/${var.oneshot_code_reviewer_model_id}",
          ] : [],
          trimspace(var.qualifier_model_id) != "" ? [
            "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.qualifier_model_id}",
            "arn:aws:bedrock:*:*:inference-profile/${var.qualifier_model_id}",
          ] : [],
          trimspace(var.oneshot_statistics_llm_model_id) != "" ? [
            "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.oneshot_statistics_llm_model_id}",
            "arn:aws:bedrock:*:*:inference-profile/${var.oneshot_statistics_llm_model_id}",
          ] : [],
          trimspace(var.spec_factory_model_id) != "" ? [
            "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.spec_factory_model_id}",
            "arn:aws:bedrock:*:*:inference-profile/${var.spec_factory_model_id}",
          ] : [],
          trimspace(var.compose_chat_model_id) != "" ? [
            "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.compose_chat_model_id}",
            "arn:aws:bedrock:*:*:inference-profile/${var.compose_chat_model_id}",
          ] : [],
          trimspace(var.compose_voxtral_model_id) != "" ? [
            # Compose audio/video transcription uses the bare foundation-model id.
            "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.compose_voxtral_model_id}",
          ] : [],
        )
      },
      {
        Sid    = "BedrockListInferenceProfiles"
        Effect = "Allow"
        Action = [
          "bedrock:ListInferenceProfiles",
          "bedrock:GetInferenceProfile"
        ]
        Resource = "*"
      },
      {
        Sid    = "BedrockMarketplaceFirstUse"
        Effect = "Allow"
        Action = [
          "aws-marketplace:ViewSubscriptions",
          "aws-marketplace:Subscribe"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:RequestTag/aws-marketplace:productId" = "prod-anthropic-claude"
          }
        }
      }
    ]
  })
}

# ============================================================================
# ADDITIONAL S3 PERMISSIONS FOR TASK ROLE
# ============================================================================

# Add S3 permissions to existing task role (which already has Bedrock)
resource "aws_iam_role_policy" "task_s3_access" {
  name = "SpecterS3Access"
  role = split("/", var.existing_task_role_arn)[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = [
          "${aws_s3_bucket.tasks.arn}/*",
          "${aws_s3_bucket.results.arn}/*",
          var.enable_watchdog ? "${aws_s3_bucket.watchdog_evidence[0].arn}/*" : "${aws_s3_bucket.results.arn}/watchdog-disabled-placeholder"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.tasks.arn,
          aws_s3_bucket.results.arn,
          var.enable_watchdog ? aws_s3_bucket.watchdog_evidence[0].arn : aws_s3_bucket.results.arn
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "task_watchdog_prod_reader_secret" {
  count = var.enable_watchdog ? 1 : 0
  name  = "SpecterWatchdogProdReaderSecret"
  role  = split("/", var.existing_task_role_arn)[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadWatchdogProdReaderSecret"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          data.aws_secretsmanager_secret.watchdog_prod_reader[0].arn
        ]
      },
      {
        Sid    = "DecryptWatchdogProdReaderSecret"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:DescribeKey"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}
