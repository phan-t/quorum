output "ecr_repository_url" {
  description = "Registry path `make deploy` pushes to and the environments pull from."
  value       = aws_ecr_repository.quorum.repository_url
}

output "ecr_repository_name" {
  description = "Pass this to each environment as ecr_repository_name."
  value       = aws_ecr_repository.quorum.name
}
