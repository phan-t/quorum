output "url" {
  value = module.service.url
}

output "healthz_url" {
  description = "Where to look after an apply. `make up` polls it until it answers, and `sessionsLive` in the body is how you check nobody is mid-session before deploying."
  value       = module.service.healthz_url
}

output "image" {
  description = "Exactly what is deployed. This is the answer to 'what is running right now', and it is in run history with who changed it. `make up` and `make down` read it back so raising a parked service cannot also change the image."
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
  description = "0 when parked, 1 when raised. Worth printing because a parked service has no /healthz to answer, and that is the resting state rather than a fault."
  value       = var.desired_count
}
