# One repository, in bootstrap rather than in either environment.
#
# ARCHITECTURE.md says "one repository" and also gives staging and prod separate
# workspaces. Both cannot own the same repository, and the deploy flow — build
# once, promote the same digest from staging to prod — is the reason there is
# only one. So it lives here, with the other things that exist before any
# environment can be applied, and the environments read it with a data source.
#
# It is also what lets the GitHub role's policy below name an exact ARN instead
# of a guessed one.

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
