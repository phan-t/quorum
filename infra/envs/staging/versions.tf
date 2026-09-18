terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # VCS-driven workspace. A PR touching infra/** gets a speculative plan posted
  # as a status check; a merge to main queues a real run. `organization` is
  # omitted on purpose — it comes from TF_CLOUD_ORGANIZATION, so this public
  # repo does not name someone's org.
  cloud {
    workspaces {
      name = "quorum-staging"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Credentials are minted per run by HCP Terraform against quorum-tfc-run.
  # There is no access key here and no provider `assume_role` block: the run
  # already *is* the role. Set TFC_AWS_PROVIDER_AUTH and TFC_AWS_RUN_ROLE_ARN as
  # environment variables on the workspace and nothing else.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.tags
  }
}
