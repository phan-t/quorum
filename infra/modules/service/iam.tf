# Two roles, and the split is the whole point.
#
# The execution role belongs to the ECS agent: it pulls the image, reads the
# admin key out of SSM and opens the log stream, all before the container
# starts. The task role belongs to the running process: it writes DynamoDB.
#
# The container therefore has no way to read SSM at runtime. It receives the
# admin key as an environment variable that the agent injected and cannot ask
# for another one.

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# --- execution role ----------------------------------------------------------

resource "aws_iam_role" "execution" {
  # quorum-* because the operator's own IAM permissions are scoped to that
  # prefix. A role named anything else fails the apply on CreateRole.
  name               = "${var.name_prefix}-task-execution"
  description        = "ECS agent: pull the image, read the admin key, open the log stream."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = merge(var.tags, { Name = "${var.name_prefix}-task-execution" })
}

# ECR pull and the CloudWatch log-group basics. AWS maintains it; hand-rolling
# the equivalent gains nothing and drifts.
resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadAdminKey"
    effect    = "Allow"
    actions   = ["ssm:GetParameters"]
    resources = [var.admin_key_parameter_arn]
  }

  # SecureString parameters are decrypted with the account's default SSM key, so
  # the agent needs kms:Decrypt against it. Scoped to requests that came via
  # SSM, so this grants nothing over anything else the key protects.
  statement {
    sid       = "DecryptAdminKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${var.name_prefix}-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# --- task role ---------------------------------------------------------------

resource "aws_iam_role" "task" {
  name               = "${var.name_prefix}-task"
  description        = "The Quorum process: one DynamoDB table, nothing else."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = merge(var.tags, { Name = "${var.name_prefix}-task" })
}

data "aws_iam_policy_document" "task" {
  statement {
    sid    = "OneTable"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      # Startup scans for sessions in lobby or running. The table holds a few
      # thousand small items, so a scan is the cheap correct answer and a GSI
      # would be a second thing to keep in step.
      "dynamodb:Scan",
      "dynamodb:DescribeTable",
    ]
    resources = [
      var.dynamodb_table_arn,
      "${var.dynamodb_table_arn}/index/*",
    ]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.name_prefix}-dynamodb"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}
