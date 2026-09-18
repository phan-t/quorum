# Everything here is an HCP Terraform *Terraform variable* on the quorum-staging
# workspace. Nothing in this file is a secret, and nothing in this file has a
# default it should not have — the four identifiers at the top have no defaults
# because guessing them would produce an apply against the wrong account or the
# wrong domain.

variable "aws_account_id" {
  description = "The AWS account this environment lives in. Guards against applying to the wrong one."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
}

variable "aws_region" {
  description = "Region. ARCHITECTURE.md picks ap-southeast-2; the latency correction handles the rest of APJ."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route 53 zone id that owns domain_name. The zone is not created here — it is a delegation someone made at a registrar."
  type        = string
}

variable "domain_name" {
  description = "Fully qualified hostname for this environment, e.g. quorum-staging.example.com."
  type        = string
}

variable "image_tag" {
  description = "Container tag to run, e.g. sha-a1b2c3d. The deploy workflow PATCHes this on the workspace and then creates a run; that run is the deploy. No default: an environment should never quietly run whatever `latest` happens to mean."
  type        = string
}

# --- things with sensible defaults -------------------------------------------

variable "ecr_repository_name" {
  description = "The one repository, created by the bootstrap workspace and read here."
  type        = string
  default     = "quorum"
}

variable "desired_count" {
  description = "0 or 1. Staging sits at 0 between rehearsals: set it to 1, run the bots, set it back. That takes Fargate to zero and leaves the ALB as the floor."
  type        = number
  default     = 0
}

variable "task_cpu" {
  type    = number
  default = 512
}

variable "task_memory" {
  type    = number
  default = 1024
}

variable "log_level" {
  type    = string
  default = "debug"
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "vpc_cidr" {
  description = "Distinct per environment so the two could ever be peered without renumbering."
  type        = string
  default     = "10.40.0.0/20"
}

variable "alarm_actions" {
  description = "SNS topic ARNs for the RunningTaskCount alarm."
  type        = list(string)
  default     = []
}

variable "additional_tags" {
  description = "Cost centre, owner, whatever this account's tagging policy requires."
  type        = map(string)
  default     = {}
}
