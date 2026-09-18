resource "aws_ecs_cluster" "this" {
  name = var.name_prefix

  setting {
    name = "containerInsights"
    # Standard, not enhanced: the only metric this needs is RunningTaskCount,
    # and enhanced is priced per task per metric for observability nobody here
    # is going to read.
    value = "enabled"
  }

  tags = merge(var.tags, { Name = var.name_prefix })
}

# Fargate only. There is no EC2 capacity provider because there is no reason to
# own an instance for one 0.5 vCPU task.
resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name_prefix
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name = "quorum"

      # The image tag is a Terraform variable, which is the deploy decision in
      # ARCHITECTURE.md: Actions pushes the image and sets the variable,
      # Terraform is the only thing that ever writes an ECS resource. There is
      # no `ignore_changes = [task_definition]` on the service below, and there
      # is exactly one renderer of this task definition — this block.
      image = "${var.image_repository_url}:${var.image_tag}"

      essential = true

      portMappings = [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        },
      ]

      # Non-secret configuration, set here because Terraform is what knows the
      # values.
      environment = [
        { name = "QUORUM_ENV", value = var.environment },
        { name = "QUORUM_TABLE", value = var.dynamodb_table_name },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "LOG_LEVEL", value = var.log_level },
        { name = "PORT", value = tostring(var.container_port) },
        # So /healthz can report which build is answering, which is what the
        # deploy workflow asserts against after a staging release.
        { name = "QUORUM_VERSION", value = var.image_tag },
      ]

      # The secret. The ECS agent resolves this at task start using the
      # execution role; the value never enters Terraform, its state, or a plan.
      secrets = [
        {
          name      = "QUORUM_ADMIN_KEY"
          valueFrom = var.admin_key_parameter_arn
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "quorum"
        }
      }

      # Belt and braces with the ALB health check. This one catches a process
      # that is wedged rather than gone, and ECS replaces the task; the ALB
      # would only stop routing to it, and with one task that is the same as
      # down.
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${var.container_port}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 15
      }

      # SIGTERM, then 30 seconds to write final snapshots and close every socket
      # with 1012 Service Restart before SIGKILL. The clients reconnect with
      # backoff and their rejoin tokens; see "Durability and restart".
      stopTimeout = 30
    },
  ])

  tags = merge(var.tags, { Name = var.name_prefix })
}

resource "aws_ecs_service" "this" {
  name            = var.name_prefix
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # Stop the old task, then start the new one. Never both.
  #
  # The default (100/200) overlaps deployments, which for a stateless service is
  # the point and for this one is a bug: the second task starts with an empty
  # memory and the ALB immediately gives it new sockets, so half the room is
  # talking to a process that has never heard of the session. 0/100 makes a
  # deploy an honest stop-then-start — about twenty seconds of reconnect banner,
  # and one truth throughout.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  # Rolls back automatically if the new task never passes its health check,
  # which is the difference between a twenty-second gap and an outage lasting
  # until someone notices.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [var.task_security_group_id]
    # Required: the task reaches ECR, DynamoDB and CloudWatch through the
    # internet gateway because there is no NAT gateway. Inbound is still ALB
    # only — see the security group in the network module.
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = "quorum"
    container_port   = var.container_port
  }

  # The process replays snapshots and re-arms timers on start. Sixty seconds is
  # generous for a table this size and stops ECS killing a task that is busy
  # recovering a session.
  health_check_grace_period_seconds = 60

  # Without this, the service can be created before the listener exists and ECS
  # fails to register the target.
  depends_on = [
    aws_lb_listener.https,
    aws_iam_role_policy.execution_secrets,
  ]

  tags = merge(var.tags, { Name = var.name_prefix })
}
