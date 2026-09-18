output "tfc_run_role_arn" {
  description = "Set this as TFC_AWS_RUN_ROLE_ARN (environment variable, not Terraform variable) on quorum-staging and quorum-prod."
  value       = aws_iam_role.tfc_run.arn
}

output "gha_ecr_push_role_arn" {
  description = "Set this as the AWS_ROLE_ARN repository variable in GitHub."
  value       = aws_iam_role.gha_ecr_push.arn
}

output "ecr_repository_url" {
  description = "Registry path the deploy workflow pushes to and the environments pull from."
  value       = aws_ecr_repository.quorum.repository_url
}

output "ecr_repository_name" {
  description = "Set this as the ECR_REPOSITORY repository variable in GitHub, and pass it to each environment."
  value       = aws_ecr_repository.quorum.name
}
