# Optional v4 data-plane resources. All remain disabled until their rollout
# gates and migration/certification checks have passed.

locals {
  spec_factory_database_secret_arn = var.spec_factory_aurora_enabled ? aws_rds_cluster.spec_factory[0].master_user_secret[0].secret_arn : data.aws_secretsmanager_secret.db_credentials.arn
  spec_factory_data_plane_enabled = var.enable_spec_factory && (
    var.spec_factory_valkey_enabled ||
    var.spec_factory_rds_proxy_enabled ||
    var.spec_factory_aurora_enabled
  )
  spec_factory_data_subnet_ids = length(var.spec_factory_data_subnet_ids) > 0 ? var.spec_factory_data_subnet_ids : var.subnet_ids
}

data "aws_subnet" "spec_factory_data" {
  for_each = local.spec_factory_data_plane_enabled ? toset(local.spec_factory_data_subnet_ids) : toset([])
  id       = each.value
}

check "spec_factory_data_subnets" {
  assert {
    condition = !local.spec_factory_data_plane_enabled || (
      length(local.spec_factory_data_subnet_ids) >= 2 &&
      length(distinct([for subnet in data.aws_subnet.spec_factory_data : subnet.availability_zone])) >= 2 &&
      alltrue([
        for subnet in data.aws_subnet.spec_factory_data :
        subnet.vpc_id == local.vpc_id && !subnet.map_public_ip_on_launch
      ])
    )
    error_message = "Spec Factory data-plane services require private subnets in the configured VPC across at least two availability zones."
  }
}

resource "aws_kms_key" "spec_factory_data" {
  count = var.enable_spec_factory ? 1 : 0

  description             = "Encrypts Spec Factory runtime images and optional v4 data-plane resources"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "spec-factory-data-key-policy"
    Statement = [
      {
        Sid    = "EnableAccountIAMPolicies"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${local.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowCloudWatchLogs"
        Effect = "Allow"
        Principal = {
          Service = "logs.${var.aws_region}.amazonaws.com"
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*"
        ]
        Resource = "*"
        Condition = {
          ArnEquals = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.aws_region}:${local.account_id}:log-group:/ecs/specter/spec-factory"
          }
        }
      }
    ]
  })

  tags = merge(local.common_tags, {
    Name    = "specter-${var.environment}-spec-factory-data"
    Service = "spec-factory"
  })
}

resource "aws_kms_alias" "spec_factory_data" {
  count = var.enable_spec_factory ? 1 : 0

  name          = "alias/specter-${var.environment}-spec-factory-data"
  target_key_id = aws_kms_key.spec_factory_data[0].key_id
}

check "spec_factory_legacy_removal_gates" {
  assert {
    condition = var.spec_factory_legacy_runtime != "disabled" || (
      var.spec_factory_pin_image_by_digest &&
      lower(var.spec_factory_image_tag) != "latest" &&
      can(regex("^[a-f0-9]{7,64}$", lower(var.spec_factory_image_tag))) &&
      var.spec_factory_valkey_enabled &&
      var.spec_factory_rds_proxy_enabled &&
      !var.spec_factory_rds_direct_fallback_enabled &&
      var.spec_factory_autoscaling_enabled &&
      var.spec_factory_outbox_enabled &&
      var.spec_factory_durable_events_required &&
      var.spec_factory_queue_dispatch_mode == "primary" &&
      var.spec_factory_artifact_store == "s3" &&
      var.spec_factory_workspace_manager_enabled &&
      var.spec_factory_draft_workflow_v2_enabled &&
      var.spec_factory_handoff_build_task_enabled &&
      var.spec_factory_llm_gateway_enabled &&
      var.spec_factory_chat_coordinator_enabled &&
      var.spec_factory_enable_context_distillation &&
      var.spec_factory_enable_context_merge &&
      can(regex("^sfv4-[a-f0-9]{64}$", var.spec_factory_certification_id)) &&
      var.spec_factory_context_v4_repair_run_id > 0 &&
      var.compose_retention_cleanup_enabled &&
      !var.compose_cleanup_dry_run &&
      var.spec_factory_desired_count >= 2 &&
      var.spec_factory_turn_worker_desired_count >= 2 &&
      var.spec_factory_context_worker_desired_count >= 2 &&
      var.spec_factory_research_worker_desired_count >= 2 &&
      var.spec_factory_conversion_worker_desired_count >= 2 &&
      var.spec_factory_draft_worker_desired_count >= 2 &&
      var.spec_factory_relay_worker_desired_count >= 2 &&
      var.spec_factory_retention_worker_desired_count >= 1 &&
      try(tonumber(var.spec_factory_llm_session_cost_ceiling_usd) > 0, false) &&
      try(tonumber(var.spec_factory_research_cost_ceiling_usd) > 0, false)
    )
    error_message = "Legacy removal requires accepted v4 certification, digest-pinned images, strict durable events, Valkey, RDS Proxy, autoscaling, HA split services, outbox, primary SQS dispatch, immutable S3 artifacts, durable drafts/handoffs, applied retention, and positive LLM/research budgets."
  }
}

