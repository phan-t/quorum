# Two public subnets across two availability zones, an internet gateway, and no
# NAT gateway.
#
# The task needs outbound access to DynamoDB, ECR and CloudWatch. The textbook
# answer is a private subnet plus a NAT gateway, which is about US$45 a month —
# more than the Fargate task, the ALB fixed cost aside — to run a service that
# is idle most of the month. VPC endpoints instead of NAT are the other textbook
# answer and cost roughly the same once you need three of them.
#
# So the task sits in a public subnet with a public IP and a security group that
# accepts nothing except the ALB's security group. An unsolicited packet from
# the internet reaches the same place it would in a private subnet: nowhere. The
# exposure is equivalent; the bill is a third.
#
# The honest caveat: this relies on a security group being right, where a
# private subnet would also rely on a route table being right. One control
# instead of two. For a service with no inbound surface but one HTTP port that
# is a trade worth making, and it is the sort of thing to revisit if this ever
# holds data that is not a quiz score.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  # Two AZs. The service runs one task, so this is not high availability — it is
  # so that the ALB has the two subnets it requires, and so that a single AZ
  # event is a restart elsewhere rather than an outage until someone notices.
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  # IPv6 because the ALB is dualstack and the Route 53 record set includes an
  # AAAA. Some mobile networks participants arrive on are IPv6-only, and an ALB
  # cannot be dualstack unless its subnets carry an IPv6 range.
  assign_generated_ipv6_cidr_block = true

  tags = merge(var.tags, { Name = var.name_prefix })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, { Name = var.name_prefix })
}

resource "aws_subnet" "public" {
  for_each = { for i, az in local.azs : az => i }

  vpc_id = aws_vpc.this.id
  # /24 out of the /20: 251 usable addresses per subnet, which is 250 more than
  # this needs and leaves the rest of the range free.
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, each.value)
  availability_zone = each.key

  # /64 out of the VPC's /56, which is the only size AWS accepts.
  ipv6_cidr_block = cidrsubnet(aws_vpc.this.ipv6_cidr_block, 8, each.value)

  # The task needs a routable address to reach ECR and DynamoDB without a NAT
  # gateway. The ECS service sets this per-task as well; setting it here means a
  # task launched by hand behaves the same way.
  map_public_ip_on_launch         = true
  assign_ipv6_address_on_creation = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-public-${each.key}"
    Tier = "public"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${var.name_prefix}-public" })
}

resource "aws_route" "default_ipv4" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

# The internet gateway handles IPv6 in both directions, so there is no
# egress-only gateway here and nothing to pay for.
resource "aws_route" "default_ipv6" {
  route_table_id              = aws_route_table.public.id
  destination_ipv6_cidr_block = "::/0"
  gateway_id                  = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}
