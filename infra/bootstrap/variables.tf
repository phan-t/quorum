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
