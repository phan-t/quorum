# One repository, in the root beside everything else.
#
# It used to be argued into a bootstrap workspace of its own, on the grounds
# that two environments cannot both own the same repository. There is one
# environment and one workspace, so that argument has no subject: a registry
# alone did not justify a second apply, a second variable set and a
# cross-workspace data source.
#
# The cost is that `terraform destroy` now takes the images with it, so a
# destroy is followed by `make deploy` rather than `make up`. Since the service
# is parked at zero rather than destroyed, that rarely comes due.
#
# Nothing else in this repository references the repository's ARN: there is no
# CI role to scope, because the account permits no machine identity at all.
# `make push` logs in with the operator's own session.

resource "aws_ecr_repository" "quorum" {
  name = var.ecr_repository_name

  # MUTABLE, deliberately. Images are tagged sha-<short>, which is immutable in
  # practice, and also `main`, which by definition moves.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(local.tags, { Name = var.ecr_repository_name })
}

resource "aws_ecr_lifecycle_policy" "quorum" {
  repository = aws_ecr_repository.quorum.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the last ${var.image_retention_count} images; a rollback never needs to reach further back than that."
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.image_retention_count
        }
        action = { type = "expire" }
      },
    ]
  })
}
