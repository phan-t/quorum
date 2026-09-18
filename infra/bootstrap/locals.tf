locals {
  tags = merge(
    {
      Project    = "quorum"
      Component  = "bootstrap"
      ManagedBy  = "terraform"
      Workspace  = "quorum-bootstrap"
      Repository = var.github_repository
    },
    var.additional_tags,
  )
}
