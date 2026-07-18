moved {
  from = aws_cloudwatch_log_group.darci_worker
  to   = aws_cloudwatch_log_group.workers["darci"]
}

moved {
  from = aws_cloudwatch_log_group.scribe_worker
  to   = aws_cloudwatch_log_group.workers["scribe"]
}

moved {
  from = aws_cloudwatch_log_group.prism_worker
  to   = aws_cloudwatch_log_group.workers["prism"]
}

moved {
  from = aws_cloudwatch_log_group.hermes_worker
  to   = aws_cloudwatch_log_group.workers["hermes"]
}

moved {
  from = aws_cloudwatch_log_group.sentry_worker
  to   = aws_cloudwatch_log_group.workers["sentry"]
}

moved {
  from = aws_cloudwatch_log_group.beacon_worker
  to   = aws_cloudwatch_log_group.workers["beacon"]
}

moved {
  from = aws_cloudwatch_log_group.bcat_planner_worker
  to   = aws_cloudwatch_log_group.workers["bcat-planner"]
}

moved {
  from = aws_cloudwatch_log_group.bcat_executor_worker
  to   = aws_cloudwatch_log_group.workers["bcat-executor"]
}

moved {
  from = aws_cloudwatch_log_group.veritas_worker
  to   = aws_cloudwatch_log_group.workers["veritas"]
}

moved {
  from = aws_cloudwatch_log_group.srlog_worker
  to   = aws_cloudwatch_log_group.workers["srlog"]
}
