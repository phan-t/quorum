output "url" {
  description = "Where the room goes."
  value       = "https://${var.domain_name}"
}

output "healthz_url" {
  description = "Where to look after an apply. `make up` polls it until it answers, and `sessionsLive` in the body is how a person checks nobody is mid-session before deploying."
  value       = "https://${var.domain_name}/healthz"
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_name" {
  value = aws_ecs_service.this.name
}

output "task_definition_arn" {
  description = "Which revision is deployed. The answer to 'what is in prod right now' lives in state, not in a console."
  value       = aws_ecs_task_definition.this.arn
}

output "image" {
  value = "${var.image_repository_url}:${var.image_tag}"
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}
