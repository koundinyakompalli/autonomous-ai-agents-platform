# Specter Infrastructure
# Reuses existing MedHok AWS infrastructure where possible
# Creates: ECR repositories, S3 buckets, ECS cluster, ECS services

terraform {
  required_version = ">= 1.1"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    # Configuration provided via backend.hcl
    # Run: terraform init -backend-config=backend.hcl
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Environment = var.environment
      Project     = "Specter"
      ManagedBy   = "Terraform"
      Owner       = var.owner
    }
  }

  # Governance automation in the shared account adds these tags outside this
  # repo on some resource types. Ignore them so Terraform does not report
  # perpetual drift on resources like CloudWatch log groups.
  ignore_tags {
    keys = [
      "BusinessUnit",
      "Client",
      "CostCenter",
      "Division",
      "Finance",
      "Launch",
      "Platform",
      "Product",
      "ProductLine",
      "Scope",
      "SupportTeam",
    ]
  }
}

# Data sources
data "aws_caller_identity" "current" {}

# Existing VPC (reused - same as RDS)
data "aws_vpc" "existing" {
  id = var.existing_vpc_id
}

# Existing EFS
data "aws_efs_file_system" "specter_repo" {
  file_system_id = var.existing_efs_id
}

# Existing ECS Task Role (has Bedrock permissions)
data "aws_iam_role" "existing_task_role" {
  name = split("/", var.existing_task_role_arn)[1]
}

# Existing RDS credentials
data "aws_secretsmanager_secret" "db_credentials" {
  name = var.db_credentials_secret_name
}

data "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = data.aws_secretsmanager_secret.db_credentials.id
}

data "aws_secretsmanager_secret" "jira_token" {
  name = var.jira_token_secret_name
}

data "aws_secretsmanager_secret" "github_repo_token" {
  name = var.github_repo_token_secret_name
}

data "aws_secretsmanager_secret" "github_write_token" {
  count = var.enable_oneshot ? 1 : 0
  name  = var.github_write_token_secret_name
}

data "aws_secretsmanager_secret" "github_app_credentials" {
  count = local.oneshot_github_app_credentials_secret_enabled ? 1 : 0
  name  = var.github_app_credentials_secret_name
}

data "aws_secretsmanager_secret" "github_app_webhook_secret" {
  count = var.enable_oneshot ? 1 : 0
  name  = var.github_app_webhook_secret_name
}

data "aws_secretsmanager_secret" "openai_reviewer_api_key" {
  count = local.oneshot_uses_openai_reviewer ? 1 : 0
  name  = var.openai_reviewer_api_key_secret_name
}

data "aws_secretsmanager_secret" "oneshot_deploy_webhook_secret" {
  count = var.enable_oneshot ? 1 : 0
  name  = var.oneshot_deploy_webhook_secret_name
}

data "aws_secretsmanager_secret" "oneshot_maven_password" {
  count = local.oneshot_maven_password_secret_configured ? 1 : 0
  name  = var.oneshot_maven_password_secret_name
}

data "aws_secretsmanager_secret" "oneshot_maven_user" {
  count = local.oneshot_maven_user_secret_enabled ? 1 : 0
  name  = var.oneshot_maven_user_secret_name
}

data "aws_secretsmanager_secret" "watchdog_prod_reader" {
  count = var.enable_watchdog ? 1 : 0
  name  = var.watchdog_prod_reader_secret_name
}

