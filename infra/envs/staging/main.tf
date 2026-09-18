locals {
  environment = "staging"
  name_prefix = "quorum-staging"

  tags = merge(
    {
      Project     = "quorum"
      Environment = local.environment
      ManagedBy   = "terraform"
      Workspace   = "quorum-staging"
    },
    var.additional_tags,
  )
}

# Created once by infra/bootstrap, shared by both environments. One repository,
# because staging and prod run the same image and promoting a tag beats
# rebuilding it and hoping the result is identical.
data "aws_ecr_repository" "quorum" {
  name = var.ecr_repository_name
}

module "network" {
  source = "../../modules/network"

  name_prefix = local.name_prefix
  vpc_cidr    = var.vpc_cidr
  tags        = local.tags
}

module "data" {
  source = "../../modules/data"

  name_prefix = local.name_prefix
  environment = local.environment
  tags        = local.tags
}

module "service" {
  source = "../../modules/service"

  name_prefix = local.name_prefix
  environment = local.environment
  aws_region  = var.aws_region

  domain_name    = var.domain_name
  hosted_zone_id = var.hosted_zone_id

  vpc_id                 = module.network.vpc_id
  subnet_ids             = module.network.public_subnet_ids
  alb_security_group_id  = module.network.alb_security_group_id
  task_security_group_id = module.network.task_security_group_id

  image_repository_url = data.aws_ecr_repository.quorum.repository_url
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
