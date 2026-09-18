output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "Both subnets. The ALB spans them; the task lands in whichever one ECS picks."
  value       = [for s in aws_subnet.public : s.id]
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "task_security_group_id" {
  value = aws_security_group.tasks.id
}