# Local values
locals {
  app_name    = "specter"
  environment = var.environment
  account_id  = data.aws_caller_identity.current.account_id

  oneshot_github_app_credentials_secret_enabled = var.enable_oneshot && trimspace(var.github_app_credentials_secret_name) != ""
  oneshot_maven_password_secret_configured      = var.enable_oneshot && trimspace(var.oneshot_maven_password_secret_name) != ""
  oneshot_maven_credentials_enabled             = var.oneshot_maven_builds_enabled && local.oneshot_maven_password_secret_configured
  oneshot_maven_user_secret_enabled             = var.enable_oneshot && var.oneshot_maven_builds_enabled && trimspace(var.oneshot_maven_user_secret_name) != ""
  oneshot_maven_user_configured                 = trimspace(var.oneshot_maven_user) != "" || trimspace(var.oneshot_maven_user_secret_name) != ""
  oneshot_maven_config_requested = anytrue([
    var.oneshot_maven_builds_enabled && trimspace(var.oneshot_maven_artifactory_host) != "",
    var.oneshot_maven_builds_enabled && trimspace(var.oneshot_maven_user) != "",
    var.oneshot_maven_builds_enabled && trimspace(var.oneshot_maven_user_secret_name) != "",
    var.oneshot_maven_builds_enabled && trimspace(var.oneshot_maven_password_secret_name) != "",
  ])
  oneshot_maven_config_complete = !var.oneshot_maven_builds_enabled || !local.oneshot_maven_config_requested || (
    trimspace(var.oneshot_maven_artifactory_host) != "" &&
    local.oneshot_maven_user_configured &&
    trimspace(var.oneshot_maven_password_secret_name) != ""
  )

  # VPC configuration
  vpc_id     = data.aws_vpc.existing.id
  subnet_ids = var.subnet_ids

  # Common tags
  common_tags = {
    Environment = var.environment
    Project     = "Specter"
    ManagedBy   = "Terraform"
  }

  oneshot_otel_traces_endpoint  = "http://127.0.0.1:4317"
  oneshot_otel_metrics_endpoint = "http://127.0.0.1:4318"
  oneshot_uses_openai_reviewer = var.enable_oneshot && (
    var.oneshot_reviewer_provider == "openai" ||
    var.oneshot_code_reviewer_provider == "openai"
  )
  oneshot_cwagent_config_content = jsonencode({
    agent = {
      region = var.aws_region
    }
    metrics = {
      namespace = var.oneshot_otel_metrics_namespace
      metrics_collected = {
        otlp = {
          http_endpoint = "0.0.0.0:4318"
        }
      }
    }
    traces = {
      traces_collected = {
        otlp = {
          http_endpoint = "0.0.0.0:4317"
        }
      }
    }
  })
  spec_factory_otel_traces_endpoint  = "http://127.0.0.1:4317"
  spec_factory_otel_metrics_endpoint = "http://127.0.0.1:4318"
  spec_factory_cwagent_config_content = jsonencode({
    agent = {
      region = var.aws_region
    }
    metrics = {
      namespace = var.spec_factory_otel_metrics_namespace
      metrics_collected = {
        otlp = {
          http_endpoint = "0.0.0.0:4318"
        }
      }
    }
    traces = {
      traces_collected = {
        otlp = {
          http_endpoint = "0.0.0.0:4317"
        }
      }
    }
  })

  builtin_worker_agents = {
    darci = {
      cpu           = var.darci_cpu
      memory        = var.darci_memory
      desired_count = var.darci_desired_count
    }
    scribe = {
      cpu           = var.scribe_cpu
      memory        = var.scribe_memory
      desired_count = var.scribe_desired_count
    }
    prism = {
      cpu           = var.prism_cpu
      memory        = var.prism_memory
      desired_count = var.prism_desired_count
    }
    hermes = {
      cpu           = var.hermes_cpu
      memory        = var.hermes_memory
      desired_count = var.hermes_desired_count
    }
    sentry = {
      cpu           = var.sentry_cpu
      memory        = var.sentry_memory
      desired_count = var.sentry_desired_count
    }
    beacon = {
      cpu           = var.beacon_cpu
      memory        = var.beacon_memory
      desired_count = var.beacon_desired_count
    }
    "bcat-planner" = {
      cpu           = var.bcat_planner_cpu
      memory        = var.bcat_planner_memory
      desired_count = var.bcat_planner_desired_count
    }
    "bcat-executor" = {
      cpu           = var.bcat_executor_cpu
      memory        = var.bcat_executor_memory
      desired_count = var.bcat_executor_desired_count
    }
    veritas = {
      cpu           = var.veritas_cpu
      memory        = var.veritas_memory
      desired_count = var.veritas_desired_count
    }
    srlog = {
      cpu           = var.srlog_cpu
      memory        = var.srlog_memory
      desired_count = var.srlog_desired_count
    }
  }

  oneshot_worker_agents = var.enable_oneshot ? {
    qualifier = {
      cpu           = var.qualifier_cpu
      memory        = var.qualifier_memory
      desired_count = var.qualifier_desired_count
    }
  } : {}

  oneshot_consumers = var.enable_oneshot ? {
    planner = {
      cpu           = var.oneshot_planner_cpu
      memory        = var.oneshot_planner_memory
      desired_count = var.oneshot_planner_desired_count
      role          = "PLANNER"
    }
    reviewer = {
      cpu           = var.oneshot_reviewer_cpu
      memory        = var.oneshot_reviewer_memory
      desired_count = var.oneshot_reviewer_desired_count
      role          = "REVIEWER"
    }
    implementer = {
      cpu           = var.oneshot_implementer_cpu
      memory        = var.oneshot_implementer_memory
      desired_count = var.oneshot_implementer_desired_count
      role          = "IMPLEMENTER"
    }
    code_reviewer = {
      cpu           = var.oneshot_code_reviewer_cpu
      memory        = var.oneshot_code_reviewer_memory
      desired_count = var.oneshot_code_reviewer_desired_count
      role          = "CODE_REVIEWER"
    }
    tester = {
      cpu           = var.oneshot_tester_cpu
      memory        = var.oneshot_tester_memory
      desired_count = var.oneshot_tester_desired_count
      role          = "TESTER"
    }
  } : {}

  all_worker_agents              = merge(local.builtin_worker_agents, local.oneshot_worker_agents, var.additional_worker_agents)
  agent_registry_lambda_zip_path = "${path.module}/build/agent-registry-lambda.zip"
  # Keep Lambda update detection stable across packaging environments by hashing
  # the tracked source inputs rather than the generated zip bytes.
  agent_registry_lambda_source_hash = base64sha256(join("", [
    for file in sort(fileset("${path.module}/lambda/agent_registry", "**")) :
    "${file}:${filebase64sha256("${path.module}/lambda/agent_registry/${file}")}"
    if !startswith(file, "__pycache__/") && !endswith(file, ".pyc")
  ]))
}

