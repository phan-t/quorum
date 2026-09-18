variable "name_prefix" {
  description = "Prefix for resource names, e.g. quorum-staging."
  type        = string
}

variable "environment" {
  description = "staging or prod. Also the middle path segment of the SSM parameter."
  type        = string
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
}