check "spec_factory_rds_proxy_target" {
  assert {
    condition     = !var.spec_factory_rds_proxy_enabled || var.spec_factory_aurora_enabled || trimspace(var.spec_factory_rds_proxy_db_instance_identifier) != ""
    error_message = "spec_factory_rds_proxy_enabled requires either spec_factory_aurora_enabled or spec_factory_rds_proxy_db_instance_identifier."
  }
}

resource "aws_security_group" "spec_factory_valkey" {
  count       = var.enable_spec_factory && var.spec_factory_valkey_enabled ? 1 : 0
  name        = "${var.environment}-spec-factory-valkey"
  description = "Valkey live-event fanout reachable only from Spec Factory tasks"
  vpc_id      = local.vpc_id

  ingress {
    description     = "TLS Valkey from Spec Factory runtimes"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.spec_factory_tasks[0].id]
  }

  tags = merge(local.common_tags, { Service = "spec-factory-valkey" })
}

resource "aws_elasticache_subnet_group" "spec_factory" {
  count      = var.enable_spec_factory && var.spec_factory_valkey_enabled ? 1 : 0
  name       = "${var.environment}-spec-factory-valkey"
  subnet_ids = local.spec_factory_data_subnet_ids
}

resource "aws_elasticache_replication_group" "spec_factory" {
  count = var.enable_spec_factory && var.spec_factory_valkey_enabled ? 1 : 0

  replication_group_id       = "${var.environment}-spec-factory-events"
  description                = "Spec Factory canonical live-event fanout"
  engine                     = "valkey"
  engine_version             = "8.0"
  node_type                  = var.spec_factory_valkey_node_type
  port                       = 6379
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.spec_factory_data[0].arn
  snapshot_retention_limit   = 7
  snapshot_window            = "05:00-06:00"
  maintenance_window         = "sun:07:00-sun:08:00"
  subnet_group_name          = aws_elasticache_subnet_group.spec_factory[0].name
  security_group_ids         = [aws_security_group.spec_factory_valkey[0].id]
  apply_immediately          = false

  tags = merge(local.common_tags, { Service = "spec-factory-valkey" })
}

resource "aws_db_subnet_group" "spec_factory_aurora" {
  count      = var.enable_spec_factory && var.spec_factory_aurora_enabled ? 1 : 0
  name       = "${var.environment}-spec-factory-aurora"
  subnet_ids = local.spec_factory_data_subnet_ids
}

resource "aws_security_group" "spec_factory_aurora" {
  count       = var.enable_spec_factory && var.spec_factory_aurora_enabled ? 1 : 0
  name        = "${var.environment}-spec-factory-aurora"
  description = "Dedicated Spec Factory Aurora MySQL"
  vpc_id      = local.vpc_id

  ingress {
    description     = "MySQL from Spec Factory tasks"
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.spec_factory_tasks[0].id]
  }

  tags = merge(local.common_tags, { Service = "spec-factory-aurora" })
}

