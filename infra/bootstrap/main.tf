# One-time bootstrap, applied by hand with local state:
#   - S3 bucket for Terraform state (S3-native locking, no DynamoDB lock table)
#   - GitHub Actions OIDC provider + two roles (plan for PRs, deploy for main)
#   - a $5 AWS Budget alert
#
#   cd infra/bootstrap && terraform init && terraform apply -var budget_email=you@example.com

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "region" {
  type    = string
  default = "ca-central-1"
}

variable "github_repo" {
  description = "owner/name of the GitHub repository allowed to assume the CI roles"
  type        = string
  default     = "uzrafi/legacy-reservation-gateway"
}

variable "budget_email" {
  description = "Where the $5 budget alert goes"
  type        = string
}

variable "create_oidc_provider" {
  description = "Set false if the account already has the token.actions.githubusercontent.com provider"
  type        = bool
  default     = true
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "legacy-reservation-gateway", managed_by = "terraform-bootstrap" }
  }
}

data "aws_caller_identity" "me" {}

locals {
  account = data.aws_caller_identity.me.account_id
}

# ---------------------------------------------------------------- state bucket
resource "aws_s3_bucket" "state" {
  bucket = "lrg-tfstate-${local.account}"
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------- GitHub OIDC
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

data "aws_iam_policy_document" "trust_main" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only workflows running on main may deploy.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

data "aws_iam_policy_document" "trust_any_ref" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

# Plan role: read-only on the account, read/write on the state bucket (plan refreshes state).
resource "aws_iam_role" "plan" {
  name               = "lrg-github-plan"
  assume_role_policy = data.aws_iam_policy_document.trust_any_ref.json
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "state_rw" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/*"]
  }
}

resource "aws_iam_role_policy" "plan_state" {
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.state_rw.json
}

# Deploy role: what `terraform apply` of infra/ needs, scoped to lrg-* names where AWS allows it.
data "aws_iam_policy_document" "deploy" {
  statement {
    sid = "ScopedByName"
    actions = [
      "lambda:*",
      "dynamodb:*",
      "states:*",
      "sns:*",
      "events:*",
      "logs:*",
      "ssm:*",
    ]
    resources = [
      "arn:aws:lambda:${var.region}:${local.account}:function:lrg-*",
      "arn:aws:dynamodb:${var.region}:${local.account}:table/lrg-*",
      "arn:aws:states:${var.region}:${local.account}:stateMachine:lrg-*",
      "arn:aws:states:${var.region}:${local.account}:execution:lrg-*",
      "arn:aws:sns:${var.region}:${local.account}:lrg-*",
      "arn:aws:events:${var.region}:${local.account}:rule/lrg-*",
      "arn:aws:logs:${var.region}:${local.account}:log-group:*",
      "arn:aws:ssm:${var.region}:${local.account}:parameter/lrg/*",
    ]
  }
  statement {
    sid       = "Buckets"
    actions   = ["s3:*"]
    resources = ["arn:aws:s3:::lrg-*", "arn:aws:s3:::lrg-*/*"]
  }
  statement {
    sid = "Roles"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:TagRole", "iam:UntagRole",
      "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies",
      "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
      "iam:UpdateAssumeRolePolicy", "iam:PassRole",
    ]
    resources = ["arn:aws:iam::${local.account}:role/lrg-*"]
  }
  statement {
    sid = "Unscoped"
    # These APIs do not support resource-level permissions (or the names are AWS-generated).
    actions = [
      "apigateway:*",
      "cloudwatch:*",
      "xray:*",
      "lambda:GetAccountSettings", "lambda:ListFunctions", "lambda:CreateEventSourceMapping",
      "logs:DescribeLogGroups", "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies",
      "ssm:DescribeParameters",
      "sts:GetCallerIdentity",
      "kms:Decrypt",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "lrg-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.trust_main.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "deploy" {
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

resource "aws_iam_role_policy" "deploy_state" {
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.state_rw.json
}

# ---------------------------------------------------------------- budget
resource "aws_budgets_budget" "monthly" {
  name         = "lrg-monthly-5usd"
  budget_type  = "COST"
  limit_amount = "5"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}
output "plan_role_arn" {
  value = aws_iam_role.plan.arn
}
output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}
output "backend_hcl" {
  description = "Save as infra/backend.hcl, then: terraform -chdir=infra init -backend-config=backend.hcl"
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.state.bucket}"
    key          = "lrg/dev.tfstate"
    region       = "${var.region}"
    use_lockfile = true
  EOT
}
