# Terraform Outputs for Specter

output "cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.specter.name
}

output "cluster_arn" {
  description = "ECS cluster ARN"
  value       = aws_ecs_cluster.specter.arn
}

# ECR Repositories
output "orchestrator_ecr_url" {
  description = "ECR repository URL for orchestrator"
  value       = aws_ecr_repository.orchestrator.repository_url
}

output "worker_ecr_urls" {
  description = "ECR repository URLs for workers"
  value       = { for name, repo in aws_ecr_repository.workers : name => repo.repository_url }
}

output "oneshot_ecr_url" {
  description = "ECR repository URL for the shared OneShot consumer image"
  value       = try(aws_ecr_repository.oneshot[0].repository_url, null)
}

# S3 Buckets
output "s3_tasks_bucket" {
  description = "S3 bucket for task descriptions"
  value       = aws_s3_bucket.tasks.bucket
}

output "s3_results_bucket" {
  description = "S3 bucket for agent results"
  value       = aws_s3_bucket.results.bucket
}

# ECS Services
output "orchestrator_service" {
  description = "Orchestrator ECS service name"
  value       = aws_ecs_service.orchestrator.name
}

output "worker_services" {
  description = "Worker ECS service names"
  value       = { for name, svc in aws_ecs_service.workers : name => svc.name }
}

output "oneshot_services" {
  description = "OneShot ECS service names"
  value       = { for name, svc in aws_ecs_service.oneshot : name => svc.name }
}

output "all_services" {
  description = "All service names (for convenience)"
  value       = concat([aws_ecs_service.orchestrator.name], [aws_ecs_service.harvey.name], [for s in aws_ecs_service.workers : s.name], [for s in aws_ecs_service.oneshot : s.name])
}

# Security
output "ecs_security_group_id" {
  description = "Security group ID for ECS tasks"
  value       = aws_security_group.ecs_tasks.id
}

# IAM
output "ecs_execution_role_arn" {
  description = "ECS task execution role ARN"
  value       = aws_iam_role.ecs_execution_role.arn
}

output "ecs_task_role_arn" {
  description = "ECS task role ARN (reused from existing)"
  value       = data.aws_iam_role.existing_task_role.arn
}

output "agent_registry_lambda_name" {
  description = "Name of the Lambda used for governed agent DB registration"
  value       = aws_lambda_function.agent_registry.function_name
}

output "agent_registry_lambda_arn" {
  description = "ARN of the Lambda used for governed agent DB registration"
  value       = aws_lambda_function.agent_registry.arn
}

# CloudWatch
output "log_groups" {
  description = "CloudWatch log group names"
  value = merge(
    {
      orchestrator = aws_cloudwatch_log_group.orchestrator.name
      harvey       = aws_cloudwatch_log_group.harvey.name
    },
    { for name, log_group in aws_cloudwatch_log_group.workers : name => log_group.name },
    { for name, log_group in aws_cloudwatch_log_group.oneshot : "oneshot-${name}" => log_group.name }
  )
}

output "oneshot_queue_urls" {
  description = "URLs for OneShot SQS queues"
  value       = { for name, queue in aws_sqs_queue.oneshot : name => queue.url }
}

output "oneshot_queue_arns" {
  description = "ARNs for OneShot SQS queues"
  value       = { for name, queue in aws_sqs_queue.oneshot : name => queue.arn }
}

output "spec_factory_queue_urls" {
  description = "Spec Factory durable queue URLs by workload"
  value       = { for name, queue in aws_sqs_queue.spec_factory : name => queue.url }
}

output "spec_factory_queue_arns" {
  description = "Spec Factory durable queue ARNs by workload"
  value       = { for name, queue in aws_sqs_queue.spec_factory : name => queue.arn }
}

output "spec_factory_dlq_urls" {
  description = "Spec Factory dead-letter queue URLs by workload"
  value       = { for name, queue in aws_sqs_queue.spec_factory_dlq : name => queue.url }
}

output "spec_factory_quarantine_queue_url" {
  description = "Spec Factory unsupported-envelope quarantine queue URL"
  value       = try(aws_sqs_queue.spec_factory_quarantine[0].url, null)
}

output "spec_factory_quarantine_queue_arn" {
  description = "Spec Factory unsupported-envelope quarantine queue ARN"
  value       = try(aws_sqs_queue.spec_factory_quarantine[0].arn, null)
}

output "oneshot_alert_topic_arn" {
  description = "SNS topic ARN used for OneShot CloudWatch alarm actions"
  value       = try(aws_sns_topic.oneshot_alerts[0].arn, null)
}

# Harvey
output "harvey_ecr_url" {
  description = "ECR repository URL for Harvey"
  value       = aws_ecr_repository.harvey.repository_url
}

output "harvey_service" {
  description = "Harvey ECS service name"
  value       = aws_ecs_service.harvey.name
}

output "harvey_alb_dns" {
  description = "Harvey ALB DNS name (configure as Bot Framework messaging endpoint)"
  value       = aws_lb.harvey.dns_name
}

output "harvey_bot_endpoint" {
  description = "Full Bot Framework messaging endpoint URL"
  value       = "https://${aws_lb.harvey.dns_name}/api/messages"
}

# Useful commands
output "deploy_commands" {
  description = "Useful commands for deployment"
  value = {
    ecr_login = "aws ecr get-login-password --region ${var.aws_region} | docker login --username AWS --password-stdin ${local.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"

    tail_logs_orchestrator = "aws logs tail ${aws_cloudwatch_log_group.orchestrator.name} --follow --region ${var.aws_region}"
    tail_logs_darci        = "aws logs tail ${aws_cloudwatch_log_group.workers["darci"].name} --follow --region ${var.aws_region}"
    tail_logs_harvey       = "aws logs tail ${aws_cloudwatch_log_group.harvey.name} --follow --region ${var.aws_region}"

    list_tasks = "aws ecs list-tasks --cluster ${aws_ecs_cluster.specter.name} --region ${var.aws_region}"

    update_service = "aws ecs update-service --cluster ${aws_ecs_cluster.specter.name} --service SERVICE_NAME --force-new-deployment --region ${var.aws_region}"
  }
}
