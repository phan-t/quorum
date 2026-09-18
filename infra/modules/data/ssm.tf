# The admin key. Terraform creates the parameter; a human sets the value.
#
# The rule from ARCHITECTURE.md is that a secret's value never passes through
# Terraform. State is encrypted at rest in HCP Terraform, but plan output is
# visible to anyone who can see a run, and a secret in a variable is a secret in
# every plan from now on.
#
# So: create it with a placeholder, then ignore the value forever. The first
# apply produces a parameter the task can read and a key that does not work,
# which is the correct failure — the service refuses to create sessions until
# someone has deliberately set a real key:
#
#   aws ssm put-parameter --name /quorum/<env>/admin_key --type SecureString \
#     --value "$(openssl rand -base64 24)" --overwrite --region <region>
#
# Rotating it is the same command. The task picks it up on its next start,
# because ECS resolves `secrets` at task start and not after.

resource "aws_ssm_parameter" "admin_key" {
  name        = "/quorum/${var.environment}/admin_key"
  description = "Bearer key for POST /api/sessions. Set out of band; Terraform never sees the real value."
  type        = "SecureString"
  value       = "placeholder-set-me-with-the-cli"

  tags = merge(var.tags, { Name = "/quorum/${var.environment}/admin_key" })

  lifecycle {
    ignore_changes = [value]
  }
}
