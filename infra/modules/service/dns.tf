# ACM, DNS-validated, plus the records that point the hostname at the ALB.
#
# DNS validation rather than email: the zone is already in this account, so the
# validation record is a resource like any other and renewal is automatic and
# silent. Email validation needs a human to click a link every renewal, which is
# a task nobody remembers in thirteen months.

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  tags = merge(var.tags, { Name = var.domain_name })

  # The certificate is an input to the listener. Replacing one in place would
  # take the listener down between destroy and create.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for dvo in aws_acm_certificate.this.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.hosted_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  # ACM leaves the old validation record behind on renewal; without this, a
  # re-apply after a renewal fails on an existing record it did not create.
  allow_overwrite = true
}

# Blocks the apply until the certificate is actually issued, so the listener is
# never created pointing at a PENDING_VALIDATION certificate.
resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.certificate_validation : r.fqdn]
}

# Alias records, not CNAMEs: an alias resolves to the ALB's current addresses,
# costs nothing to query, and works at the zone apex if this ever moves there.
resource "aws_route53_record" "a" {
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "aaaa" {
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = false
  }
}
