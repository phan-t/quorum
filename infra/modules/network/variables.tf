variable "name_prefix" {
  description = "Prefix for every resource name, e.g. quorum-staging."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR for the VPC. /20 is more address space than one task will ever need; it costs nothing and leaves room."
  type        = string
  default     = "10.40.0.0/20"
}

variable "container_port" {
  description = "Port the task listens on. The ALB is the only thing allowed to reach it."
  type        = number
  default     = 3000
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
}