resource "aws_ssm_parameter" "oneshot_cwagent_config" {
  count = var.enable_oneshot && var.oneshot_otel_enabled ? 1 : 0

  name        = "/specter/${var.environment}/oneshot/cwagent/config"
  description = "CloudWatch agent OTEL sidecar config for Specter OneShot services"
  type        = "String"
  value       = local.oneshot_cwagent_config_content

  tags = merge(local.common_tags, {
    Name = "specter-${var.environment}-oneshot-cwagent-config"
  })
}

resource "aws_kms_key" "spec_factory_ssm" {
  count = var.enable_spec_factory && var.spec_factory_otel_enabled ? 1 : 0

  description             = "Encrypts Spec Factory CloudWatch Agent configuration in Parameter Store"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "spec-factory-ssm-key-policy"
    Statement = [
      {
        Sid    = "EnableAccountIAMPolicies"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${local.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      }
    ]
  })

  tags = merge(local.common_tags, {
    Name = "specter-${var.environment}-spec-factory-ssm"
  })
}

resource "aws_kms_alias" "spec_factory_ssm" {
  count = var.enable_spec_factory && var.spec_factory_otel_enabled ? 1 : 0

  name          = "alias/specter-${var.environment}-spec-factory-ssm"
  target_key_id = aws_kms_key.spec_factory_ssm[0].key_id
}

resource "aws_ssm_parameter" "spec_factory_cwagent_config" {
  count = var.enable_spec_factory && var.spec_factory_otel_enabled ? 1 : 0

  name        = "/specter/${var.environment}/spec-factory/cwagent/config"
  description = "CloudWatch Agent OTLP sidecar config for Spec Factory services"
  type        = "SecureString"
  key_id      = aws_kms_key.spec_factory_ssm[0].arn
  value       = local.spec_factory_cwagent_config_content

  tags = merge(local.common_tags, {
    Name = "specter-${var.environment}-spec-factory-cwagent-config"
  })
}
