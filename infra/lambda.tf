locals {
  dist     = "${path.module}/../dist"
  bulkhead = coalesce(var.bulkhead_concurrency, { fares = -1, seatmaps = -1, holds = -1, ticket_worker = -1 })

  gateway_env = {
    POWERTOOLS_SERVICE_NAME  = local.service
    METRICS_NAMESPACE        = local.metrics
    LOG_LEVEL                = "INFO"
    LEGACY_ENDPOINT          = "${aws_lambda_function_url.legacy.function_url}reslink"
    LEGACY_CREDENTIALS_PARAM = aws_ssm_parameter.legacy_credentials.name
    CACHE_TABLE              = aws_dynamodb_table.cache.name
    STATE_TABLE              = aws_dynamodb_table.state.name
    FARES_TABLE              = aws_dynamodb_table.fares.name
    ALLOW_EXPERIMENT_HEADERS = tostring(var.allow_experiment_headers)
  }
  fn_arn_prefix = "arn:aws:lambda:${local.region}:${local.account}:function"
}

# ------------------------------------------------------------ shared policy pieces
data "aws_iam_policy_document" "legacy_caller" {
  # Credentials for the legacy host (SecureString, AWS-managed key).
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.legacy_credentials.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.region}.amazonaws.com"]
    }
  }
  # Cache entries, refresh locks, the shared circuit-breaker flag and the rate-limit window.
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.cache.arn]
  }
}

# ------------------------------------------------------------ GET /fares (strangler-fig aliased)
data "aws_iam_policy_document" "fares" {
  source_policy_documents = [data.aws_iam_policy_document.legacy_caller.json]
  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.fares.arn]
  }
  # Background revalidation = async self-invoke of the same version.
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = ["${local.fn_arn_prefix}:${local.name}-fares", "${local.fn_arn_prefix}:${local.name}-fares:*"]
  }
}

module "fares" {
  source               = "./modules/function"
  name                 = "${local.name}-fares"
  source_dir           = "${local.dist}/fares"
  timeout              = 8
  publish              = true
  reserved_concurrency = local.bulkhead.fares
  log_retention_days   = var.log_retention_days
  policy_json          = data.aws_iam_policy_document.fares.json
  environment = merge(local.gateway_env, {
    FARE_MODE                 = var.fare_mode_baseline
    MODERN_FARE_RULES         = var.modern_fare_rules
    MODERN_VERIFY_SAMPLE_RATE = "0.1"
  })
}

# The "live" alias is what API Gateway invokes. scripts/canary.ts shifts its
# weights between versions (10% -> 50% -> 100%), so Terraform ignores them.
resource "aws_lambda_alias" "fares_live" {
  name             = "live"
  function_name    = module.fares.function_name
  function_version = module.fares.version
  lifecycle {
    ignore_changes = [function_version, routing_config]
  }
}

# ------------------------------------------------------------ GET /seatmaps
data "aws_iam_policy_document" "seatmaps" {
  source_policy_documents = [data.aws_iam_policy_document.legacy_caller.json]
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = ["${local.fn_arn_prefix}:${local.name}-seatmaps", "${local.fn_arn_prefix}:${local.name}-seatmaps:*"]
  }
}

module "seatmaps" {
  source               = "./modules/function"
  name                 = "${local.name}-seatmaps"
  source_dir           = "${local.dist}/seatmaps"
  timeout              = 8
  reserved_concurrency = local.bulkhead.seatmaps
  log_retention_days   = var.log_retention_days
  policy_json          = data.aws_iam_policy_document.seatmaps.json
  environment          = local.gateway_env
}

# ------------------------------------------------------------ POST /holds
data "aws_iam_policy_document" "holds" {
  source_policy_documents = [data.aws_iam_policy_document.legacy_caller.json]
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.state.arn]
  }
}

module "holds" {
  source               = "./modules/function"
  name                 = "${local.name}-holds"
  source_dir           = "${local.dist}/holds"
  timeout              = 10
  reserved_concurrency = local.bulkhead.holds
  log_retention_days   = var.log_retention_days
  policy_json          = data.aws_iam_policy_document.holds.json
  environment          = local.gateway_env
}

# ------------------------------------------------------------ POST /tickets, GET /tickets/{id}
data "aws_iam_policy_document" "tickets" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.state.arn]
  }
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.ticketing.arn]
  }
}

module "tickets" {
  source             = "./modules/function"
  name               = "${local.name}-tickets"
  source_dir         = "${local.dist}/tickets"
  timeout            = 10
  log_retention_days = var.log_retention_days
  policy_json        = data.aws_iam_policy_document.tickets.json
  environment        = merge(local.gateway_env, { STATE_MACHINE_ARN = aws_sfn_state_machine.ticketing.arn })
}

# ------------------------------------------------------------ Step Functions task worker
data "aws_iam_policy_document" "ticket_worker" {
  source_policy_documents = [data.aws_iam_policy_document.legacy_caller.json]
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.state.arn]
  }
}

module "ticket_worker" {
  source               = "./modules/function"
  name                 = "${local.name}-ticket-worker"
  source_dir           = "${local.dist}/ticket-worker"
  timeout              = 35
  reserved_concurrency = local.bulkhead.ticket_worker
  log_retention_days   = var.log_retention_days
  policy_json          = data.aws_iam_policy_document.ticket_worker.json
  environment          = local.gateway_env
}

# ------------------------------------------------------------ JWT authorizer
data "aws_iam_policy_document" "authorizer" {
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.jwt_public_key.arn]
  }
}

module "authorizer" {
  source             = "./modules/function"
  name               = "${local.name}-authorizer"
  source_dir         = "${local.dist}/authorizer"
  timeout            = 5
  memory             = 256
  log_retention_days = var.log_retention_days
  policy_json        = data.aws_iam_policy_document.authorizer.json
  environment = {
    POWERTOOLS_SERVICE_NAME = local.service
    AUTH_PUBLIC_KEY_PARAM   = aws_ssm_parameter.jwt_public_key.name
  }
}

# ------------------------------------------------------------ FAREDUMP loader (S3 -> fares table)
data "aws_iam_policy_document" "fare_loader" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.exports.arn}/exports/*"]
  }
  statement {
    actions   = ["dynamodb:BatchWriteItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.fares.arn]
  }
}

module "fare_loader" {
  source             = "./modules/function"
  name               = "${local.name}-fare-loader"
  source_dir         = "${local.dist}/fare-loader"
  timeout            = 300
  memory             = 1024
  log_retention_days = var.log_retention_days
  policy_json        = data.aws_iam_policy_document.fare_loader.json
  environment = {
    POWERTOOLS_SERVICE_NAME = local.service
    METRICS_NAMESPACE       = local.metrics
    FARES_TABLE             = aws_dynamodb_table.fares.name
  }
}

resource "aws_lambda_permission" "s3_invoke_loader" {
  statement_id  = "AllowS3"
  action        = "lambda:InvokeFunction"
  function_name = module.fare_loader.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.exports.arn
}
