terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # CLI-driven: this workspace is applied from a laptop by a human with their
  # own AWS credentials, because it creates the roles every other workspace
  # authenticates with. State still lives in HCP Terraform — the execution mode
  # is a workspace setting, not a property of this block.
  #
  # `organization` is deliberately absent: it is an input nobody should hardcode
  # in a public repo. Export TF_CLOUD_ORGANIZATION before `terraform init`.
  cloud {
    workspaces {
      name = "quorum-bootstrap"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # A wrong-account apply here creates IAM roles someone has to hunt for later.
  # Cheap insurance.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.tags
  }
}
