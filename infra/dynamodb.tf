# On-demand tables: pennies at test volumes, and no throttling during the fare-feed load.

# Read-through cache entries, refresh locks, shared circuit-breaker flag.
resource "aws_dynamodb_table" "cache" {
  name         = "${local.name}-cache"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  attribute {
    name = "pk"
    type = "S"
  }
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# Idempotency records and ticketing job status.
resource "aws_dynamodb_table" "state" {
  name         = "${local.name}-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  attribute {
    name = "pk"
    type = "S"
  }
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# Modern fare service (strangler fig v2), loaded from the nightly FAREDUMP.
resource "aws_dynamodb_table" "fares" {
  name         = "${local.name}-fares"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  attribute {
    name = "pk"
    type = "S"
  }
}

# The simulated legacy host's own "database".
resource "aws_dynamodb_table" "legacy" {
  name         = "${local.name}-legacy-host"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}
