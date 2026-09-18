output "table_name" {
  value = aws_dynamodb_table.quorum.name
}

output "table_arn" {
  description = "The task role's DynamoDB permissions are scoped to exactly this ARN."
  value       = aws_dynamodb_table.quorum.arn
}

output "admin_key_parameter_arn" {
  description = "Referenced by the task definition's `secrets`, so the value reaches the container without reaching Terraform."
  value       = aws_ssm_parameter.admin_key.arn
}

output "admin_key_parameter_name" {
  description = "For the `aws ssm put-parameter` a human runs once."
  value       = aws_ssm_parameter.admin_key.name
}
