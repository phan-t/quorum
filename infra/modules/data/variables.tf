variable "name_prefix" {
  description = "Prefix for resource names. The root passes \"quorum\"."
  type        = string
}

variable "environment" {
  description = "The middle path segment of the SSM parameter: /quorum/<environment>/admin_key. There is one environment and the root passes \"prod\"."
  type        = string
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
}
