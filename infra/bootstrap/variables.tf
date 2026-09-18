variable "aws_account_id" {
  description = "The AWS account everything is created in. Also the account half of every role ARN the workflows and workspaces assume."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
}

variable "aws_region" {
  description = "Region for the ECR repository. IAM is global; this only decides where images live and where the envs are expected to run."
  type        = string
}

variable "tfc_organization" {
  description = "HCP Terraform organization name. Appears verbatim in the quorum-tfc-run trust policy, so a typo here means every run fails to authenticate."
  type        = string
}

variable "tfc_project" {
  description = "HCP Terraform project holding the quorum workspaces. Scoping the trust policy to a project means a workspace created elsewhere in the org cannot assume this role by naming itself quorum-something."
  type        = string
}

variable "github_repository" {
  description = "org/repo for the GitHub Actions trust policy, e.g. phan-t/quorum. Only the main branch of this repository can mint a token for the ECR push role."
  type        = string

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repository))
    error_message = "Use the org/repo form, with no leading https:// and no trailing .git."
  }
}

variable "ecr_repository_name" {
  description = "Name of the one ECR repository. One repository, not one per environment: staging and prod deploy the same image, and promoting a tag beats rebuilding it."
  type        = string
  default     = "quorum"
}

variable "image_retention_count" {
  description = "How many images the lifecycle policy keeps."
  type        = number
  default     = 20
}

variable "additional_tags" {
  description = "Cost centre, owner, whatever this account's tagging policy requires. Merged into the default tags on every resource."
  type        = map(string)
  default     = {}
}
