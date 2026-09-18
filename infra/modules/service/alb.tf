# An ALB, not an NLB. WebSockets need a Layer 7 proxy that understands the
# Upgrade handshake; an NLB would pass TCP through and leave TLS termination on
# the task, which means the certificate and its renewal become the application's
# problem.

resource "aws_lb" "this" {
  name               = var.name_prefix
  load_balancer_type = "application"
  internal           = false
  subnets            = var.subnet_ids
  security_groups    = [var.alb_security_group_id]

  # The single most important number on this resource. The default is 60
  # seconds; a participant on the holding page sends nothing for twenty minutes
  # and would be silently disconnected, which looks to the room like the game
  # broke.
  idle_timeout = var.alb_idle_timeout

  # dualstack: participants are on mobile networks, some of which are IPv6-only.
  ip_address_type = "dualstack"

  enable_http2               = true
  drop_invalid_header_fields = true

  tags = merge(var.tags, { Name = var.name_prefix })
}

resource "aws_lb_target_group" "this" {
  name        = var.name_prefix
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  # There is one task and it holds every socket in the room. Draining it
  # gracefully would mean two tasks alive at once with different ideas of the
  # session state, which is worse than a clean gap — see ARCHITECTURE.md,
  # "Deploying around a live session". Five seconds is enough for in-flight HTTP
  # and short enough not to stretch the restart.
  deregistration_delay = 5

  health_check {
    enabled             = true
    path                = "/healthz"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Sticky sessions are deliberately off. With one task there is nothing to be
  # sticky to, and turning them on would hide the day a second task appears by
  # accident.

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, { Name = var.name_prefix })
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }

  tags = var.tags
}

# Someone will type the hostname without a scheme, and a phone camera scanning a
# QR code should not be the thing that discovers this.
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = var.tags
}
