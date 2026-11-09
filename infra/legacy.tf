# The simulated RESLINK/2 legacy host: a Lambda behind a Function URL (SOAP over
# HTTPS), its own DynamoDB "database", and a nightly FAREDUMP export job.

data "aws_iam_policy_document" "legacy" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.legacy.arn]
  }
}

module "legacy" {
  source             = "./modules/function"
  name               = "${local.name}-legacy-host"
  source_dir         = "${local.dist}/legacy"
  timeout            = 40 # IssueTicket takes up to 20 s, plus an occasional 10 s hang
  log_retention_days = var.log_retention_days
  policy_json        = data.aws_iam_policy_document.legacy.json
  environment = {
    LEGACY_TABLE          = aws_dynamodb_table.legacy.name
    LEGACY_USER           = "GATEWAY"
    LEGACY_PASSWORD       = random_password.legacy.result
    LEGACY_ADMIN_TOKEN    = random_password.legacy_admin.result
    LEGACY_LATENCY_MIN_MS = tostring(var.legacy_faults.latency_min_ms)
    LEGACY_LATENCY_MAX_MS = tostring(var.legacy_faults.latency_max_ms)
    LEGACY_ERROR_RATE     = tostring(var.legacy_faults.error_rate)
    LEGACY_HANG_RATE      = tostring(var.legacy_faults.hang_rate)
    LEGACY_HANG_MS        = tostring(var.legacy_faults.hang_ms)
    LEGACY_RATE_LIMIT_RPS = tostring(var.legacy_faults.rate_limit_rps)
    LEGACY_TICKET_MIN_MS  = tostring(var.legacy_faults.ticket_min_ms)
    LEGACY_TICKET_MAX_MS  = tostring(var.legacy_faults.ticket_max_ms)
    LEGACY_REFILE_RATE    = tostring(var.legacy_faults.refile_rate)
  }
}

resource "aws_lambda_function_url" "legacy" {
  function_name      = module.legacy.function_name
  authorization_type = "NONE" # SOAP AuthHeader credentials are checked by the host itself
  invoke_mode        = "BUFFERED"
}

# Public Function URLs need both permissions (since October 2025).
resource "aws_lambda_permission" "legacy_url" {
  statement_id           = "FunctionUrlPublic"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = module.legacy.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "legacy_url_invoke" {
  statement_id             = "FunctionUrlInvoke"
  action                   = "lambda:InvokeFunction"
  function_name            = module.legacy.function_name
  principal                = "*"
  invoked_via_function_url = true
}

# ------------------------------------------------------------ nightly FAREDUMP
data "aws_iam_policy_document" "legacy_export" {
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.exports.arn}/exports/*"]
  }
}

module "legacy_export" {
  source             = "./modules/function"
  name               = "${local.name}-legacy-faredump"
  source_dir         = "${local.dist}/legacy"
  handler            = "index.exportHandler"
  timeout            = 60
  log_retention_days = var.log_retention_days
  policy_json        = data.aws_iam_policy_document.legacy_export.json
  environment = {
    EXPORT_BUCKET = aws_s3_bucket.exports.bucket
    EXPORT_DAYS   = "120"
  }
}

resource "aws_cloudwatch_event_rule" "nightly_faredump" {
  name                = "${local.name}-nightly-faredump"
  description         = "Legacy host nightly fare export (03:00 Toronto)"
  schedule_expression = "cron(0 7 * * ? *)"
}

resource "aws_cloudwatch_event_target" "nightly_faredump" {
  rule = aws_cloudwatch_event_rule.nightly_faredump.name
  arn  = "${local.fn_arn_prefix}:${module.legacy_export.function_name}"
}

resource "aws_lambda_permission" "events_invoke_export" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = module.legacy_export.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.nightly_faredump.arn
}

# Seed the modern fares table right after the first deploy instead of waiting for 03:00.
resource "aws_lambda_invocation" "seed_faredump" {
  function_name = module.legacy_export.function_name
  input         = jsonencode({ days = 120 })
  depends_on    = [aws_s3_bucket_notification.exports, aws_lambda_permission.s3_invoke_loader]
}
