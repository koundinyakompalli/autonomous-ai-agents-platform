# Routes the oneshot_alerts SNS topic into a Microsoft Teams channel via an
# incoming webhook. The webhook URL is stored in Secrets Manager (not in this
# repo) and fetched by the Lambda at invocation time.
#
# Secret contract:
#   Name  : var.teams_webhook_secret_name (default: specter/prod/teams-webhook-url)
#   Value : the raw HTTPS webhook URL (no JSON wrapping, no trailing whitespace)
#
# To bootstrap the secret (outside Terraform, one time):
#   aws secretsmanager create-secret \
#     --name specter/prod/teams-webhook-url \
#     --secret-string 'https://<tenant>.webhook.office.com/webhookb2/...'

data "aws_secretsmanager_secret" "teams_webhook" {
  count = var.enable_teams_notifier ? 1 : 0
  name  = var.teams_webhook_secret_name
}

resource "aws_cloudwatch_log_group" "teams_notifier" {
  count             = var.enable_teams_notifier ? 1 : 0
  name              = "/aws/lambda/specter-teams-notifier"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Service = "teams-notifier"
  })
}

resource "aws_iam_role" "teams_notifier" {
  count = var.enable_teams_notifier ? 1 : 0
  name  = "SpecterTeamsNotifierRole"

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
    Name    = "SpecterTeamsNotifierRole"
    Service = "teams-notifier"
  })
}

resource "aws_iam_role_policy_attachment" "teams_notifier_basic_execution" {
  count      = var.enable_teams_notifier ? 1 : 0
  role       = aws_iam_role.teams_notifier[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "teams_notifier_secrets" {
  count = var.enable_teams_notifier ? 1 : 0
  name  = "SpecterTeamsNotifierSecrets"
  role  = aws_iam_role.teams_notifier[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [data.aws_secretsmanager_secret.teams_webhook[0].arn]
    }]
  })
}

data "archive_file" "teams_notifier" {
  count       = var.enable_teams_notifier ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/lambda/teams_notifier"
  output_path = "${path.module}/build/teams_notifier.zip"
}

resource "aws_lambda_function" "teams_notifier" {
  count            = var.enable_teams_notifier ? 1 : 0
  function_name    = "specter-teams-notifier"
  role             = aws_iam_role.teams_notifier[0].arn
  handler          = "index.handler"
  runtime          = "python3.12"
  timeout          = 10
  memory_size      = 128
  filename         = data.archive_file.teams_notifier[0].output_path
  source_code_hash = data.archive_file.teams_notifier[0].output_base64sha256

  environment {
    variables = {
      TEAMS_WEBHOOK_SECRET_ARN = data.aws_secretsmanager_secret.teams_webhook[0].arn
      ENVIRONMENT              = var.environment
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.teams_notifier,
    aws_iam_role_policy_attachment.teams_notifier_basic_execution,
    aws_iam_role_policy.teams_notifier_secrets,
  ]

  tags = merge(local.common_tags, {
    Service = "teams-notifier"
  })
}

resource "aws_lambda_permission" "teams_notifier_sns" {
  count         = var.enable_teams_notifier && var.enable_oneshot ? 1 : 0
  statement_id  = "AllowOneShotAlertsSnsInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.teams_notifier[0].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.oneshot_alerts[0].arn
}

resource "aws_sns_topic_subscription" "teams_notifier_oneshot_alerts" {
  count     = var.enable_teams_notifier && var.enable_oneshot ? 1 : 0
  topic_arn = aws_sns_topic.oneshot_alerts[0].arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.teams_notifier[0].arn

  depends_on = [aws_lambda_permission.teams_notifier_sns]
}