resource "aws_rds_cluster" "spec_factory" {
  count = var.enable_spec_factory && var.spec_factory_aurora_enabled ? 1 : 0

  cluster_identifier              = "${var.environment}-spec-factory"
  engine                          = "aurora-mysql"
  database_name                   = "specfactory"
  master_username                 = "specfactory_admin"
  manage_master_user_password     = true
  db_subnet_group_name            = aws_db_subnet_group.spec_factory_aurora[0].name
  vpc_security_group_ids          = [aws_security_group.spec_factory_aurora[0].id]
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.spec_factory_data[0].arn
  backup_retention_period         = 35
  preferred_backup_window         = "03:00-04:00"
  preferred_maintenance_window    = "sun:04:30-sun:05:30"
  enabled_cloudwatch_logs_exports = ["audit", "error", "general", "slowquery"]
  deletion_protection             = true
  copy_tags_to_snapshot           = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.environment}-spec-factory-final"

  tags = merge(local.common_tags, { Service = "spec-factory-aurora" })
}

resource "aws_rds_cluster_instance" "spec_factory" {
  count = var.enable_spec_factory && var.spec_factory_aurora_enabled ? var.spec_factory_aurora_instance_count : 0

  identifier          = "${var.environment}-spec-factory-${count.index + 1}"
  cluster_identifier  = aws_rds_cluster.spec_factory[0].id
  instance_class      = var.spec_factory_aurora_instance_class
  engine              = aws_rds_cluster.spec_factory[0].engine
  publicly_accessible = false

  tags = merge(local.common_tags, { Service = "spec-factory-aurora" })
}

resource "aws_backup_vault" "spec_factory_aurora" {
  count = var.enable_spec_factory && var.spec_factory_aurora_enabled ? 1 : 0

  name        = "${var.environment}-spec-factory-aurora"
  kms_key_arn = aws_kms_key.spec_factory_data[0].arn

  tags = merge(local.common_tags, { Service = "spec-factory-aurora-backup" })
}

resource "aws_backup_plan" "spec_factory_aurora" {
  count = var.enable_spec_factory && var.spec_factory_aurora_enabled ? 1 : 0

  name = "${var.environment}-spec-factory-aurora"

  rule {
    rule_name                = "daily-365-day-retention"
    target_vault_name        = aws_backup_vault.spec_factory_aurora[0].name
    schedule                 = "cron(0 5 * * ? *)"
    start_window             = 60
    completion_window        = 360
    enable_continuous_backup = true

    lifecycle {
      delete_after = 365
    }

    recovery_point_tags = merge(local.common_tags, {
      Service = "spec-factory-aurora-backup"
    })
  }

  tags = merge(local.common_tags, { Service = "spec-factory-aurora-backup" })
}

resource "aws_iam_role" "spec_factory_backup" {
  count = var.enable_spec_factory && var.spec_factory_aurora_enabled ? 1 : 0

  name = "${var.environment}-SpecFactoryBackup"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "backup.amazonaws.com" }
    }]
  })

  tags = merge(local.common_tags, { Service = "spec-factory-aurora-backup" })
}

resource "aws_iam_role_policy_attachment" "spec_factory_backup" {
  count = var.enable_spec_factory && var.spec_factory_aurora_enabled ? 1 : 0

  role       = aws_iam_role.spec_factory_backup[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "spec_factory_aurora" {
  count = var.enable_spec_factory && var.spec_factory_aurora_enabled ? 1 : 0

  name         = "${var.environment}-spec-factory-aurora"
  iam_role_arn = aws_iam_role.spec_factory_backup[0].arn
  plan_id      = aws_backup_plan.spec_factory_aurora[0].id
  resources    = [aws_rds_cluster.spec_factory[0].arn]

  depends_on = [aws_iam_role_policy_attachment.spec_factory_backup]
}

resource "aws_iam_role" "spec_factory_rds_proxy" {
  count = var.enable_spec_factory && var.spec_factory_rds_proxy_enabled ? 1 : 0
  name  = "${var.environment}-SpecFactoryRdsProxy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "rds.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "spec_factory_rds_proxy" {
  count = var.enable_spec_factory && var.spec_factory_rds_proxy_enabled ? 1 : 0
  role  = aws_iam_role.spec_factory_rds_proxy[0].id
  name  = "SpecFactoryRdsProxySecrets"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([{
      Sid      = "ReadDatabaseSecret"
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = local.spec_factory_database_secret_arn
      }], trimspace(var.spec_factory_db_secret_kms_key_arn) != "" ? [{
      Sid      = "DecryptDatabaseSecret"
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = var.spec_factory_db_secret_kms_key_arn
      Condition = {
        StringEquals = {
          "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com"
        }
      }
    }] : [])
  })
}

resource "aws_security_group" "spec_factory_rds_proxy" {
  #checkov:skip=CKV2_AWS_5:The group is attached to the conditional aws_db_proxy.spec_factory resource; Checkov cannot resolve the count-based reference.
  count       = var.enable_spec_factory && var.spec_factory_rds_proxy_enabled ? 1 : 0
  name        = "${var.environment}-spec-factory-rds-proxy"
  description = "RDS Proxy for horizontally scaled Spec Factory runtimes"
  vpc_id      = local.vpc_id

  ingress {
    description     = "MySQL from Spec Factory tasks"
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.spec_factory_tasks[0].id]
  }

  egress {
    description     = "MySQL to the approved database security group"
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [var.spec_factory_aurora_enabled ? aws_security_group.spec_factory_aurora[0].id : var.existing_rds_security_group_id]
  }
}

