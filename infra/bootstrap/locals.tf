locals {
  tags = merge(
    {
      Project    = "quorum"
      Component  = "bootstrap"
      ManagedBy  = "terraform"
      Workspace  = "quorum-bootstrap"
      Repository = "phan-t/quorum"
    },
    var.additional_tags,
  )
}
