# Two groups. The ALB's is open to the internet on the two ports a browser uses.
# The task's is open to exactly one thing: the ALB's group.

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Internet to the Quorum load balancer, HTTP and HTTPS only."
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name_prefix}-alb" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere. This is a public quiz; participants arrive on hotel wifi and mobile networks."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from anywhere, for the redirect to HTTPS. Someone will type the hostname without a scheme."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

# The AAAA record means a browser may arrive over IPv6, and a security group
# that only allows IPv4 would let DNS hand out an address that then refuses the
# connection — the worst kind of outage, because it works for most people.
resource "aws_vpc_security_group_ingress_rule" "alb_https_v6" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere, IPv6."
  cidr_ipv6         = "::/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_v6" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from anywhere, IPv6, for the redirect."
  cidr_ipv6         = "::/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the task, on the container port only."
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
}

# The group that makes a public subnet acceptable.
resource "aws_security_group" "tasks" {
  name        = "${var.name_prefix}-tasks"
  description = "Quorum task. Inbound from the ALB security group and nothing else, despite the public IP."
  vpc_id      = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name_prefix}-tasks" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id = aws_security_group.tasks.id
  # No apostrophe, and no quotes: AWS restricts rule descriptions to
  # a-zA-Z0-9 and . _-:/()#,@[]+=&;{}!$* — an apostrophe fails the apply with
  # InvalidParameterValue, which reads like a permissions problem.
  description                  = "The ALB, by security group rather than by CIDR. ALB addresses change and a CIDR rule would drift into either a hole or an outage."
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  description       = "Outbound to DynamoDB, ECR, CloudWatch and SSM over the internet gateway. Narrowing this to AWS prefix lists is possible and buys little while the alternative route is a NAT gateway that does not exist."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "tasks_all_v6" {
  security_group_id = aws_security_group.tasks.id
  description       = "The same, IPv6."
  cidr_ipv6         = "::/0"
  ip_protocol       = "-1"
}
