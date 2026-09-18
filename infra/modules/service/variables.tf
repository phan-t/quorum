variable "name_prefix" {
  description = "Prefix for every resource name, e.g. quorum-staging."
  type        = string
}

variable "environment" {
  description = "staging or prod. Reaches the container as QUORUM_ENV."
  type        = string
}

variable "aws_region" {
  description = "Region. Reaches the container as AWS_REGION so the DynamoDB client does not have to guess."
  type        = string
}

# --- DNS and TLS -------------------------------------------------------------

variable "domain_name" {
  description = "Fully qualified hostname for this environment, e.g. quorum.example.com. The certificate is issued for it and the A/AAAA records point at the ALB."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route 53 zone that owns domain_name. The zone must already exist; Terraform does not create it, because a zone is a delegation someone did at a registrar."
  type        = string
}

# --- Network -----------------------------------------------------------------

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "The public subnets. The ALB spans them and the task runs in one of them."
  type        = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "task_security_group_id" {
  type = string
}

# --- Image -------------------------------------------------------------------

variable "image_repository_url" {
  description = "ECR repository URL from the bootstrap workspace."
  type        = string
}

variable "image_tag" {
  description = "The tag to run, e.g. sha-a1b2c3d. Set on the workspace by the deploy workflow; this is the one input that changes on a normal deploy."
  type        = string
}

# --- Task --------------------------------------------------------------------

variable "container_port" {
  type    = number
  default = 3000
}

variable "desired_count" {
  description = "0 or 1. Never more: the session state is in the process's memory, so a second task is a second, disagreeing truth. Staging sits at 0 between rehearsals."
  type        = number

  validation {
    condition     = var.desired_count == 0 || var.desired_count == 1
    error_message = "Quorum is a single-writer service. desired_count is 0 or 1."
  }
}

variable "task_cpu" {
  description = "Fargate CPU units. 512 = 0.5 vCPU."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate memory in MiB."
  type        = number
  default     = 1024
}

variable "log_level" {
  type    = string
  default = "info"
}

variable "log_retention_days" {
  description = "CloudWatch log retention. Long enough to investigate the event after the event."
  type        = number
  default     = 30
}

# --- Data ---------------------------------------------------------------------

variable "dynamodb_table_name" {
  type = string
}

variable "dynamodb_table_arn" {
  type = string
}

variable "admin_key_parameter_arn" {
  description = "SSM SecureString ARN. The execution role may read this one parameter; Terraform never reads it at all."
  type        = string
}

# --- Knobs --------------------------------------------------------------------

variable "alb_idle_timeout" {
  description = "Seconds. 3600, not the 60-second default: a participant whose phone is face-down through a twenty-minute holding segment must not be disconnected."
  type        = number
  default     = 3600
}

variable "alarm_actions" {
  description = "SNS topic ARNs for the RunningTaskCount alarm. Empty means the alarm exists and notifies nobody, which is still visible in the console."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
}
