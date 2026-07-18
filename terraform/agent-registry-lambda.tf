# Agent registry Lambda
#
# This function is invoked by the governed onboarding workflows after Terraform
# apply completes. It keeps the workflow side-effect free during plan while
# still allowing the infrastructure pipeline to upsert and verify agent rows.

resource "aws_cloudwatch_log_group" "agent_registry_lambda" {
  name              = "/aws/lambda/specter-agent-registry"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Service = "agent-registry-lambda"
  })
}

resource "aws_security_group" "agent_registry_lambda" {
  name        = "specter-agent-registry-lambda"
  description = "Security group for Specter agent registry Lambda"
  vpc_id      = local.vpc_id

  egress {
    description = "All outbound (RDS, Secrets Manager, CloudWatch Logs)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name    = "specter-agent-registry-lambda"
    Service = "agent-registry-lambda"
  })
}

resource "aws_security_group_rule" "rds_from_agent_registry_lambda" {
  type                     = "ingress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  security_group_id        = var.existing_rds_security_group_id
  source_security_group_id = aws_security_group.agent_registry_lambda.id
  description              = "MySQL from Specter agent registry Lambda"
}

resource "aws_iam_role" "agent_registry_lambda" {
  name = "SpecterAgentRegistryLambdaRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })

  tags = merge(local.common_tags, {
    Name    = "SpecterAgentRegistryLambdaRole"
    Service = "agent-registry-lambda"
  })
}

resource "aws_iam_role_policy_attachment" "agent_registry_lambda_basic_execution" {
  role       = aws_iam_role.agent_registry_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "agent_registry_lambda_vpc_access" {
  role       = aws_iam_role.agent_registry_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "agent_registry_lambda_secrets" {
  name = "SpecterAgentRegistryLambdaSecrets"
  role = aws_iam_role.agent_registry_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          data.aws_secretsmanager_secret.db_credentials.arn,
          data.aws_secretsmanager_secret.jira_token.arn
        ]
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

resource "aws_lambda_function" "agent_registry" {
  function_name    = "specter-agent-registry"
  role             = aws_iam_role.agent_registry_lambda.arn
  handler          = "index.handler"
  runtime          = "python3.12"
  timeout          = 30
  memory_size      = 256
  filename         = local.agent_registry_lambda_zip_path
  source_code_hash = local.agent_registry_lambda_source_hash

  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = [aws_security_group.agent_registry_lambda.id]
  }

  environment {
    variables = {
      DB_SECRET_ARN         = data.aws_secretsmanager_secret.db_credentials.arn
      DB_HOST               = var.db_host
      DB_PORT               = var.db_port
      DB_NAME               = var.db_name
      JIRA_TOKEN_SECRET_ARN = data.aws_secretsmanager_secret.jira_token.arn
      JIRA_USERNAME         = var.jira_username
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.agent_registry_lambda,
    aws_iam_role_policy_attachment.agent_registry_lambda_basic_execution,
    aws_iam_role_policy_attachment.agent_registry_lambda_vpc_access,
    aws_iam_role_policy.agent_registry_lambda_secrets,
    aws_security_group_rule.rds_from_agent_registry_lambda,
  ]

  tags = merge(local.common_tags, {
    Service = "agent-registry-lambda"
  })
}
