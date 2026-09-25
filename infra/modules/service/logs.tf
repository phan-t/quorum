resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name_prefix}"
  retention_in_days = var.log_retention_days

  tags = merge(var.tags, { Name = "/ecs/${var.name_prefix}" })
}

# "Is it running?" is the only question worth waking someone for, and with
# desired_count = 1 and no autoscaling the answer is a single number.
#
# RunningTaskCount comes from Container Insights, which is why it is enabled on
# the cluster. Standard Container Insights on one task is cents a month.
#
# Deliberately not created at all when desired_count is 0: the service parked
# between events is the expected state, not an incident, and an alarm that is
# always firing between October and March is an alarm nobody reads in March.
resource "aws_cloudwatch_metric_alarm" "running_task_count" {
  count = var.desired_count > 0 ? 1 : 0

  alarm_name          = "${var.name_prefix}-no-running-task"
  alarm_description   = "The Quorum ${var.environment} task is not running. Expected briefly during a deploy; anything longer is an outage."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Maximum"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 3

  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.this.name
  }

  # A deploy stops the old task before starting the new one, so the metric
  # legitimately goes missing for twenty seconds. Treating that as breaching
  # would page on every deploy.
  treat_missing_data = "notBreaching"

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions

  tags = merge(var.tags, { Name = "${var.name_prefix}-no-running-task" })
}
