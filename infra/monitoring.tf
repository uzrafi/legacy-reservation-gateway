locals {
  svc_dim  = { service = local.service }
  api_dims = { ApiName = aws_api_gateway_rest_api.api.name, Stage = var.stage }
  routes   = ["GET /fares", "GET /seatmaps", "POST /holds", "tickets"]
}

resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# ------------------------------------------------------------ alarms
resource "aws_cloudwatch_metric_alarm" "circuit_open" {
  alarm_name          = "${local.name}-legacy-circuit-open-5min"
  alarm_description   = "The legacy circuit breaker has been rejecting calls for 5 minutes."
  namespace           = local.metrics
  metric_name         = "CircuitOpenRejections"
  dimensions          = local.svc_dim
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx-over-1pct"
  alarm_description   = "More than 1% of API responses are 5xx. Also a canary rollback trigger."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5XXError"
  dimensions          = local.api_dims
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 0.01
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "shadow_mismatch" {
  alarm_name          = "${local.name}-fare-shadow-mismatch-over-0.1pct"
  alarm_description   = "Modern fares disagree with legacy on more than 0.1% of compared quotes. Canary rollback trigger."
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 0.1
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "rate"
    expression  = "IF(compared >= 100, 100 * mismatched / compared, 0)"
    label       = "Mismatch %"
    return_data = true
  }
  metric_query {
    id = "compared"
    metric {
      namespace   = local.metrics
      metric_name = "FareShadowCompared"
      dimensions  = local.svc_dim
      stat        = "Sum"
      period      = 300
    }
  }
  metric_query {
    id = "mismatched"
    metric {
      namespace   = local.metrics
      metric_name = "FareShadowMismatch"
      dimensions  = local.svc_dim
      stat        = "Sum"
      period      = 300
    }
  }
}

# ------------------------------------------------------------ throttles per partner (from access logs)
resource "aws_cloudwatch_log_metric_filter" "throttled" {
  name           = "${local.name}-throttled-by-key"
  log_group_name = aws_cloudwatch_log_group.api_access.name
  pattern        = "{ $.status = \"429\" }"
  metric_transformation {
    name       = "Throttled429"
    namespace  = local.metrics
    value      = "1"
    unit       = "Count"
    dimensions = { apiKeyId = "$.apiKeyId" }
  }
}

# ------------------------------------------------------------ dashboard
locals {
  m = local.metrics
  s = local.service
  dashboard = {
    widgets = [
      {
        type = "text", x = 0, y = 0, width = 24, height = 2
        properties = { markdown = "# Legacy Reservation Gateway (${var.stage})\nREST facade over the RESLINK/2 SOAP host. Cache, circuit breaker, async ticketing, strangler-fig fares." }
      },
      {
        type = "metric", x = 0, y = 2, width = 12, height = 6
        properties = {
          title = "Gateway latency by route (p50 / p95 / p99, ms)", view = "timeSeries", region = local.region, period = 60
          metrics = flatten([for r in local.routes : [
            [local.m, "RequestLatencyMs", "service", local.s, "route", r, { stat = "p50", label = "${r} p50" }],
            [local.m, "RequestLatencyMs", "service", local.s, "route", r, { stat = "p95", label = "${r} p95" }],
            [local.m, "RequestLatencyMs", "service", local.s, "route", r, { stat = "p99", label = "${r} p99" }],
          ]])
        }
      },
      {
        type = "metric", x = 12, y = 2, width = 12, height = 6
        properties = {
          title = "API Gateway: requests, 4xx, 5xx, latency p95", view = "timeSeries", region = local.region, period = 60
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiName", aws_api_gateway_rest_api.api.name, "Stage", var.stage, { stat = "Sum" }],
            [".", "4XXError", ".", ".", ".", ".", { stat = "Sum" }],
            [".", "5XXError", ".", ".", ".", ".", { stat = "Sum" }],
            [".", "Latency", ".", ".", ".", ".", { stat = "p95", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 8, width = 8, height = 6
        properties = {
          title = "Fare cache hit rate (%)", view = "timeSeries", region = local.region, period = 60
          metrics = [
            [{ expression = "100 * (hit + stale + fallback) / (hit + stale + fallback + miss)", label = "hit rate %", id = "rate" }],
            [local.m, "CacheLookups", "service", local.s, "cache", "fares", "outcome", "HIT", { id = "hit", stat = "Sum", visible = false }],
            [".", ".", ".", ".", ".", ".", ".", "STALE", { id = "stale", stat = "Sum", visible = false }],
            [".", ".", ".", ".", ".", ".", ".", "STALE_FALLBACK", { id = "fallback", stat = "Sum", visible = false }],
            [".", ".", ".", ".", ".", ".", ".", "MISS", { id = "miss", stat = "Sum", visible = false }],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 8, width = 8, height = 6
        properties = {
          title = "Legacy host: calls, retries, faults, timeouts", view = "timeSeries", region = local.region, period = 60, stat = "Sum"
          metrics = [
            [local.m, "LegacyCalls", "service", local.s, "operation", "GetFareQuote"],
            ["...", "GetSeatMap"],
            ["...", "HoldSeat"],
            ["...", "IssueTicket"],
            [local.m, "LegacyFaults", "service", local.s],
            [local.m, "LegacyTimeouts", "service", local.s],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 8, width = 8, height = 6
        properties = {
          title = "Circuit breaker", view = "timeSeries", region = local.region, period = 60, stat = "Sum"
          metrics = [
            [local.m, "CircuitOpenRejections", "service", local.s, { label = "calls rejected (open)" }],
            [local.m, "CircuitBreakerTransitions", "service", local.s, "to", "open"],
            ["...", "half-open"],
            ["...", "closed"],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 14, width = 8, height = 6
        properties = {
          title = "Throttled (429) per API key", view = "timeSeries", region = local.region, period = 60, stat = "Sum"
          metrics = [for k, v in aws_api_gateway_api_key.partner : [local.m, "Throttled429", "apiKeyId", v.id, { label = k }]]
        }
      },
      {
        type = "metric", x = 8, y = 14, width = 8, height = 6
        properties = {
          title = "Ticketing workflow", view = "timeSeries", region = local.region, period = 300, stat = "Sum"
          metrics = [
            ["AWS/States", "ExecutionsSucceeded", "StateMachineArn", aws_sfn_state_machine.ticketing.arn],
            [".", "ExecutionsFailed", ".", "."],
            [local.m, "TicketCompensations", "service", local.s],
            ["AWS/States", "ExecutionTime", "StateMachineArn", aws_sfn_state_machine.ticketing.arn, { stat = "p95", yAxis = "right", label = "p95 job time (ms)" }],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 14, width = 8, height = 6
        properties = {
          title = "Strangler fig: shadow mismatch rate (%)", view = "timeSeries", region = local.region, period = 300
          metrics = [
            [{ expression = "IF(c > 0, 100 * m / c, 0)", label = "mismatch %", id = "rate" }],
            [local.m, "FareShadowCompared", "service", local.s, { id = "c", stat = "Sum", visible = false }],
            [local.m, "FareShadowMismatch", "service", local.s, { id = "m", stat = "Sum", visible = false }],
          ]
        }
      },
    ]
  }
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${local.name}-gateway"
  dashboard_body = jsonencode(local.dashboard)
}
