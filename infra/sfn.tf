# Ticketing workflow (Standard: exactly-once execution names, long-running, full history).

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${local.name}-ticketing-sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "sfn" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [module.ticket_worker.arn, "${module.ticket_worker.arn}:*"]
  }
  statement {
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"]
    resources = ["*"]
  }
  statement {
    # Required by Step Functions for vended logs delivery.
    actions = [
      "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "sfn" {
  role   = aws_iam_role.sfn.id
  policy = data.aws_iam_policy_document.sfn.json
}

resource "aws_cloudwatch_log_group" "sfn" {
  name              = "/aws/vendedlogs/states/${local.name}-ticketing"
  retention_in_days = var.log_retention_days
}

resource "aws_sfn_state_machine" "ticketing" {
  name     = "${local.name}-ticketing"
  type     = "STANDARD"
  role_arn = aws_iam_role.sfn.arn
  definition = templatefile("${path.module}/sfn/ticketing.asl.json", {
    ticket_worker_arn = module.ticket_worker.arn
  })

  logging_configuration {
    level                  = "ERROR"
    include_execution_data = false
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
  }
  tracing_configuration {
    enabled = true
  }
  depends_on = [aws_iam_role_policy.sfn]
}
