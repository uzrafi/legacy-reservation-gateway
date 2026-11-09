terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
    tls     = { source = "hashicorp/tls", version = "~> 4.0" }
  }
  # Partial config: terraform init -backend-config=backend.hcl (see infra/bootstrap outputs).
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "legacy-reservation-gateway", stage = var.stage, managed_by = "terraform" }
  }
}

data "aws_caller_identity" "me" {}
data "aws_region" "current" {}

locals {
  name    = "lrg-${var.stage}"
  account = data.aws_caller_identity.me.account_id
  region  = data.aws_region.current.region
  service = "reservation-gateway"
  metrics = "ReservationGateway"
}
