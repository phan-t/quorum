# The two identity providers. Everything in this repo that touches AWS
# authenticates through one of them; there is no IAM user and no access key.
#
# Neither sets `thumbprint_list`. AWS verifies both of these issuers against its
# own trusted CA store and no longer uses the thumbprint; pinning one would only
# create an outage the day the issuer rotates its certificate chain — which has
# already happened to GitHub twice. AWS still returns *a* thumbprint on read, so
# each resource ignores subsequent changes to it rather than proposing a diff on
# every plan forever.

# HCP Terraform runs assume quorum-tfc-run with a token minted per run.
resource "aws_iam_openid_connect_provider" "hcp_terraform" {
  url            = "https://app.terraform.io"
  client_id_list = ["aws.workload.identity"]

  tags = merge(local.tags, { Name = "app.terraform.io" })

  lifecycle {
    ignore_changes = [thumbprint_list]
  }
}

# GitHub Actions assumes quorum-gha-ecr-push, and nothing else.
resource "aws_iam_openid_connect_provider" "github_actions" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  tags = merge(local.tags, { Name = "token.actions.githubusercontent.com" })

  lifecycle {
    ignore_changes = [thumbprint_list]
  }
}
