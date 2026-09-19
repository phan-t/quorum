# One environment, one workspace. There was a second workspace for the registry
# and the OIDC providers; the providers are gone, and a registry alone did not
# justify a second apply, a second variable set and a cross-workspace lookup.
#
# The trade that bought: `terraform destroy` now takes the ECR images with it,
# so a rebuild-and-push precedes the next apply. Given the service is parked at
# zero rather than destroyed, that is a cost that rarely comes due.
locals {
  name_prefix = "quorum"
  # The modules take this for naming, tagging and log retention. There is only
  # one of them now, and it is the real one.
  environment = "prod"

  tags = merge(
    {
      Project   = "quorum"
      ManagedBy = "terraform"
      Workspace = "quorum"
    },
    var.additional_tags,
  )
}

module "network" {
  source = "./modules/network"

  name_prefix = local.name_prefix
  vpc_cidr    = var.vpc_cidr
  tags        = local.tags
}

module "data" {
  source = "./modules/data"

  name_prefix = local.name_prefix
  environment = local.environment
  tags        = local.tags
}

module "service" {
  source = "./modules/service"

  name_prefix = local.name_prefix
  environment = local.environment
  aws_region  = var.aws_region

  domain_name    = var.domain_name
  hosted_zone_id = var.hosted_zone_id

  vpc_id                 = module.network.vpc_id
  subnet_ids             = module.network.public_subnet_ids
  alb_security_group_id  = module.network.alb_security_group_id
  task_security_group_id = module.network.task_security_group_id

  image_repository_url = aws_ecr_repository.quorum.repository_url
  image_tag            = var.image_tag

  desired_count      = var.desired_count
  task_cpu           = var.task_cpu
  task_memory        = var.task_memory
  log_level          = var.log_level
  log_retention_days = var.log_retention_days

  dynamodb_table_name     = module.data.table_name
  dynamodb_table_arn      = module.data.table_arn
  admin_key_parameter_arn = module.data.admin_key_parameter_arn

  alarm_actions = var.alarm_actions
  tags          = local.tags
}
