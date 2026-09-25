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
  #   - The credentials this workspace runs with are an 8-hour doormat session
  #     pushed into a variable set by `tfawscreds`. Any run not triggered by a
  #     human who just refreshed is a coin flip.
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

  # No credentials here, and no `assume_role` block either — but not because the
  # run federates an identity. It cannot: this account denies
  # iam:CreateOpenIDConnectProvider, so HCP Terraform's dynamic credentials are
  # not available and TFC_AWS_PROVIDER_AUTH would have nothing to authenticate
  # against.
  #
  # What the workers actually get is a copy of the operator's own eight-hour STS
  # session, pushed into the AWS Authentication variable set by `tfawscreds`
  # before every apply. The comment on the `cloud` block above says the same
  # thing; this one used to claim a per-run role instead, which is the design
  # that was wanted and not the one that runs.
  #
  # `allowed_account_ids` is therefore doing real work: the credentials are a
  # human's, that human has access to more than this account, and a wrong
  # AWS_PROFILE at the moment `tfawscreds` ran is a plausible mistake. It fails
  # the plan instead of applying somewhere else.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.tags
  }
}
