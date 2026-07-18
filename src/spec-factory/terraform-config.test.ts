import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Spec Factory Terraform config", () => {
  it("sets a dedicated Compose chat model override to Claude Sonnet 5", async () => {
    const [ecsTf, iamTf, sharedTfvars, variablesTf] = await Promise.all([
      readFile("terraform/spec-factory-ecs.tf", "utf8"),
      readFile("terraform/iam.tf", "utf8"),
      readFile("terraform/shared.auto.tfvars", "utf8"),
      readFile("terraform/variables.tf", "utf8"),
    ]);

    expect(variablesTf).toMatch(
      /variable "compose_chat_model_id" \{[\s\S]*?default\s+= "us\.anthropic\.claude-sonnet-5"/,
    );
    expect(sharedTfvars).toMatch(
      /compose_chat_model_id\s+= "us\.anthropic\.claude-sonnet-5"/,
    );
    expect(ecsTf).toContain(
      '{ name = "COMPOSE_CHAT_MODEL_ID", value = var.compose_chat_model_id }',
    );
    expect(iamTf).toContain('trimspace(var.compose_chat_model_id) != ""');
    expect(iamTf).toContain(
      '"arn:aws:bedrock:*:*:inference-profile/${var.compose_chat_model_id}"',
    );
  });

  it("grants the split API role Bedrock inference for synchronous qualifiers", async () => {
    const iamTf = await readFile("terraform/iam.tf", "utf8");
    const bedrockRoles = iamTf.match(
      /spec_factory_bedrock_roles\s*=\s*toset\(\[([\s\S]*?)\]\)/,
    )?.[1];

    expect(bedrockRoles).toBeDefined();
    expect(bedrockRoles).toContain('"api"');
    expect(iamTf).toMatch(
      /contains\(local\.spec_factory_bedrock_roles, each\.key\) \? \[\{[\s\S]*?"bedrock:InvokeModelWithResponseStream"/,
    );
  });

  it("exposes all Compose cleanup retention knobs to ECS", async () => {
    const [ecsTf, variablesTf] = await Promise.all([
      readFile("terraform/spec-factory-ecs.tf", "utf8"),
      readFile("terraform/variables.tf", "utf8"),
    ]);

    for (const variableName of [
      "compose_artifact_tmp_retention_hours",
      "compose_artifact_gc_limit",
      "compose_artifact_gc_max_depth",
      "spec_factory_llm_audit_artifact_retention_days",
      "spec_factory_llm_audit_artifact_gc_limit",
      "compose_s3_reachability_gc_enabled",
      "compose_s3_reachability_gc_limit",
    ]) {
      expect(variablesTf).toContain(`variable "${variableName}"`);
    }

    for (const envBinding of [
      '{ name = "COMPOSE_ARTIFACT_TMP_RETENTION_HOURS", value = tostring(var.compose_artifact_tmp_retention_hours) }',
      '{ name = "COMPOSE_ARTIFACT_GC_LIMIT", value = tostring(var.compose_artifact_gc_limit) }',
      '{ name = "COMPOSE_ARTIFACT_GC_MAX_DEPTH", value = tostring(var.compose_artifact_gc_max_depth) }',
      '{ name = "SPEC_FACTORY_LLM_AUDIT_ARTIFACT_RETENTION_DAYS", value = tostring(var.spec_factory_llm_audit_artifact_retention_days) }',
      '{ name = "SPEC_FACTORY_LLM_AUDIT_ARTIFACT_GC_LIMIT", value = tostring(var.spec_factory_llm_audit_artifact_gc_limit) }',
      '{ name = "COMPOSE_S3_REACHABILITY_GC_ENABLED", value = tostring(var.compose_s3_reachability_gc_enabled) }',
      '{ name = "COMPOSE_S3_REACHABILITY_GC_LIMIT", value = tostring(var.compose_s3_reachability_gc_limit) }',
    ]) {
      expect(
        ecsTf.match(new RegExp(escapeRegExp(envBinding), "g")),
      ).toHaveLength(2);
    }
  });

  it("owns task egress exclusively through standalone rules", async () => {
    const ecsTf = await readFile("terraform/spec-factory-ecs.tf", "utf8");
    const securityGroupStart = ecsTf.indexOf(
      'resource "aws_security_group" "spec_factory_tasks"',
    );
    const firstEgressRule = ecsTf.indexOf(
      'resource "aws_security_group_rule" "spec_factory_https_egress"',
    );

    expect(securityGroupStart).toBeGreaterThanOrEqual(0);
    expect(firstEgressRule).toBeGreaterThan(securityGroupStart);
    expect(ecsTf.slice(securityGroupStart, firstEgressRule)).not.toMatch(
      /\n\s+egress\s*\{/,
    );

    for (const ruleName of [
      "spec_factory_https_egress",
      "spec_factory_dns_udp_egress",
      "spec_factory_dns_tcp_egress",
      "spec_factory_rds_egress",
      "spec_factory_efs_egress",
    ]) {
      expect(ecsTf).toContain(
        `resource "aws_security_group_rule" "${ruleName}"`,
      );
    }
  });

  it("uses static worker keys for autoscaling policies", async () => {
    const ecsTf = await readFile("terraform/spec-factory-ecs.tf", "utf8");

    expect(ecsTf).toContain(
      "for_each = var.enable_spec_factory && var.spec_factory_autoscaling_enabled ? local.spec_factory_autoscaled_workers : {}",
    );
    expect(ecsTf).toContain(
      "resource_id        = aws_appautoscaling_target.spec_factory_workers[each.key].resource_id",
    );
    expect(ecsTf).not.toContain(
      "for_each = aws_appautoscaling_target.spec_factory_workers",
    );
  });

  it("pins primary dispatch to the multi-AZ HA floor", async () => {
    const sharedTfvars = await readFile("terraform/shared.auto.tfvars", "utf8");

    const expected = {
      spec_factory_queue_dispatch_mode: '"primary"',
      spec_factory_outbox_enabled: "true",
      spec_factory_worker_desired_count: "0",
      spec_factory_turn_worker_desired_count: "2",
      spec_factory_context_worker_desired_count: "2",
      spec_factory_research_worker_desired_count: "2",
      spec_factory_conversion_worker_desired_count: "2",
      spec_factory_draft_worker_desired_count: "2",
      spec_factory_relay_worker_desired_count: "2",
      spec_factory_retention_worker_desired_count: "1",
    };
    for (const [name, value] of Object.entries(expected)) {
      expect(sharedTfvars).toMatch(
        new RegExp(
          `^${escapeRegExp(name)}\\s*=\\s*${escapeRegExp(value)}$`,
          "m",
        ),
      );
    }

    expect(sharedTfvars).toMatch(/^spec_factory_desired_count\s*=\s*2$/m);
    expect(sharedTfvars).toMatch(
      /^spec_factory_runtime_subnet_ids\s*=\s*\["subnet-[^"]+", "subnet-[^"]+"\]$/m,
    );
    expect(sharedTfvars).toMatch(
      /^spec_factory_single_replica_alarm_enabled\s*=\s*false$/m,
    );
    expect(sharedTfvars).toMatch(
      /^spec_factory_autoscaling_enabled\s*=\s*true$/m,
    );
    expect(sharedTfvars).toMatch(
      /^spec_factory_durable_events_required\s*=\s*true$/m,
    );
  });

  it("protects active queue work before allowing worker scale-in", async () => {
    const ecsTf = await readFile("terraform/spec-factory-ecs.tf", "utf8");
    const sharedTfvars = await readFile("terraform/shared.auto.tfvars", "utf8");

    expect(ecsTf).toContain(
      'resource "aws_appautoscaling_policy" "spec_factory_api_requests"',
    );
    expect(ecsTf).toContain(
      'predefined_metric_type = "ALBRequestCountPerTarget"',
    );
    expect(ecsTf).toMatch(
      /resource "aws_appautoscaling_policy" "spec_factory_worker_backlog" \{[\s\S]*?disable_scale_in\s*=\s*!var\.spec_factory_worker_scale_in_enabled/,
    );
    expect(ecsTf).toContain(
      'name = "SPEC_FACTORY_ECS_TASK_PROTECTION_ENABLED"',
    );
    expect(ecsTf).toContain(
      "(!var.spec_factory_worker_scale_in_enabled || var.spec_factory_ecs_task_protection_enabled)",
    );
    expect(ecsTf).toContain('check "spec_factory_runtime_subnets"');
    expect(ecsTf).toContain('check "spec_factory_horizontal_scaling_gates"');
    expect(ecsTf).toContain(
      'resource "aws_cloudwatch_metric_alarm" "spec_factory_api_running_tasks_low"',
    );
    expect(sharedTfvars).toMatch(
      /^spec_factory_ecs_task_protection_enabled\s*=\s*true$/m,
    );
    expect(sharedTfvars).toMatch(
      /^spec_factory_worker_scale_in_enabled\s*=\s*true$/m,
    );
  });

  it("pins production images and accepted context repair evidence", async () => {
    const [mainTf, sharedTfvars] = await Promise.all([
      readFile("terraform/main.tf", "utf8"),
      readFile("terraform/shared.auto.tfvars", "utf8"),
    ]);

    expect(sharedTfvars).toMatch(
      /^spec_factory_pin_image_by_digest\s*=\s*true$/m,
    );
    expect(sharedTfvars).toMatch(
      /^spec_factory_context_v4_repair_run_id\s*=\s*7$/m,
    );
    expect(sharedTfvars).toMatch(
      /^spec_factory_otel_sidecar_image\s*=\s*"public\.ecr\.aws\/cloudwatch-agent\/cloudwatch-agent@sha256:[a-f0-9]{64}"$/m,
    );
    expect(sharedTfvars).not.toMatch(
      /^spec_factory_otel_sidecar_image\s*=\s*"[^"]*:latest"$/m,
    );
    expect(sharedTfvars).toMatch(
      /^compose_retention_cleanup_enabled\s*=\s*true$/m,
    );
    expect(sharedTfvars).toMatch(/^compose_cleanup_dry_run\s*=\s*true$/m);
    expect(mainTf).toMatch(
      /ignore_tags\s*\{[\s\S]*?keys\s*=\s*\[[\s\S]*?"ProductLine"[\s\S]*?\]/,
    );
  });

  it("enables the shared data plane only on private multi-AZ subnets", async () => {
    const [dataPlaneTf, ecsTf, sharedTfvars] = await Promise.all([
      readFile("terraform/spec-factory-data-plane.tf", "utf8"),
      readFile("terraform/spec-factory-ecs.tf", "utf8"),
      readFile("terraform/shared.auto.tfvars", "utf8"),
    ]);

    expect(sharedTfvars).toMatch(/^spec_factory_valkey_enabled\s*=\s*true$/m);
    expect(sharedTfvars).toMatch(
      /^spec_factory_rds_proxy_enabled\s*=\s*true$/m,
    );
    expect(sharedTfvars).toMatch(
      /^spec_factory_rds_direct_fallback_enabled\s*=\s*true$/m,
    );
    expect(sharedTfvars).toMatch(
      /^spec_factory_rds_proxy_db_instance_identifier\s*=\s*"document-ai-prod-mysql"$/m,
    );
    expect(sharedTfvars).toMatch(
      /^spec_factory_data_subnet_ids\s*=\s*\["subnet-[^"]+", "subnet-[^"]+", "subnet-[^"]+"\]$/m,
    );
    expect(sharedTfvars).toMatch(
      /^spec_factory_db_secret_kms_key_arn\s*=\s*"arn:aws:kms:us-east-2:\d{12}:key\/[a-f0-9-]+"$/m,
    );
    expect(dataPlaneTf).toContain(
      "subnet.vpc_id == local.vpc_id && !subnet.map_public_ip_on_launch",
    );
    expect(dataPlaneTf).toContain(
      "length(distinct([for subnet in data.aws_subnet.spec_factory_data : subnet.availability_zone])) >= 2",
    );
    expect(dataPlaneTf).toContain(
      "vpc_subnet_ids         = local.spec_factory_data_subnet_ids",
    );
    expect(
      ecsTf.match(/aws_db_proxy_target\.spec_factory_existing/g),
    ).toHaveLength(2);
    expect(
      ecsTf.match(/aws_db_proxy_target\.spec_factory_aurora/g),
    ).toHaveLength(2);
    expect(ecsTf).toContain(
      "(!var.spec_factory_rds_proxy_enabled || var.spec_factory_rds_direct_fallback_enabled)",
    );
  });

  it("pins every Spec Factory LLM purpose output limit to 10000", async () => {
    const sharedTfvars = await readFile("terraform/shared.auto.tfvars", "utf8");
    for (const purpose of [
      "chat_coordinator_fast",
      "chat_coordinator_strong",
      "source_distillation",
      "context_merge",
      "critic_review",
      "handoff_synthesis",
      "conversation_summary",
    ]) {
      expect(sharedTfvars).toMatch(
        new RegExp(
          `^spec_factory_llm_max_output_tokens_${purpose}\\s*=\\s*"10000"$`,
          "m",
        ),
      );
    }
  });

  it("routes latency-sensitive coordination directly and gives turn workers repository access", async () => {
    const [ecsTf, sharedTfvars] = await Promise.all([
      readFile("terraform/spec-factory-ecs.tf", "utf8"),
      readFile("terraform/shared.auto.tfvars", "utf8"),
    ]);

    expect(sharedTfvars).toMatch(
      /^spec_factory_llm_direct_bedrock_purposes\s*=\s*"chat_coordinator_fast,context_merge"$/m,
    );
    expect(ecsTf).toContain(
      'contains(["worker", "turn-worker", "research-worker", "draft-worker"], each.key)',
    );
    expect(ecsTf).toContain('name      = "GITHUB_REPO_TOKEN"');
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
