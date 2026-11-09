# One Lambda function: zip of dist/<name>, its own role (logs + X-Ray + the
# policy passed in), a log group with retention, active tracing, arm64.

variable "name" { type = string }
variable "source_dir" { type = string }
variable "handler" {
  type    = string
  default = "index.handler"
}
variable "timeout" {
  type    = number
  default = 10
}
variable "memory" {
  type    = number
  default = 512
}
variable "environment" {
  type    = map(string)
  default = {}
}
variable "policy_json" {
  description = "Extra IAM policy for this function (least privilege)"
  type        = string
  default     = null
}
variable "reserved_concurrency" {
  type    = number
  default = -1
}
variable "publish" {
  type    = bool
  default = false
}
variable "log_retention_days" {
  type    = number
  default = 7
}


data "archive_file" "zip" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.root}/.build/${var.name}.zip"
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = var.name
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "base" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
  statement {
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "base" {
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.base.json
}

resource "aws_iam_role_policy" "extra" {
  count  = var.policy_json == null ? 0 : 1
  role   = aws_iam_role.this.id
  policy = var.policy_json
}

resource "aws_lambda_function" "this" {
  function_name                  = var.name
  role                           = aws_iam_role.this.arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = var.handler
  filename                       = data.archive_file.zip.output_path
  source_code_hash               = data.archive_file.zip.output_base64sha256
  timeout                        = var.timeout
  memory_size                    = var.memory
  publish                        = var.publish
  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = merge({ NODE_OPTIONS = "--enable-source-maps" }, var.environment)
  }
  tracing_config {
    mode = "Active"
  }
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.this.name
  }

  depends_on = [aws_iam_role_policy.base]
}

output "function_name" { value = aws_lambda_function.this.function_name }
output "arn" { value = aws_lambda_function.this.arn }
output "invoke_arn" { value = aws_lambda_function.this.invoke_arn }
output "version" { value = aws_lambda_function.this.version }
output "role_name" { value = aws_iam_role.this.name }
