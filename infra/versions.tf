terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # CLI-driven workspace, remote execution. A human runs `make deploy` or
  # `make up`; HCP Terraform executes the apply. It is deliberately not
  # VCS-connected, and connecting it would break several things at once:
  #
  #   - The CLI uploads this whole directory, gitignored `terraform.tfvars`
  #     included, which is how aws_account_id, hosted_zone_id and domain_name
  #     reach the workers. A VCS run clones from GitHub, where that file does
  #     not exist, and fails before planning.
  #   - `image_tag` has no default on purpose, so a VCS run has no way to know
  #     which image to run.
  #   - `desired_count` defaults to 1, while parking at zero is a CLI override
  #     from `make down`. A VCS run would quietly raise a parked service.
  #   - Nothing in CI can build or push the image anyway: the account denies
  #     non-human credentials, so no automation can reach ECR.
  #   - The credentials here are an 8-hour doormat session pushed by
  #     `tfawscreds`. Any run not triggered by a human who just refreshed is a
  #     coin flip.
  #
  # `organization` is omitted on purpose — it comes from TF_CLOUD_ORGANIZATION,
  # so this public repo does not name someone's org.
  cloud {
    workspaces {
      name = "quorum"
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
