# One table, single-table design, on-demand.
#
# PK/SK only, no GSI: every read is either a query on SESSION#<sid> or a get on
# CODE#<joinCode>, and both are the partition key. See ARCHITECTURE.md's data
# model table for the item shapes.

resource "aws_dynamodb_table" "quorum" {
  name = var.name_prefix

  # On-demand, not provisioned. The traffic is two hours of writes a few times a
  # year and nothing in between. Provisioned capacity for that shape means
  # paying for idle throughput or throttling the one afternoon it matters.
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "PK"
  range_key = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  # Nicknames are the only personal data in here and there is no reason to keep
  # them past the next event's planning. The application writes `ttl` as 90 days
  # from session close.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  # A scoring dispute is settled from the event log. Losing the table to a bad
  # deploy the week after an event is the case this covers, and at this data
  # volume it rounds to free.
  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = merge(var.tags, { Name = var.name_prefix })
}
