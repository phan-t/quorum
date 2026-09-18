output "url" {
  value = module.service.url
}

output "healthz_url" {
  description = "The deploy workflow reads this to confirm the new version is answering and to refuse to deploy over a live session."
  value       = module.service.healthz_url
}

output "image" {
  description = "Exactly what is deployed. This is the answer to 'what is running right now', and it is in run history with who changed it."
  value       = module.service.image
}

output "admin_key_parameter_name" {
  description = "Set the real value with the AWS CLI once. Terraform created the parameter with a placeholder and ignores its value from then on."
  value       = module.data.admin_key_parameter_name
}

output "dynamodb_table_name" {
  value = module.data.table_name
}

output "log_group_name" {
  value = module.service.log_group_name
}

output "desired_count" {
  description = "Read by the deploy workflow: a parked environment (0) has no /healthz to assert against, and that is not a failed deploy."
  value       = var.desired_count
}
