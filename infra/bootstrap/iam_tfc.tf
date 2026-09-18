# quorum-tfc-run — the role every HCP Terraform run in this project assumes.

data "aws_iam_policy_document" "tfc_run_assume" {
  statement {
    sid     = "HcpTerraformDynamicCredentials"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.hcp_terraform.arn]
    }

    # The audience HCP Terraform requests by default. Left unset in the
    # workspace, this is what the token carries.
    condition {
      test     = "StringEquals"
      variable = "app.terraform.io:aud"
      values   = ["aws.workload.identity"]
    }

    # organization:<org>:project:<project>:workspace:quorum-*:run_phase:*
    #
    # The wildcard is on the workspace name and the run phase only. Organization
    # and project are exact, so a workspace in someone else's org called
    # quorum-prod gets nothing.
    #
    # When a read-only plan role is wanted, this splits into two roles with
    # run_phase:plan and run_phase:apply in place of the trailing wildcard. The
    # mechanism does not change, which is why it is not worth doing yet.
    condition {
      test     = "StringLike"
      variable = "app.terraform.io:sub"
      values = [
        "organization:${var.tfc_organization}:project:${var.tfc_project}:workspace:quorum-*:run_phase:*",
      ]
    }
  }
}

resource "aws_iam_role" "tfc_run" {
  name                 = "quorum-tfc-run"
  description          = "Assumed by HCP Terraform runs in the ${var.tfc_project} project. Dynamic credentials only; no access key exists."
  assume_role_policy   = data.aws_iam_policy_document.tfc_run_assume.json
  max_session_duration = 3600

  tags = merge(local.tags, { Name = "quorum-tfc-run" })
}

# This role manages a VPC, an ALB, ECS, DynamoDB, ACM, Route 53, SSM and
# CloudWatch. An allow-list of exactly those API calls is a policy that has to
# be edited every time a resource gains an argument, and the failure mode is a
# half-applied environment at the moment you least want one.
#
# PowerUserAccess is the honest compromise: everything except IAM. The IAM
# permissions the environments genuinely need — the two task roles — are granted
# separately below and scoped by name prefix, so this role cannot mint itself
# more privilege or touch a role belonging to anything else in the account.
resource "aws_iam_role_policy_attachment" "tfc_run_power_user" {
  role       = aws_iam_role.tfc_run.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "tfc_run_iam" {
  # The task and task-execution roles for each environment, and nothing else.
  statement {
    sid    = "ManageQuorumServiceRoles"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRoleTags",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/quorum-*",
    ]
  }

  # ECS hands the task its roles at task start; without PassRole the service
  # creates and then cannot launch.
  statement {
    sid     = "PassQuorumServiceRolesToEcs"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/quorum-*",
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # ECS and ELB each want their service-linked role to exist on first use.
  statement {
    sid     = "CreateServiceLinkedRoles"
    effect  = "Allow"
    actions = ["iam:CreateServiceLinkedRole"]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/aws-service-role/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values = [
        "ecs.amazonaws.com",
        "elasticloadbalancing.amazonaws.com",
      ]
    }
  }

  # The bootstrap layer is not the environments' to change. Without this, a
  # compromised or simply mistaken env run could rewrite the trust policy that
  # governs it — which is the one escalation path PowerUserAccess leaves open.
  statement {
    sid    = "DenyTouchingBootstrap"
    effect = "Deny"
    actions = [
      "iam:*OpenIDConnectProvider*",
      "iam:UpdateAssumeRolePolicy",
      "iam:DeleteRole",
      "iam:AttachRolePolicy",
      "iam:PutRolePolicy",
    ]
    resources = [
      aws_iam_role.tfc_run.arn,
      aws_iam_role.gha_ecr_push.arn,
      aws_iam_openid_connect_provider.hcp_terraform.arn,
      aws_iam_openid_connect_provider.github_actions.arn,
    ]
  }
}

resource "aws_iam_role_policy" "tfc_run_iam" {
  name   = "quorum-tfc-run-iam"
  role   = aws_iam_role.tfc_run.id
  policy = data.aws_iam_policy_document.tfc_run_iam.json
}
