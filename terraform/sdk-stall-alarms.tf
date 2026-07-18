# CloudWatch metric filters + alarms for SDK stall and timeout events emitted
# by the Claude SDK wrapper in src/claude-sdk/index.ts.
#
# Matched log events (pino JSON, key $.msg):
#   [SDK_TIMEOUT]              — wall-clock timeout fired, agent aborted
#   [SDK_STALLED_NO_TOOLS]     — stream ended without any tool calls
#   [SDK_STALLED_POST_TOOLS]   — stream froze after at least one tool call
#   [SDK_IDLE_ABORT]           — idle watchdog aborted the run
#
# A single metric filter per log group rolls all four stall signatures into
# one Specter/SDK/StallCount metric, dimensioned by agent key. Alarms fire
# when any single 5-minute window observes >= 1 stall event and route to the
# existing oneshot_alerts SNS topic (which already fans out to Teams).
#
# Toggle with var.enable_sdk_stall_alarms (default true).

locals {
  # Map of alarm key => { log_group_name, agent dimension value }.
  # One entry per CloudWatch log group the Claude SDK writes into.
  sdk_stall_targets = merge(
    # Legacy worker agents: /ecs/specter/<agent>-worker
    {
      for agent_key, agent_cfg in local.all_worker_agents :
      "${agent_key}-worker" => {
        log_group_name = aws_cloudwatch_log_group.workers[agent_key].name
        agent          = "${agent_key}-worker"
      }
    },
    # OneShot consumers: /ecs/specter/oneshot-<role>
    {
      for consumer_key, consumer_cfg in local.oneshot_consumers :
      "oneshot-${consumer_key}" => {
        log_group_name = aws_cloudwatch_log_group.oneshot[consumer_key].name
        agent          = "oneshot-${consumer_key}"
      }
    },
  )

  sdk_stall_targets_effective = var.enable_sdk_stall_alarms ? local.sdk_stall_targets : {}

  # JSON filter pattern — matches any of the four stall/timeout event strings
  # in the pino $.msg field. Wildcards allow the trailing human-readable text
  # on [SDK_TIMEOUT] ("Claude SDK timeout - aborting") to still match.
  sdk_stall_filter_pattern = "{ ($.msg = \"*SDK_TIMEOUT*\") || ($.msg = \"*SDK_STALLED_NO_TOOLS*\") || ($.msg = \"*SDK_STALLED_POST_TOOLS*\") || ($.msg = \"*SDK_IDLE_ABORT*\") }"

  sdk_stall_metric_namespace = "Specter/SDK"
}

# One metric per agent, kept distinct via a per-agent metric name
# (e.g. StallCount_darci-worker). The CloudWatch API disallows pairing
# `default_value` with `dimensions` on a single metric transformation,
# so we encode the agent into the metric name instead. Alarms reference
# the same per-agent metric name, giving us a clean 1:1 between filter,
# metric, and alarm.
resource "aws_cloudwatch_log_metric_filter" "sdk_stall" {
  for_each = local.sdk_stall_targets_effective

  name           = "${var.environment}-sdk-stall-${each.key}"
  log_group_name = each.value.log_group_name
  pattern        = local.sdk_stall_filter_pattern

  metric_transformation {
    name          = "StallCount_${each.value.agent}"
    namespace     = local.sdk_stall_metric_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "sdk_stall" {
  for_each = local.sdk_stall_targets_effective

  alarm_name          = "${var.environment}-sdk-stall-${each.key}"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "StallCount_${each.value.agent}"
  namespace           = local.sdk_stall_metric_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "Claude SDK stall/timeout event observed in ${each.value.log_group_name} — matches [SDK_TIMEOUT] / [SDK_STALLED_NO_TOOLS] / [SDK_STALLED_POST_TOOLS] / [SDK_IDLE_ABORT]"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.oneshot_alarm_actions
  ok_actions          = local.oneshot_alarm_actions

  tags = merge(local.common_tags, {
    Service = each.value.agent
    Purpose = "sdk-stall-alarm"
  })

  depends_on = [aws_cloudwatch_log_metric_filter.sdk_stall]
}
