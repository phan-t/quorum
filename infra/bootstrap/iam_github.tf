# quorum-gha-ecr-push — assumed by the deploy workflow. It can push to one
# repository. It cannot read DynamoDB, touch ECS, or see the rest of the
# account, because the only thing Actions does with AWS is put an image
# somewhere Terraform can find it.

data "aws_iam_policy_document" "gha_assume" {
  statement {
    sid     = "GitHubActionsMainBranch"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Exact, not a wildcard. A pull request from a fork gets
    # `repo:<org>/<repo>:pull_request` and is refused, which is why the PR
    # workflow builds the image and does not push it.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "gha_ecr_push" {
  name                 = "quorum-gha-ecr-push"
  description          = "Assumed by GitHub Actions on main of ${var.github_repository}. Push to the ${var.ecr_repository_name} repository, nothing else."
  assume_role_policy   = data.aws_iam_policy_document.gha_assume.json
  max_session_duration = 3600

  tags = merge(local.tags, { Name = "quorum-gha-ecr-push" })
}

data "aws_iam_policy_document" "gha_ecr_push" {
  # GetAuthorizationToken has no resource to scope to — it is the registry-wide
  # login call and AWS only accepts "*". It returns a token whose usefulness is
  # bounded by the statement below.
  statement {
    sid       = "EcrLogin"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PushToQuorumRepositoryOnly"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      # Read-back: the build cache and the `docker buildx --cache-from` path
      # need to pull layers the previous build pushed.
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
    ]
    resources = [aws_ecr_repository.quorum.arn]
  }
}

resource "aws_iam_role_policy" "gha_ecr_push" {
  name   = "quorum-gha-ecr-push"
  role   = aws_iam_role.gha_ecr_push.id
  policy = data.aws_iam_policy_document.gha_ecr_push.json
}
