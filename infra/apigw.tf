# REST API imported from openapi/openapi.yaml: the spec, request validation and
# deployment cannot drift apart. Only the Lambda ARNs are filled in here.

locals {
  openapi = templatefile("${path.module}/../openapi/openapi.yaml", {
    fares_invoke_arn      = aws_lambda_alias.fares_live.invoke_arn
    seatmaps_invoke_arn   = module.seatmaps.invoke_arn
    holds_invoke_arn      = module.holds.invoke_arn
    tickets_invoke_arn    = module.tickets.invoke_arn
    authorizer_invoke_arn = module.authorizer.invoke_arn
  })
}

resource "aws_api_gateway_rest_api" "api" {
  name              = "${local.name}-reservation-gateway"
  body              = local.openapi
  put_rest_api_mode = "overwrite"
  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_deployment" "api" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  triggers = {
    spec = sha1(local.openapi)
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.name}-access"
  retention_in_days = var.log_retention_days
}

resource "aws_api_gateway_stage" "stage" {
  rest_api_id          = aws_api_gateway_rest_api.api.id
  deployment_id        = aws_api_gateway_deployment.api.id
  stage_name           = var.stage
  xray_tracing_enabled = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    # One JSON line per request; apiKeyId enables per-partner usage reports.
    format = jsonencode({
      requestId          = "$context.requestId"
      requestTime        = "$context.requestTimeEpoch"
      httpMethod         = "$context.httpMethod"
      resourcePath       = "$context.resourcePath"
      status             = "$context.status"
      responseLatency    = "$context.responseLatency"
      integrationLatency = "$context.integrationLatency"
      apiKeyId           = "$context.identity.apiKeyId"
      principalId        = "$context.authorizer.principalId"
      sourceIp           = "$context.identity.sourceIp"
      errorType          = "$context.error.responseType"
      xrayTraceId        = "$context.xrayTraceId"
    })
  }
  depends_on = [aws_api_gateway_account.this]
}

resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  stage_name  = aws_api_gateway_stage.stage.stage_name
  method_path = "*/*"
  settings {
    metrics_enabled        = false # detailed per-method metrics are billed; our EMF metrics cover routes
    logging_level          = "OFF"
    throttling_rate_limit  = 200 # stage-wide ceiling; per-partner limits come from usage plans
    throttling_burst_limit = 400
  }
}

# ------------------------------------------------------------ invoke permissions
resource "aws_lambda_permission" "apigw_fares" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = module.fares.function_name
  qualifier     = aws_lambda_alias.fares_live.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/GET/fares"
}

resource "aws_lambda_permission" "apigw_seatmaps" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = module.seatmaps.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/GET/seatmaps/*"
}

resource "aws_lambda_permission" "apigw_holds" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = module.holds.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/POST/holds"
}

resource "aws_lambda_permission" "apigw_tickets" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = module.tickets.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/*/tickets*"
}

resource "aws_lambda_permission" "apigw_authorizer" {
  statement_id  = "AllowApiGatewayAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = module.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/authorizers/*"
}

# ------------------------------------------------------------ usage plans & API keys
resource "aws_api_gateway_usage_plan" "plan" {
  for_each = var.usage_plans
  name     = "${local.name}-${each.key}"

  api_stages {
    api_id = aws_api_gateway_rest_api.api.id
    stage  = aws_api_gateway_stage.stage.stage_name
  }
  throttle_settings {
    rate_limit  = each.value.rate
    burst_limit = each.value.burst
  }
  quota_settings {
    limit  = each.value.quota_per_day
    period = "DAY"
  }
}

resource "aws_api_gateway_api_key" "partner" {
  for_each = var.usage_plans
  name     = "${local.name}-${each.key}"
}

resource "aws_api_gateway_usage_plan_key" "partner" {
  for_each      = var.usage_plans
  key_id        = aws_api_gateway_api_key.partner[each.key].id
  key_type      = "API_KEY"
  usage_plan_id = aws_api_gateway_usage_plan.plan[each.key].id
}

# ------------------------------------------------------------ account-level CloudWatch role (access logs)
data "aws_iam_policy_document" "apigw_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apigw_cloudwatch" {
  name               = "${local.name}-apigw-cloudwatch"
  assume_role_policy = data.aws_iam_policy_document.apigw_assume.json
}

resource "aws_iam_role_policy_attachment" "apigw_cloudwatch" {
  role       = aws_iam_role.apigw_cloudwatch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "this" {
  cloudwatch_role_arn = aws_iam_role.apigw_cloudwatch.arn
  depends_on          = [aws_iam_role_policy_attachment.apigw_cloudwatch]
}
