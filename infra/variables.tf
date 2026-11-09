variable "region" {
  type    = string
  default = "ca-central-1"
}

variable "stage" {
  type    = string
  default = "dev"
}

variable "log_retention_days" {
  type    = number
  default = 7
}

variable "alarm_email" {
  description = "Optional e-mail subscribed to the alarm topic"
  type        = string
  default     = ""
}

variable "allow_experiment_headers" {
  description = "Let load tests pick experiment arms with the x-experiment header. Demo stages only."
  type        = bool
  default     = true
}

variable "fare_mode_baseline" {
  description = "FARE_MODE of the version Terraform publishes (legacy | shadow | modern). Canary shifts are done by scripts/canary.ts."
  type        = string
  default     = "legacy"
}

variable "modern_fare_rules" {
  type    = string
  default = "full"
}

variable "bulkhead_concurrency" {
  description = <<-EOT
    Reserved concurrency for the Lambdas that call the legacy host (the bulkhead), e.g.
    { fares = 3, seatmaps = 2, holds = 1, ticket_worker = 2 }. Null = unreserved.
    New AWS accounts often have an account limit of 10 concurrent executions, which
    leaves no room to reserve; request an increase (Service Quotas) first.
  EOT
  type        = map(number)
  default     = null
}

variable "legacy_faults" {
  description = "Default fault injection of the simulated legacy host (override at runtime via /admin/faults)."
  type = object({
    latency_min_ms = number
    latency_max_ms = number
    error_rate     = number
    hang_rate      = number
    hang_ms        = number
    rate_limit_rps = number
    ticket_min_ms  = number
    ticket_max_ms  = number
    refile_rate    = number
  })
  default = {
    latency_min_ms = 600
    latency_max_ms = 1500
    error_rate     = 0
    hang_rate      = 0.01
    hang_ms        = 10000
    rate_limit_rps = 5
    ticket_min_ms  = 5000
    ticket_max_ms  = 20000
    refile_rate    = 0.0005
  }
}

variable "usage_plans" {
  type = map(object({ rate = number, burst = number, quota_per_day = number }))
  default = {
    "partner-basic"   = { rate = 10, burst = 20, quota_per_day = 10000 }
    "partner-premium" = { rate = 50, burst = 100, quota_per_day = 100000 }
  }
}
