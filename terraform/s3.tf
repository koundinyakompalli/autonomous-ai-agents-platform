# S3 Buckets for Specter
# - specter-tasks: Task descriptions from Orchestrator
# - specter-results: Analysis results from Workers

# ============================================================================
# TASK DESCRIPTIONS BUCKET
# ============================================================================

resource "aws_s3_bucket" "tasks" {
  bucket = var.s3_task_bucket

  tags = merge(local.common_tags, {
    Name    = "specter-tasks"
    Purpose = "Task descriptions from Orchestrator"
  })
}

resource "aws_s3_bucket_versioning" "tasks" {
  bucket = aws_s3_bucket.tasks.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "tasks" {
  bucket = aws_s3_bucket.tasks.id

  rule {
    id     = "cleanup-old-tasks"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

# ============================================================================
# RESULTS BUCKET
# ============================================================================

resource "aws_s3_bucket" "results" {
  bucket = var.s3_result_bucket

  tags = merge(local.common_tags, {
    Name    = "specter-results"
    Purpose = "Agent analysis results"
  })
}

resource "aws_s3_bucket_versioning" "results" {
  bucket = aws_s3_bucket.results.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "results" {
  bucket = aws_s3_bucket.results.id

  rule {
    id     = "transition-to-glacier"
    status = "Enabled"

    filter {}

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 365
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# compose_upload_allowed_origins defaults to ["*"] (presigned URLs are self-authenticating).
# Tighten to the dashboard origin(s) via shared.auto.tfvars at deploy time.
resource "aws_s3_bucket_cors_configuration" "results_compose" {
  bucket = aws_s3_bucket.results.id

  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.compose_upload_allowed_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# ============================================================================
# WATCHDOG EVIDENCE BUCKET
# ============================================================================

resource "aws_s3_bucket" "watchdog_evidence" {
  count  = var.enable_watchdog ? 1 : 0
  bucket = var.watchdog_evidence_bucket

  tags = merge(local.common_tags, {
    Name    = var.watchdog_evidence_bucket
    Purpose = "Redacted Watchdog investigation evidence"
  })
}

resource "aws_s3_bucket_versioning" "watchdog_evidence" {
  count  = var.enable_watchdog ? 1 : 0
  bucket = aws_s3_bucket.watchdog_evidence[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "watchdog_evidence" {
  count  = var.enable_watchdog ? 1 : 0
  bucket = aws_s3_bucket.watchdog_evidence[0].id

  rule {
    id     = "cleanup-watchdog-evidence"
    status = "Enabled"

    filter {
      prefix = "watchdog/evidence/"
    }

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}