resource "aws_security_group_rule" "spec_factory_proxy_to_existing_rds" {
  count = var.enable_spec_factory && var.spec_factory_rds_proxy_enabled && !var.spec_factory_aurora_enabled ? 1 : 0

  type                     = "ingress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  security_group_id        = var.existing_rds_security_group_id
  source_security_group_id = aws_security_group.spec_factory_rds_proxy[0].id
  description              = "MySQL from the Spec Factory RDS Proxy"
}

resource "aws_db_proxy" "spec_factory" {
  count = var.enable_spec_factory && var.spec_factory_rds_proxy_enabled ? 1 : 0

  name                   = "${var.environment}-spec-factory"
  engine_family          = "MYSQL"
  role_arn               = aws_iam_role.spec_factory_rds_proxy[0].arn
  vpc_subnet_ids         = local.spec_factory_data_subnet_ids
  vpc_security_group_ids = [aws_security_group.spec_factory_rds_proxy[0].id]
  require_tls            = true
  idle_client_timeout    = 1800

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = local.spec_factory_database_secret_arn
  }
}

resource "aws_db_proxy_default_target_group" "spec_factory" {
  count         = var.enable_spec_factory && var.spec_factory_rds_proxy_enabled ? 1 : 0
  db_proxy_name = aws_db_proxy.spec_factory[0].name

  connection_pool_config {
    connection_borrow_timeout    = 30
    max_connections_percent      = 90
    max_idle_connections_percent = 50
  }
}

resource "aws_db_proxy_target" "spec_factory_existing" {
  count = (
    var.enable_spec_factory && var.spec_factory_rds_proxy_enabled &&
    !var.spec_factory_aurora_enabled &&
    trimspace(var.spec_factory_rds_proxy_db_instance_identifier) != ""
  ) ? 1 : 0

  db_proxy_name          = aws_db_proxy.spec_factory[0].name
  target_group_name      = aws_db_proxy_default_target_group.spec_factory[0].name
  db_instance_identifier = var.spec_factory_rds_proxy_db_instance_identifier
}

resource "aws_db_proxy_target" "spec_factory_aurora" {
  count = var.enable_spec_factory && var.spec_factory_rds_proxy_enabled && var.spec_factory_aurora_enabled ? 1 : 0

  db_proxy_name         = aws_db_proxy.spec_factory[0].name
  target_group_name     = aws_db_proxy_default_target_group.spec_factory[0].name
  db_cluster_identifier = aws_rds_cluster.spec_factory[0].id
}

output "spec_factory_valkey_primary_endpoint" {
  value = try(aws_elasticache_replication_group.spec_factory[0].primary_endpoint_address, null)
}

output "spec_factory_rds_proxy_endpoint" {
  value = try(aws_db_proxy.spec_factory[0].endpoint, null)
}

output "spec_factory_aurora_endpoint" {
  value = try(aws_rds_cluster.spec_factory[0].endpoint, null)
}
